//! Opt-in debug-app check for pull requests (FR-49..FR-51). Set TESSERA_PR_SMOKE_ROOT to a disposable
//! directory; writes pr-smoke.json there. Uses a throwaway git repo whose origin is rewritten to a local
//! bare repo (`url.insteadOf`) and an in-process mock GitHub API — never a real account, `gh` or keychain.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

pub fn start(app: &tauri::AppHandle) {
    let Some(root) = std::env::var_os("TESSERA_PR_SMOKE_ROOT").map(PathBuf::from) else {
        return;
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let report = match run(&handle, &root).await {
            Ok(value) => value,
            Err(error) => serde_json::json!({"ok": false, "error": error}),
        };
        let path = root.join("pr-smoke.json");
        if let Err(error) = std::fs::write(&path, report.to_string()) {
            tracing::error!(%error, "could not write pr smoke result");
        }
        tracing::info!(%report, "pr smoke finished");
    });
}

fn git(dir: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "smoke")
        .env("GIT_AUTHOR_EMAIL", "smoke@t")
        .env("GIT_COMMITTER_NAME", "smoke")
        .env("GIT_COMMITTER_EMAIL", "smoke@t")
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("git {args:?}: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

/// Canned GitHub API: find→none, create→201, get→open PR, checks→empty.
fn mock_github() -> (String, std::sync::mpsc::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let pr = r#"{"number":1,"title":"Smoke PR","state":"open","draft":false,"merged":false,"merged_at":null,"html_url":"https://github.com/o/r/pull/1","head":{"sha":"abc123"},"mergeable":true,"mergeable_state":"clean"}"#;
        for _ in 0..8 {
            let Ok((stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                request.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let (status, body) = if request.starts_with("POST /repos/o/r/pulls") {
                (201, pr.to_owned())
            } else if request.starts_with("GET /repos/o/r/pulls?") {
                (200, "[]".to_owned())
            } else if request.contains("/pulls/1") {
                (200, pr.to_owned())
            } else if request.contains("check-runs") {
                (200, r#"{"total_count":0,"check_runs":[]}"#.to_owned())
            } else if request.contains("/status") {
                (200, r#"{"state":"pending","statuses":[]}"#.to_owned())
            } else {
                (404, r#"{"message":"not found"}"#.to_owned())
            };
            let mut stream = stream;
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\nx-ratelimit-remaining: 4000\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = tx.send(());
        }
    });
    (format!("http://127.0.0.1:{port}"), rx)
}

async fn run(app: &tauri::AppHandle, root: &Path) -> Result<serde_json::Value, String> {
    use crate::pr_commands as pr;
    let tmp = root.join("repo");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    // Main repo + bare "GitHub" remote + task worktree.
    git(&tmp, &["init", "-b", "main"]).map_err(|e| format!("init: {e}"))?;
    std::fs::write(tmp.join("file.txt"), "one\n").map_err(|e| e.to_string())?;
    git(&tmp, &["add", "."]).map_err(|e| e.to_string())?;
    git(&tmp, &["commit", "-m", "init"]).map_err(|e| e.to_string())?;
    let bare = root.join("origin.git");
    git(&tmp, &["init", "--bare", bare.to_str().unwrap()]).map_err(|e| format!("bare: {e}"))?;
    // Push to the bare repo while the recorded remote URL stays github.com.
    let bare_url = format!("file://{}", bare.display());
    git(&tmp, &["remote", "add", "origin", "https://github.com/o/r.git"]).map_err(|e| e.to_string())?;
    git(
        &tmp,
        &[
            "config",
            &format!("url.{bare_url}.insteadOf"),
            "https://github.com/o/r.git",
        ],
    )
    .map_err(|e| e.to_string())?;
    let wt = root.join("worktree");
    git(
        &tmp,
        &["worktree", "add", "-b", "smoke-task", wt.to_str().unwrap(), "main"],
    )
    .map_err(|e| format!("worktree: {e}"))?;
    std::fs::write(wt.join("task.txt"), "task\n").map_err(|e| e.to_string())?;
    git(&wt, &["add", "."]).map_err(|e| e.to_string())?;
    git(&wt, &["commit", "-m", "task"]).map_err(|e| e.to_string())?;

    // Mock GitHub API + token via the debug env hooks.
    let (api, _requests) = mock_github();
    // Debug-only smoke: the process is single-purpose, so setting env here is safe.
    unsafe {
        std::env::set_var("TESSERA_GITHUB_API", &api);
        std::env::set_var("TESSERA_GITHUB_TOKEN", "smoke-token");
    }

    // Store rows: project pointing at the throwaway checkout, task on the worktree branch.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64 * 1000;
    let ids = {
        let state = app.state::<crate::state::AppState>();
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        let project_id = "pr-smoke-project".to_string();
        let task_id = "pr-smoke-task".to_string();
        store
            .projects()
            .insert(&tessera_store::repositories::Project {
                id: project_id.clone(),
                name: "PR smoke".into(),
                path: tmp.to_string_lossy().into_owned(),
                remote_url: Some("https://github.com/o/r.git".into()),
                default_branch: "main".into(),
                worktree_dir: None,
                setup_script: None,
                setup_shell: None,
                setup_approved_hash: None,
                copy_files: None,
                port_base: None,
                default_profile_id: None,
                is_muted: None,
                sort: None,
                ssh_host_id: None,
                created_at: Some(now),
                updated_at: Some(now),
            })
            .map_err(|e| format!("project: {e}"))?;
        store
            .tasks()
            .insert(&tessera_store::repositories::Task {
                id: task_id.clone(),
                project_id: Some(project_id.clone()),
                group_id: None,
                name: "Smoke task".into(),
                slug: "smoke-task".into(),
                branch: "smoke-task".into(),
                base_branch: "main".into(),
                worktree_path: Some(wt.to_string_lossy().into_owned()),
                uses_main_checkout: None,
                board_column: None,
                state: Some("active".into()),
                prompt: Some("smoke".into()),
                issue_ref: None,
                port_start: None,
                port_count: Some(0),
                pr_number: None,
                pr_url: None,
                pr_state: None,
                ci_state: None,
                last_message: None,
                tags: None,
                created_at: Some(now),
                updated_at: Some(now),
                archived_at: None,
            })
            .map_err(|e| format!("task: {e}"))?;
        (project_id, task_id)
    };

    let created = pr::pr_create(app.clone(), ids.1.clone(), "Smoke PR".into(), "body".into(), false)
        .await
        .map_err(|e| format!("pr_create: {e:?}"))?;
    let refreshed = pr::pr_refresh(app.clone(), ids.1.clone())
        .await
        .map_err(|e| format!("pr_refresh: {e:?}"))?;
    let checks = pr::pr_checks(app.clone(), ids.1.clone())
        .await
        .map_err(|e| format!("pr_checks: {e:?}"))?;

    // Cleanup records; the throwaway files stay under the disposable root.
    {
        let state = app.state::<crate::state::AppState>();
        if let Ok(store) = state.store.lock() {
            let _ = store.tasks().delete(&ids.1);
            let _ = store.projects().delete(&ids.0);
        }
    }
    Ok(serde_json::json!({
        "ok": true,
        "created": {"number": created.number, "state": created.state, "url": created.url},
        "refreshed": {"number": refreshed.number, "state": refreshed.state, "ci_state": refreshed.ci_state},
        "checks": checks.len(),
        "pushed_to": bare_url,
    }))
}
