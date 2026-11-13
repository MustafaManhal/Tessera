//! Review IPC. Resolve task paths under the store lock, then release it before Git/SSH work.
use crate::{error::AppError, state::AppState};
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use tauri::Manager;
#[derive(Debug, Clone, Serialize, Type)]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    #[specta(type = specta_typescript::Number)]
    pub added: u64,
    #[specta(type = specta_typescript::Number)]
    pub removed: u64,
    pub is_binary: bool,
}
#[derive(Debug, Clone, Serialize, Type)]
pub struct FileDiff {
    pub base_text: Option<String>,
    pub head_text: Option<String>,
    pub too_large: bool,
    pub binary: bool,
    pub conflict: bool,
}
fn context(app: &tauri::AppHandle, id: &str) -> Result<(PathBuf, String), AppError> {
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let task = store.task_get(id)?;
    let root = if let Some(path) = task.worktree_path {
        path
    } else if task.uses_main_checkout == Some(1) {
        store
            .projects()
            .get(task.project_id.as_deref().unwrap_or_default())?
            .ok_or_else(|| AppError::new("task.not_found", "The project could not be found."))?
            .path
    } else {
        return Err(AppError::new("task.not_found", "The task has no checkout."));
    };
    Ok((root.into(), task.base_branch))
}
#[tauri::command]
#[specta::specta]
pub async fn review_files(app: tauri::AppHandle, task_id: String) -> Result<Vec<ChangedFile>, AppError> {
    let (root, base) = context(&app, &task_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        tessera_git::review_files(&root, &base)
            .map(|files| {
                files
                    .into_iter()
                    .map(|f| ChangedFile {
                        path: f.path,
                        old_path: f.old_path,
                        status: f.status,
                        added: f.added,
                        removed: f.removed,
                        is_binary: f.is_binary,
                    })
                    .collect()
            })
            .map_err(AppError::from)
    })
    .await
    .map_err(|_| AppError::new("review.failed", "The review worker failed."))?
}
#[tauri::command]
#[specta::specta]
pub async fn review_file_diff(app: tauri::AppHandle, task_id: String, path: String) -> Result<FileDiff, AppError> {
    let (root, base) = context(&app, &task_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        tessera_git::review_file_diff(&root, &base, &path)
            .map(|d| FileDiff {
                base_text: d.base_text,
                head_text: d.head_text,
                too_large: d.too_large,
                binary: d.binary,
                conflict: d.conflict,
            })
            .map_err(AppError::from)
    })
    .await
    .map_err(|_| AppError::new("review.failed", "The review worker failed."))?
}

