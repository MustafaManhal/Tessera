//! Pull request, CI and merge commands (FR-49..FR-51). GitHub traffic goes through `tessera-forge` with the
//! keychain token from the integrations row; push and local merge run plain git (user credentials, ssh hosts
//! included via `remote://` paths).

use crate::error::AppError;
use crate::issue_commands::github_token;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tessera_forge::issues::parse_github_remote;
use tessera_forge::pulls::{self, CiState, MergeMethod, PullRequest};
use tessera_store::Store;
use tessera_store::repositories::{Project, Task};

/// ETag cache so the 60 s poll sends conditional requests (TRD §7 rate-limit row).
#[derive(Default)]
pub struct PrCache {
    inner: Mutex<HashMap<String, CacheEntry>>,
}
#[derive(Default, Clone)]
struct CacheEntry {
    pr_etag: Option<String>,
    info: Option<PrInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PrInfo {
    #[specta(type = specta_typescript::Number)]
    pub number: i64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub merged: bool,
    pub url: String,
    pub mergeable: Option<bool>,
    pub mergeable_state: Option<String>,
    pub ci_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CheckItem {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub duration_ms: Option<i64>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LocalMergeResult {
    pub merged: bool,
    pub conflicts: Vec<String>,
    pub branch: String,
}

fn api_base() -> String {
    std::env::var("TESSERA_GITHUB_API").unwrap_or_else(|_| "https://api.github.com".into())
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("pr.invalid", message.into())
}

fn not_connected() -> AppError {
    AppError::new("github.not_connected", "GitHub is not connected.")
}

/// `(task, project)` for a task id; both must exist.
fn load_task_project(store: &Store, task_id: &str) -> Result<(Task, Project), AppError> {
    let task = store
        .tasks()
        .get(task_id)?
        .ok_or_else(|| AppError::new("task.not_found", "The task could not be found."))?;
    let project = store
        .projects()
        .get(task.project_id.as_deref().unwrap_or(""))?
        .ok_or_else(|| invalid("The task has no project."))?;
    Ok((task, project))
}

/// `owner/repo` from the project's origin URL (https or ssh); falls back to `git remote get-url origin`.
fn github_repo(project: &Project) -> Result<(String, String), AppError> {
    if let Some(url) = project.remote_url.as_deref()
        && let Some(pair) = parse_github_remote(url)
    {
        return Ok(pair);
    }
    let out = tessera_git::run_with_timeout(
        Path::new(&project.path),
        ["remote", "get-url", "origin"],
        Duration::from_secs(15),
    )
    .map_err(|e| invalid(format!("Could not read the origin URL: {e}")))?;
    let url = String::from_utf8_lossy(&out).trim().to_owned();
    parse_github_remote(&url)
        .ok_or_else(|| invalid("This project's origin is not a GitHub remote; pull requests need github.com."))
}

fn pr_state(pr: &PullRequest) -> &'static str {
    if pr.merged {
        "merged"
    } else {
        match pr.state.as_str() {
            "closed" => "closed",
            "open" if pr.draft => "draft",
            _ => "open",
        }
    }
}

fn to_info(pr: &PullRequest, ci: Option<CiState>) -> PrInfo {
    PrInfo {
        number: pr.number,
        title: pr.title.clone(),
        state: pr_state(pr).into(),
        draft: pr.draft,
        merged: pr.merged,
        url: pr.html_url.clone(),
        mergeable: pr.mergeable,
        mergeable_state: pr.mergeable_state.clone(),
        ci_state: ci.map(|c| c.as_str().to_owned()),
    }
}

fn save_pr(store: &Store, task_id: &str, pr: Option<&PullRequest>, ci: Option<CiState>) -> Result<(), AppError> {
    let mut task = store
        .tasks()
        .get(task_id)?
        .ok_or_else(|| AppError::new("task.not_found", "The task could not be found."))?;
    task.pr_number = pr.map(|p| p.number);
    task.pr_url = pr.map(|p| p.html_url.clone());
    task.pr_state = pr.map(|p| pr_state(p).to_owned());
    task.ci_state = ci.map(|c| c.as_str().to_owned());
    store.tasks().update(&task)?;
    Ok(())
}

/// Push the branch, find-or-create the PR, store its fields. Returns the PR info.
#[tauri::command]
#[specta::specta]
pub async fn pr_create(
    app: tauri::AppHandle,
    task_id: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<PrInfo, AppError> {
    let (task, project) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        load_task_project(&store, &task_id)?
    };
    let worktree = PathBuf::from(task.worktree_path.clone().unwrap_or_else(|| project.path.clone()));
    let branch = task.branch.clone();
    if branch.is_empty() {
        return Err(invalid("The task has no branch to push."));
    }
    let body = with_fixes(&body, task.issue_ref.as_deref());
    // Push first: the PR needs the head on the remote. User git credentials apply.
    let push_branch = branch.clone();
    tauri::async_runtime::spawn_blocking(move || tessera_git::push::push_branch(&worktree, &push_branch))
        .await
        .map_err(|e| invalid(format!("The push worker failed: {e}")))?
        .map_err(|e| invalid(format!("git push failed: {e}")))?;

    let token = github_token(&app).map_err(|_| not_connected())?;
    let (owner, repo) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        github_repo(
            &store
                .projects()
                .get(task.project_id.as_deref().unwrap_or(""))?
                .unwrap_or(project.clone()),
        )?
    };
    let base = if task.base_branch.is_empty() {
        project.default_branch.clone()
    } else {
        task.base_branch.clone()
    };
    let head = format!("{owner}:{branch}");
    let base_api = api_base();
    // Find first so a retry does not open a duplicate.
    let existing = pulls::find_pr(&base_api, &token, &owner, &repo, &head).await;
    let pr = match existing {
        Ok(Some(pr)) => pr,
        _ => pulls::create_pr(&base_api, &token, &owner, &repo, &title, &body, &head, &base, draft)
            .await
            .map_err(|e| invalid(format!("Could not create the pull request: {e}")))?,
    };
    let ci = refresh_ci(&app, &task_id, &token, &owner, &repo, &pr).await;
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        save_pr(&store, &task_id, Some(&pr), ci)?;
    }
    let info = to_info(&pr, ci);
    if let Ok(mut cache) = app.state::<PrCache>().inner.lock() {
        cache.insert(
            task_id.clone(),
            CacheEntry {
                pr_etag: None,
                info: Some(info.clone()),
            },
        );
    }
    emit_task(&app, &task_id, &project.path);
    Ok(info)
}

