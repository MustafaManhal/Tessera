//! Opt-in debug-app integration check. TESSERA_BACKEND_SMOKE_ROOT must name a disposable
//! committed git fixture (branch main). Writes smoke-result.json there and removes its
//! project/task records. Never runs without that explicit environment variable.
use crate::{project_commands as p, project_types::*, task_commands as t};
use std::{
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{Listener, Manager};

/// Start the explicitly requested debug-app backend smoke test.
pub fn start(app: &tauri::AppHandle) {
    let Some(root) = std::env::var_os("TESSERA_BACKEND_SMOKE_ROOT").map(PathBuf::from) else {
        return;
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run(&handle, &root).await;
        let report = match result {
            Ok(()) => serde_json::json!({"ok":true}),
            Err(error) => serde_json::json!({"ok":false,"error":error}),
        };
        if let Err(error) = std::fs::write(root.join("smoke-result.tmp"), report.to_string())
            .and_then(|_| std::fs::rename(root.join("smoke-result.tmp"), root.join("smoke-result.json")))
        {
            tracing::error!(%error,"could not write backend smoke result");
        }
        tracing::info!(%report,"backend app smoke finished");
    });
}
fn check(condition: bool, message: &str) -> Result<(), String> {
    if condition { Ok(()) } else { Err(message.into()) }
}
async fn run(app: &tauri::AppHandle, root: &std::path::Path) -> Result<(), String> {
    let repo = root.join("repo");
    let project = p::project_add(
        app.clone(),
        ProjectInput {
            path: Some(repo.to_string_lossy().into_owned()),
            clone_url: None,
            clone_dir: None,
            name: Some("Task 09 smoke fixture".into()),
        },
    )
    .await
    .map_err(|e| format!("add: {e:?}"))?;
    let project_id = project.id.clone();
    let result = exercise(app, root, project).await;
    // On a failed check retain worktrees for diagnosis; records are still removed without touching files.
    let cleanup = p::project_remove(app.clone(), project_id)
        .await
        .map_err(|e| format!("remove: {e:?}"));
    result?;
    cleanup?;
    Ok(())
}
async fn exercise(app: &tauri::AppHandle, root: &std::path::Path, project: Project) -> Result<(), String> {
    let patch: ProjectPatch =
        serde_json::from_value(serde_json::json!({"worktree_dir":root.join("worktrees"),"port_base":20000}))
            .map_err(|e| e.to_string())?;
    p::project_update(app.clone(), project.id.clone(), patch)
        .await
        .map_err(|e| format!("update: {e:?}"))?;
    let script = p::run_script_add(
        app.clone(),
        project.id.clone(),
        RunScriptInput {
            name: "dev".into(),
            command: "echo fixture".into(),
            auto_start: false,
            sort: Some(2),
        },
    )
    .await
    .map_err(|e| format!("script add: {e:?}"))?;
    check(
        p::run_script_list(app.clone(), project.id.clone())
            .await
            .map_err(|e| format!("scripts: {e:?}"))?
            .len()
            == 1,
        "script list mismatch",
    )?;
    p::run_script_update(
        app.clone(),
        script.id.clone(),
        RunScriptPatch {
            name: None,
            command: None,
            auto_start: Some(true),
            sort: None,
        },
    )
    .await
    .map_err(|e| format!("script update: {e:?}"))?;
    p::run_script_remove(app.clone(), script.id)
        .await
        .map_err(|e| format!("script remove: {e:?}"))?;
    let (tx, rx) = mpsc::channel();
    let listener = app.listen("task:changed", move |event| {
        let _ = tx.send(event.payload().to_owned());
    });
    let created = t::task_create(
        app.clone(),
        TaskCreateInput {
            project_id: project.id.clone(),
            name: Some("smoke".into()),
            prompt: Some("fixture prompt".into()),
            base_branch: "main".into(),
            existing_branch: None,
            agents: vec![],
            use_main_checkout: false,
            run_setup: false,
        },
    )
    .await
    .map_err(|e| format!("create: {e:?}"))?;
    let task = created.tasks.first().ok_or("missing task")?;
    let path = task.worktree_path.as_deref().ok_or("missing worktree")?;
    check(rx.try_iter().count() >= 3, "missing lifecycle events")?;
    std::fs::write(std::path::Path::new(path).join("changed.txt"), "fixture\n").map_err(|e| e.to_string())?;
    let task_id = task.id.clone();
    let observed = tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let Ok(payload) = rx.recv_timeout(remaining) else {
                return false;
            };
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload)
                && value["task_id"].as_str() == Some(&task_id)
                && value["summary"]["changed_files"].as_u64().is_some_and(|n| n > 0)
            {
                return true;
            }
        }
        false
    })
    .await
    .map_err(|e| e.to_string())?;
    app.unlisten(listener);
    check(observed, "missing debounced worktree event")?;
    let dirty = t::task_delete(app.clone(), task.id.clone(), false).await;
    check(
        dirty.as_ref().err().is_some_and(|e| e.dirty == Some(true)),
        "dirty delete was not refused",
    )?;
    t::task_archive(app.clone(), task.id.clone())
        .await
        .map_err(|e| format!("archive: {e:?}"))?;
    t::task_restore(app.clone(), task.id.clone())
        .await
        .map_err(|e| format!("restore: {e:?}"))?;
    let rows = t::task_list(app.clone(), Some(project.id.clone()), false)
        .await
        .map_err(|e| format!("list: {e:?}"))?;
    check(
        rows.len() == 1 && rows[0].changed_files.is_some_and(|n| n > 0),
        "summary mismatch",
    )?;
    t::task_ports(app.clone(), task.id.clone())
        .await
        .map_err(|e| format!("ports: {e:?}"))?;
    t::task_delete(app.clone(), task.id.clone(), true)
        .await
        .map_err(|e| format!("delete: {e:?}"))?;
    check(
        !std::path::Path::new(path).exists(),
        "worktree retained after confirmed delete",
    )?;
    // Ensure no fixture record remains before the project cleanup.
    let state = app.state::<crate::state::AppState>();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    check(
        store.task_get(&task.id).map_err(|e| e.to_string())?.state.as_deref() == Some("deleted"),
        "missing deleted state",
    )
}