#[cfg(debug_assertions)]
pub(crate) fn start_smoke(app: &tauri::AppHandle) {
    if std::env::var_os("TESSERA_REVIEW_SMOKE").is_none() || std::env::var_os("TESSERA_BENCH_ROOT").is_none() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), AppError> {
            let dirs = app.state::<AppState>().dirs.clone();
            let repo = dirs.root.join("review-fixture");
            std::fs::create_dir_all(&repo).map_err(|e| AppError::new("review.fixture", e.to_string()))?;
            if !repo.join(".git").exists() {
                for args in [
                    vec!["init", "-b", "main"],
                    vec!["config", "user.name", "Fixture"],
                    vec!["config", "user.email", "fixture@example.invalid"],
                ] {
                    tessera_git::run_with_timeout(&repo, args, std::time::Duration::from_secs(10))?;
                }
                std::fs::write(repo.join("example.ts"), "export const value = 1;\n")
                    .map_err(|e| AppError::new("review.fixture", e.to_string()))?;
                tessera_git::run_with_timeout(&repo, ["add", "."], std::time::Duration::from_secs(10))?;
                tessera_git::run_with_timeout(&repo, ["commit", "-m", "fixture"], std::time::Duration::from_secs(10))?;
            }
            let store = tessera_store::Store::open(&dirs)?;
            let project = match store
                .projects()
                .list()?
                .into_iter()
                .find(|p| std::fs::canonicalize(&p.path).ok() == std::fs::canonicalize(&repo).ok())
            {
                Some(p) => p,
                None => store.project_add_local(&repo, &dirs.root)?,
            };
            let task = match store
                .tasks()
                .list()?
                .into_iter()
                .find(|t| t.project_id.as_deref() == Some(project.id.as_str()) && t.name == "Native review")
            {
                Some(t) => t,
                None => store.task_create_record(
                    tessera_store::tasks::CreateTask {
                        project_id: project.id,
                        name: Some("Native review".into()),
                        prompt: None,
                        base_branch: "main".into(),
                        existing_branch: None,
                        branch_name: None,
                        use_main_checkout: false,
                        run_setup: false,
                    },
                    |_| {},
                )?,
            };
            std::fs::write(
                std::path::Path::new(task.worktree_path.as_deref().unwrap()).join("example.ts"),
                "export const value = 2;\n",
            )
            .map_err(|e| AppError::new("review.fixture", e.to_string()))?;
            std::thread::sleep(std::time::Duration::from_secs(5));
            let script = format!(
                "import('/src/review/nativeSmoke.ts').then(m=>m.run({}));",
                serde_json::to_string(&task.id).unwrap()
            );
            if let Some(window) = app.get_webview_window("main") {
                window
                    .eval(&script)
                    .map_err(|e| AppError::new("review.fixture", e.to_string()))?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            tracing::error!(?error, "review smoke failed");
        }
    });
}
#[cfg(debug_assertions)]
#[tauri::command]
fn review_smoke_result(result: serde_json::Value) -> Result<(), String> {
    if std::env::var_os("TESSERA_REVIEW_SMOKE").is_none() || std::env::var_os("TESSERA_BENCH_ROOT").is_none() {
        return Err("Disabled".into());
    }
    let root = std::path::PathBuf::from(std::env::var_os("TESSERA_SHOTS_DIR").ok_or("Missing shots directory")?);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    std::fs::write(
        root.join("review-native.json"),
        serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
#[cfg(debug_assertions)]
pub(crate) fn handle_smoke(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![review_smoke_result]);
    handler(invoke)
}

impl From<tessera_store::review_comments::CommentError> for AppError {
    fn from(error: tessera_store::review_comments::CommentError) -> Self {
        use tessera_store::review_comments::CommentError;
        let code = match &error {
            CommentError::Invalid(_) => "review.invalid_comment",
            CommentError::NotFound => "review.comment_not_found",
            _ => "review.failed",
        };
        Self::new(code, error.to_string())
    }
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, Type)]
pub struct ReviewComment {
    pub id: String,
    pub task_id: String,
    pub file_path: String,
    pub side: String,
    #[specta(type = specta_typescript::Number)]
    pub line_start: i64,
    #[specta(type = specta_typescript::Number)]
    pub line_end: i64,
    pub code_excerpt: String,
    pub body: String,
    #[specta(type = Option<specta_typescript::Number>)]
    pub sent_at: Option<i64>,
    pub resolved: bool,
    #[specta(type = specta_typescript::Number)]
    pub created_at: i64,
}
impl From<tessera_store::review_comments::ReviewComment> for ReviewComment {
    fn from(c: tessera_store::review_comments::ReviewComment) -> Self {
        Self {
            id: c.id,
            task_id: c.task_id,
            file_path: c.file_path,
            side: c.side,
            line_start: c.line_start,
            line_end: c.line_end,
            code_excerpt: c.code_excerpt,
            body: c.body,
            sent_at: c.sent_at,
            resolved: c.resolved,
            created_at: c.created_at,
        }
    }
}
#[derive(Debug, Clone, serde::Deserialize, Type)]
pub struct CommentInput {
    pub task_id: String,
    pub file_path: String,
    pub side: String,
    #[specta(type = specta_typescript::Number)]
    pub line_start: i64,
    #[specta(type = specta_typescript::Number)]
    pub line_end: i64,
    pub code_excerpt: String,
    pub body: String,
}
#[derive(Debug, Clone, serde::Deserialize, Type)]
pub struct CommentReceipt {
    pub id: String,
    pub body: String,
}
#[derive(Debug, Clone, Serialize, Type)]
pub struct CommentBatch {
    pub text: String,
    pub comments: Vec<ReviewComment>,
}
#[tauri::command]
#[specta::specta]
pub fn review_comments_list(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<Vec<ReviewComment>, AppError> {
    Ok(state
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .review_comments()
        .list(&task_id)?
        .into_iter()
        .map(Into::into)
        .collect())
}
#[tauri::command]
#[specta::specta]
pub fn review_comment_add(state: tauri::State<'_, AppState>, input: CommentInput) -> Result<ReviewComment, AppError> {
    Ok(state
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .review_comments()
        .add(tessera_store::review_comments::NewReviewComment {
            task_id: input.task_id,
            file_path: input.file_path,
            side: input.side,
            line_start: input.line_start,
            line_end: input.line_end,
            code_excerpt: input.code_excerpt,
            body: input.body,
        })?
        .into())
}
#[tauri::command]
#[specta::specta]
pub fn review_comment_update(
    state: tauri::State<'_, AppState>,
    id: String,
    body: String,
    resolved: bool,
) -> Result<ReviewComment, AppError> {
    Ok(state
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .review_comments()
        .update(&id, &body, resolved)?
        .into())
}
#[tauri::command]
#[specta::specta]
pub fn review_comment_delete(state: tauri::State<'_, AppState>, id: String) -> Result<(), AppError> {
    state
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .review_comments()
        .delete(&id)?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub fn review_comments_prepare(state: tauri::State<'_, AppState>, task_id: String) -> Result<CommentBatch, AppError> {
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let comments = store
        .review_comments()
        .list(&task_id)?
        .into_iter()
        .filter(|c| c.sent_at.is_none() && !c.resolved)
        .collect::<Vec<_>>();
    Ok(CommentBatch {
        text: tessera_store::review_comments::comments_prompt(&comments),
        comments: comments.into_iter().map(Into::into).collect(),
    })
}
/// Acknowledge only after the frontend's shared prompt sender accepted the paste into a live agent PTY.
#[tauri::command]
#[specta::specta]
pub fn review_comments_send(
    state: tauri::State<'_, AppState>,
    task_id: String,
    receipts: Vec<CommentReceipt>,
) -> Result<Vec<ReviewComment>, AppError> {
    let receipts = receipts
        .into_iter()
        .map(|r| tessera_store::review_comments::CommentReceipt { id: r.id, body: r.body })
        .collect::<Vec<_>>();
    Ok(state
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .review_comments()
        .acknowledge(&task_id, &receipts)?
        .into_iter()
        .map(Into::into)
        .collect())
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, Type, tauri_specta::Event)]
#[tauri_specta(event_name = "review:git_changed")]
pub struct ReviewGitChanged {
    pub task_id: String,
}
fn emit_git_change(app: &tauri::AppHandle, task_id: String) {
    use tauri_specta::Event;
    if let Err(error) = (ReviewGitChanged { task_id }).emit(app) {
        tracing::warn!(%error,"could not emit review Git change");
    }
}
impl From<tessera_git::diff::ReviewGitError> for AppError {
    fn from(error: tessera_git::diff::ReviewGitError) -> Self {
        use tessera_git::diff::ReviewGitError;
        let code = match &error {
            ReviewGitError::NothingToCommit => "git.nothing_to_commit",
            ReviewGitError::HookFailed { .. } => "git.hook_failed",
            ReviewGitError::StaleHunk => "git.stale_hunk",
            ReviewGitError::Invalid(_) => "git.invalid_operation",
            ReviewGitError::Git(e) => e.code(),
        };
        Self::new(code, error.to_string())
    }
}
#[derive(Debug, Clone, Serialize, Type)]
pub struct IndexFile {
    pub path: String,
    pub old_path: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflict: bool,
}
#[derive(Debug, Clone, Serialize, Type)]
pub struct ReviewHunk {
    #[specta(type=specta_typescript::Number)]
    pub index: usize,
    pub header: String,
    pub patch: String,
}
#[derive(Debug, Clone, serde::Deserialize, Type)]
pub struct HunkSelection {
    #[specta(type=specta_typescript::Number)]
    pub index: usize,
    pub patch: String,
}
#[derive(Debug, Clone, Serialize, Type)]
pub struct CommitInfo {
    pub hash: String,
    pub output: String,
}
#[tauri::command]
#[specta::specta]
pub async fn git_review_index(app: tauri::AppHandle, task_id: String) -> Result<Vec<IndexFile>, AppError> {
    let (root, _) = context(&app, &task_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(tessera_git::diff::review_index(&root)?
            .into_iter()
            .map(|f| IndexFile {
                path: f.path,
                old_path: f.old_path,
                staged: f.staged,
                unstaged: f.unstaged,
                untracked: f.untracked,
                conflict: f.conflict,
            })
            .collect())
    })
    .await
    .map_err(|_| AppError::new("review.failed", "The Git worker failed."))?
}
#[tauri::command]
#[specta::specta]
pub async fn git_review_hunks(
    app: tauri::AppHandle,
    task_id: String,
    path: String,
    staged: bool,
) -> Result<Vec<ReviewHunk>, AppError> {
    let (root, _) = context(&app, &task_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(tessera_git::diff::review_hunks(&root, &path, staged)?
            .into_iter()
            .map(|h| ReviewHunk {
                index: h.index,
                header: h.header,
                patch: h.patch,
            })
            .collect())
    })
    .await
    .map_err(|_| AppError::new("review.failed", "The Git worker failed."))?
}
async fn git_change(
    app: tauri::AppHandle,
    task_id: String,
    path: String,
    hunk: Option<HunkSelection>,
    mode: &'static str,
) -> Result<(), AppError> {
    let (root, base) = context(&app, &task_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some(hunk) = hunk {
            tessera_git::diff::review_apply_hunk(&root, &path, hunk.index, &hunk.patch, mode)?;
        } else {
            let files = tessera_git::review_files(&root, &base)?;
            let old = files
                .iter()
                .find(|f| f.path == path)
                .and_then(|f| f.old_path.as_deref());
            match mode {
                "stage" => tessera_git::diff::review_stage_file(&root, &path, old)?,
                "unstage" => tessera_git::diff::review_unstage_file(&root, &path, old)?,
                _ => tessera_git::diff::review_discard_file(&root, &path, old)?,
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| AppError::new("review.failed", "The Git worker failed."))?;
    if result.is_ok() {
        emit_git_change(&app, task_id);
    }
    result
}
#[tauri::command]
#[specta::specta]
pub async fn git_stage(
    app: tauri::AppHandle,
    task_id: String,
    path: String,
    hunk: Option<HunkSelection>,
) -> Result<(), AppError> {
    git_change(app, task_id, path, hunk, "stage").await
}
#[tauri::command]
#[specta::specta]
pub async fn git_unstage(
    app: tauri::AppHandle,
    task_id: String,
    path: String,
    hunk: Option<HunkSelection>,
) -> Result<(), AppError> {
    git_change(app, task_id, path, hunk, "unstage").await
}
#[tauri::command]
#[specta::specta]
pub async fn git_discard(
    app: tauri::AppHandle,
    task_id: String,
    path: String,
    hunk: Option<HunkSelection>,
    confirmed: bool,
) -> Result<(), AppError> {
    if !confirmed {
        return Err(AppError::new(
            "git.confirm_required",
            "Confirm discard in the app before continuing.",
        ));
    }
    git_change(app, task_id, path, hunk, "discard").await
}
#[tauri::command]
#[specta::specta]
pub async fn git_commit(app: tauri::AppHandle, task_id: String, message: String) -> Result<CommitInfo, AppError> {
    let (root, _) = context(&app, &task_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let commit = tessera_git::diff::review_commit(&root, &message)?;
        Ok(CommitInfo {
            hash: commit.hash,
            output: commit.output,
        })
    })
    .await
    .map_err(|_| AppError::new("review.failed", "The Git worker failed."))?;
    if result.is_ok() {
        emit_git_change(&app, task_id);
    }
    result
}