/// Fetch PR state + checks (conditional GETs) and store the rollup.
#[tauri::command]
#[specta::specta]
pub async fn pr_refresh(app: tauri::AppHandle, task_id: String) -> Result<PrInfo, AppError> {
    let (task, project) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        load_task_project(&store, &task_id)?
    };
    let number = task
        .pr_number
        .ok_or_else(|| invalid("This task has no pull request yet."))?;
    let token = github_token(&app).map_err(|_| not_connected())?;
    let (owner, repo) = github_repo(&project)?;
    let base_api = api_base();
    let cached = app
        .state::<PrCache>()
        .inner
        .lock()
        .ok()
        .and_then(|c| c.get(&task_id).cloned());
    let (pr_opt, etag) = pulls::get_pr_etag(
        &base_api,
        &token,
        &owner,
        &repo,
        number,
        cached.as_ref().and_then(|c| c.pr_etag.as_deref()),
    )
    .await
    .map_err(|e| invalid(format!("Could not read the pull request: {e}")))?;
    let Some(pr) = pr_opt else {
        // 304: nothing changed; hand back the cached view.
        if let Some(info) = cached.and_then(|c| c.info) {
            return Ok(info);
        }
        return Err(invalid("The pull request could not be read."));
    };
    if let Ok(mut cache) = app.state::<PrCache>().inner.lock() {
        cache.insert(
            task_id.clone(),
            CacheEntry {
                pr_etag: etag,
                info: None,
            },
        );
    }
    let sha = pr.head_sha.clone().unwrap_or_else(|| task.branch.clone());
    let runs = pulls::check_runs(&base_api, &token, &owner, &repo, &sha).await;
    let statuses = pulls::commit_statuses(&base_api, &token, &owner, &repo, &sha).await;
    let ci = match (runs, statuses) {
        (Ok(r), Ok(s)) => Some(pulls::ci_state(&r, &s)),
        _ => None,
    };
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        save_pr(&store, &task_id, Some(&pr), ci)?;
    }
    let info = to_info(&pr, ci);
    if let Ok(mut cache) = app.state::<PrCache>().inner.lock() {
        let entry = cache.entry(task_id.clone()).or_default();
        entry.info = Some(info.clone());
    }
    emit_task(&app, &task_id, &project.path);
    Ok(info)
}

/// The S-09 checks list for the task's PR head.
#[tauri::command]
#[specta::specta]
pub async fn pr_checks(app: tauri::AppHandle, task_id: String) -> Result<Vec<CheckItem>, AppError> {
    let (task, project) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        load_task_project(&store, &task_id)?
    };
    task.pr_number
        .ok_or_else(|| invalid("This task has no pull request yet."))?;
    let token = github_token(&app).map_err(|_| not_connected())?;
    let (owner, repo) = github_repo(&project)?;
    let sha = task.branch.clone();
    let entries = pulls::checks(&api_base(), &token, &owner, &repo, &sha)
        .await
        .map_err(|e| invalid(format!("Could not read the checks: {e}")))?;
    Ok(entries
        .into_iter()
        .map(|e| CheckItem {
            name: e.name,
            status: e.status,
            conclusion: e.conclusion,
            duration_ms: e.duration_ms,
            url: e.url,
        })
        .collect())
}

/// Last 200 lines of the failing check's job log; the front end delivers it as a prompt.
#[tauri::command]
#[specta::specta]
pub async fn pr_failure_log(app: tauri::AppHandle, task_id: String) -> Result<String, AppError> {
    let (task, project) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        load_task_project(&store, &task_id)?
    };
    let token = github_token(&app).map_err(|_| not_connected())?;
    let (owner, repo) = github_repo(&project)?;
    let sha = task.branch.clone();
    let runs = pulls::check_runs(&api_base(), &token, &owner, &repo, &sha)
        .await
        .map_err(|e| invalid(format!("Could not read the checks: {e}")))?;
    let failing = runs
        .iter()
        .find(|r| {
            r.status == "completed"
                && matches!(
                    r.conclusion.as_deref(),
                    Some("failure" | "timed_out" | "action_required")
                )
        })
        .ok_or_else(|| invalid("No failing check run found."))?;
    pulls::job_log_tail(&api_base(), &token, &owner, &repo, failing, 200)
        .await
        .map_err(|e| invalid(format!("Could not read the job log: {e}")))
}

/// Merge the PR on GitHub (merge commit / squash / rebase).
#[tauri::command]
#[specta::specta]
pub async fn pr_merge(app: tauri::AppHandle, task_id: String, method: String) -> Result<PrInfo, AppError> {
    let (task, project) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        load_task_project(&store, &task_id)?
    };
    let number = task
        .pr_number
        .ok_or_else(|| invalid("This task has no pull request yet."))?;
    let token = github_token(&app).map_err(|_| not_connected())?;
    let (owner, repo) = github_repo(&project)?;
    let method = match method.as_str() {
        "squash" => MergeMethod::Squash,
        "rebase" => MergeMethod::Rebase,
        _ => MergeMethod::Merge,
    };
    let result = pulls::merge_pr(&api_base(), &token, &owner, &repo, number, method)
        .await
        .map_err(|e| invalid(format!("GitHub refused the merge: {e}")))?;
    if !result.merged {
        return Err(invalid(
            result
                .message
                .unwrap_or_else(|| "GitHub did not merge the pull request.".into()),
        ));
    }
    let pr = pulls::get_pr(&api_base(), &token, &owner, &repo, number)
        .await
        .unwrap_or(PullRequest {
            number,
            title: String::new(),
            state: "closed".into(),
            draft: false,
            merged: true,
            html_url: task.pr_url.clone().unwrap_or_default(),
            head_sha: None,
            mergeable: None,
            mergeable_state: None,
        });
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        save_pr(&store, &task_id, Some(&pr), Some(CiState::Success))?;
    }
    emit_task(&app, &task_id, &project.path);
    Ok(to_info(&pr, Some(CiState::Success)))
}

/// Merge the task branch into the base locally in the project's main checkout.
#[tauri::command]
#[specta::specta]
pub async fn pr_merge_local(app: tauri::AppHandle, task_id: String) -> Result<LocalMergeResult, AppError> {
    let (task, project) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        load_task_project(&store, &task_id)?
    };
    let base = if task.base_branch.is_empty() {
        project.default_branch.clone()
    } else {
        task.base_branch.clone()
    };
    let branch = task.branch.clone();
    let main = PathBuf::from(project.path.clone());
    tauri::async_runtime::spawn_blocking(move || tessera_git::push::merge_local(&main, &base, &branch))
        .await
        .map_err(|e| invalid(format!("The merge worker failed: {e}")))?
        .map(|m| LocalMergeResult {
            merged: m.merged,
            conflicts: m.conflicts,
            branch: m.branch,
        })
        .map_err(|e| invalid(format!("git merge failed: {e}")))
}

fn emit_task(app: &tauri::AppHandle, task_id: &str, project_path: &str) {
    let state = app.state::<AppState>();
    if let Ok(store) = state.store.lock()
        && let Ok(Some(task)) = store.tasks().get(task_id)
    {
        crate::task_commands::emit(app, &task, Some(std::path::Path::new(project_path)));
    }
}

/// CI rollup for refresh: check runs + commit statuses on the PR head sha.
async fn refresh_ci(
    app: &tauri::AppHandle,
    _task_id: &str,
    token: &str,
    owner: &str,
    repo: &str,
    pr: &PullRequest,
) -> Option<CiState> {
    let sha = pr.head_sha.clone()?;
    let base = api_base();
    let runs = pulls::check_runs(&base, token, owner, repo, &sha).await;
    let statuses = pulls::commit_statuses(&base, token, owner, repo, &sha).await;
    match (runs, statuses) {
        (Ok(r), Ok(s)) => Some(pulls::ci_state(&r, &s)),
        _ => {
            let _ = app;
            None
        }
    }
}

/// Adds "Fixes #12" (GitHub) or "Fixes ENG-42" (Linear) for the issue the task came from, unless the text has it.
fn with_fixes(body: &str, issue_ref: Option<&str>) -> String {
    let Some(key) = issue_ref
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|v| v.get("key").and_then(|k| k.as_str()).map(str::to_owned))
        .filter(|k| !k.is_empty())
    else {
        return body.to_owned();
    };
    let line = format!("Fixes {key}");
    if body.contains(&line) {
        return body.to_owned();
    }
    if body.trim().is_empty() {
        return line;
    }
    format!("{}\n\n{line}", body.trim_end())
}

#[cfg(test)]
mod tests {
    #[test]
    fn fixes_line_is_added_once_for_a_linked_issue() {
        let github = Some(r##"{"provider":"github","key":"#12","number":12}"##);
        assert_eq!(super::with_fixes("Body", github), "Body\n\nFixes #12");
        assert_eq!(super::with_fixes("Body\n\nFixes #12", github), "Body\n\nFixes #12");
        assert_eq!(super::with_fixes("  ", github), "Fixes #12");
        assert_eq!(
            super::with_fixes("Body", Some(r#"{"key":"ENG-42"}"#)),
            "Body\n\nFixes ENG-42"
        );
        assert_eq!(super::with_fixes("Body", None), "Body");
        assert_eq!(super::with_fixes("Body", Some("not json")), "Body");
    }

    use super::*;

    #[test]
    fn pr_state_names() {
        let pr = |state: &str, draft: bool, merged: bool| PullRequest {
            number: 1,
            title: "t".into(),
            state: state.into(),
            draft,
            merged,
            html_url: "u".into(),
            head_sha: None,
            mergeable: None,
            mergeable_state: None,
        };
        assert_eq!(pr_state(&pr("open", false, false)), "open");
        assert_eq!(pr_state(&pr("open", true, false)), "draft");
        assert_eq!(pr_state(&pr("closed", false, true)), "merged");
        assert_eq!(pr_state(&pr("closed", false, false)), "closed");
    }
}
