//! Task IPC, two-second git metadata cache and debounced task:changed notifications.
use crate::{error::AppError, project_commands::with_store, project_types::*, state::AppState};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_specta::Event;
use tessera_store::{
    Store,
    projects::{setup_hash, setup_state},
    repositories::Task as StoredTask,
    tasks::{CreateTask, TaskError},
};

/// Persisted task state or git facts changed. Dots are not allowed in Tauri event names.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "task:changed")]
pub struct TaskChanged {
    /// Task identifier.
    pub task_id: String,
    /// Current task and best-effort git facts.
    pub summary: TaskSummary,
}
#[derive(Clone, Default)]
struct Facts {
    ahead: Option<u32>,
    behind: Option<u32>,
    changed: Option<u32>,
    branch: Option<String>,
}
/// Owns task watchers and transient metadata. Nothing is stored in user configuration.
#[derive(Default)]
pub struct Tasks {
    watchers: Mutex<HashMap<String, tessera_git::WorktreeWatcher>>,
    cache: Mutex<HashMap<String, (Instant, Facts)>>,
}
impl From<TaskError> for AppError {
    fn from(error: TaskError) -> Self {
        let mut result = Self::new(error.code(), error.to_string());
        match error {
            TaskError::UnmergedCommits { list } => result.list = Some(list),
            TaskError::SetupNotApproved { task_id } => result.task_id = Some(task_id),
            TaskError::DirtyWorktree => {
                result.dirty = Some(true);
                result.list = Some(vec![]);
            }
            _ => {}
        }
        result
    }
}
fn checkout(store: &Store, task: &StoredTask) -> Option<PathBuf> {
    task.worktree_path.as_ref().map(PathBuf::from).or_else(|| {
        if task.uses_main_checkout != Some(1) {
            return None;
        }
        Some(PathBuf::from(
            store.projects().get(task.project_id.as_deref()?).ok()??.path,
        ))
    })
}
fn facts(path: &Path, base: &str) -> Facts {
    let counts = tessera_git::ahead_behind(path, base).ok();
    let status = tessera_git::status(path).ok();
    let changes = tessera_git::changed_files(path, base).ok();
    let changed = changes.as_ref().zip(status.as_ref()).map(|(changes, status)| {
        let mut names: BTreeSet<_> = changes.iter().map(|f| f.path.clone()).collect();
        names.extend(status.files.iter().map(|f| f.path.clone()));
        u32::try_from(names.len()).unwrap_or(u32::MAX)
    });
    Facts {
        ahead: counts.map(|(a, _)| u32::try_from(a).unwrap_or(u32::MAX)),
        behind: counts.map(|(_, b)| u32::try_from(b).unwrap_or(u32::MAX)),
        changed,
        branch: status.and_then(|s| s.branch),
    }
}
fn summary(app: &tauri::AppHandle, task: StoredTask, path: Option<&Path>, fresh: bool) -> TaskSummary {
    let registry = app.state::<Tasks>();
    let cached = registry.cache.lock().ok().and_then(|cache| {
        cache
            .get(&task.id)
            .filter(|(at, _)| !fresh && at.elapsed() < Duration::from_secs(2))
            .map(|(_, f)| f.clone())
    });
    let data = cached.unwrap_or_else(|| {
        let data = path.map(|p| facts(p, &task.base_branch)).unwrap_or_default();
        if let Ok(mut cache) = registry.cache.lock() {
            cache.insert(task.id.clone(), (Instant::now(), data.clone()));
        }
        data
    });
    let mut task: Task = task.into();
    if let Some(branch) = data.branch {
        task.branch = branch;
    }
    TaskSummary {
        task,
        ahead: data.ahead,
        behind: data.behind,
        changed_files: data.changed,
        ports: vec![],
    }
}
pub(crate) fn emit(app: &tauri::AppHandle, task: &StoredTask, path: Option<&Path>) {
    let payload = TaskChanged {
        task_id: task.id.clone(),
        summary: summary(app, task.clone(), path, true),
    };
    if let Err(error) = payload.emit(app) {
        tracing::warn!(%error,"could not emit task change");
    }
}
/// Drop a task's worktree watcher before its delete: the watcher holds the folder open on Windows.
pub(crate) fn drop_task_watcher(app: &tauri::AppHandle, id: &str) {
    if let Ok(mut watchers) = app.state::<Tasks>().watchers.lock() {
        watchers.remove(id);
    }
}
/// Reconcile watchers after task/project lifecycle changes and when the app starts.
/// Drop obsolete watchers only after releasing the database lock to avoid joining a blocked callback.
pub(crate) fn reconcile_watchers(app: &tauri::AppHandle) {
    let desired = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else {
            return;
        };
        let Ok(tasks) = store.tasks().list() else {
            return;
        };
        tasks
            .iter()
            .filter(|t| !matches!(t.state.as_deref(), Some("deleted" | "archived")))
            .filter_map(|t| Some((t.id.clone(), checkout(&store, t)?)))
            .filter(|(_, p)| p.is_dir())
            .collect::<HashMap<_, _>>()
    };
    let registry = app.state::<Tasks>();
    let Ok(mut watchers) = registry.watchers.lock() else {
        return;
    };
    watchers.retain(|id, _| desired.contains_key(id));
    if let Ok(mut cache) = registry.cache.lock() {
        cache.retain(|id, _| desired.contains_key(id));
    }
    for (id, path) in desired {
        if watchers.contains_key(&id) {
            continue;
        }
        let handle = app.clone();
        let task_id = id.clone();
        match tessera_git::WorktreeWatcher::new(&path, move || {
            let state = handle.state::<AppState>();
            let Ok(store) = state.store.lock() else {
                return;
            };
            if let Ok(task) = store.task_get(&task_id)
                && task.state.as_deref() != Some("deleted")
            {
                let path = checkout(&store, &task);
                emit(&handle, &task, path.as_deref());
            }
        }) {
            Ok(watcher) => {
                watchers.insert(id, watcher);
            }
            Err(error) => tracing::warn!(%error,%id,"could not watch task worktree"),
        }
    }
}
fn setup_info(project: &tessera_store::repositories::Project) -> SetupInfo {
    let state = setup_state(project).into();
    SetupInfo {
        state,
        script: project.setup_script.clone(),
        shell: project.setup_shell.clone(),
        hash: project
            .setup_script
            .as_ref()
            .map(|s| setup_hash(project.setup_shell.as_deref().unwrap_or(""), s)),
    }
}
/// Create a task without agents; setup scripts are returned for the UI to run in a pane.
#[tauri::command]
#[specta::specta]
pub async fn task_create(app: tauri::AppHandle, input: TaskCreateInput) -> Result<TaskCreateResult, AppError> {
    if !input.agents.is_empty() {
        return Err(TaskError::AgentsUnsupported.into());
    }
    let events = app.clone();
    let result = with_store(app.clone(), move |store| {
        let project = store.projects().get(&input.project_id)?.ok_or(TaskError::NotFound)?;
        let main = PathBuf::from(&project.path);
        let task = store.task_create_record(
            CreateTask {
                project_id: input.project_id,
                name: input.name,
                prompt: input.prompt,
                base_branch: input.base_branch,
                existing_branch: input.existing_branch,
                branch_name: input.branch_name,
                use_main_checkout: input.use_main_checkout,
                run_setup: input.run_setup,
            },
            |task| {
                let path = task
                    .worktree_path
                    .as_deref()
                    .map(Path::new)
                    .or(if task.uses_main_checkout == Some(1) {
                        Some(main.as_path())
                    } else {
                        None
                    });
                emit(&events, task, path);
            },
        )?;
        Ok(TaskCreateResult {
            group_id: None,
            tasks: vec![task.into()],
            setup: setup_info(&project),
        })
    })
    .await;
    reconcile_watchers(&app);
    result
}
/// List tasks. Git errors become null facts, and git answers are cached for two seconds.
#[tauri::command]
#[specta::specta]
pub async fn task_list(
    app: tauri::AppHandle,
    project_id: Option<String>,
    include_archived: bool,
) -> Result<Vec<TaskSummary>, AppError> {
    let handle = app.clone();
    with_store(app, move |store| {
        Ok(store
            .tasks()
            .list()?
            .into_iter()
            .filter(|t| {
                t.state.as_deref() != Some("deleted")
                    && (include_archived || t.state.as_deref() != Some("archived"))
                    && project_id.as_ref().is_none_or(|id| t.project_id.as_ref() == Some(id))
            })
            .map(|task| {
                let path = checkout(store, &task);
                summary(&handle, task, path.as_deref(), false)
            })
            .collect())
    })
    .await
}
async fn change(
    app: tauri::AppHandle,
    id: String,
    operation: &'static str,
    name: Option<String>,
) -> Result<Task, AppError> {
    let handle = app.clone();
    let result = with_store(app.clone(), move |store| {
        let prior = store.task_get(&id)?;
        let path = checkout(store, &prior);
        let callback = |task: &StoredTask| emit(&handle, task, path.as_deref());
        let task = match operation {
            "archive" => store.task_archive_record(&id, callback)?,
            "restore" => store.task_restore_record(&id, callback)?,
            _ => store.task_rename_record(&id, name.unwrap_or_default(), callback)?,
        };
        Ok(task.into())
    })
    .await;
    reconcile_watchers(&app);
    result
}
/// Archive without removing files or branches; frees the allocated ports.
#[tauri::command]
#[specta::specta]
pub async fn task_archive(app: tauri::AppHandle, id: String) -> Result<Task, AppError> {
    change(app, id, "archive", None).await
}
/// Restore an archived task and allocate available ports.
#[tauri::command]
#[specta::specta]
pub async fn task_restore(app: tauri::AppHandle, id: String) -> Result<Task, AppError> {
    change(app, id, "restore", None).await
}
/// Rename only the display name of a task.
#[tauri::command]
#[specta::specta]
pub async fn task_rename(app: tauri::AppHandle, id: String, name: String) -> Result<Task, AppError> {
    change(app, id, "rename", Some(name)).await
}
/// Delete the task's owned worktree and branch after data-loss checks.
#[tauri::command]
#[specta::specta]
pub async fn task_delete(app: tauri::AppHandle, id: String, confirm_lost_commits: bool) -> Result<(), AppError> {
    let handle = app.clone();
    let task_id = id.clone();
    // The watcher holds the worktree folder open on Windows. Drop it before the store lock is taken (its callback
    // locks the store); `reconcile_watchers` below brings it back when the delete fails.
    let watcher = app
        .state::<Tasks>()
        .watchers
        .lock()
        .ok()
        .and_then(|mut w| w.remove(&id));
    drop(watcher);
    let host = std::sync::Arc::clone(&app.state::<AppState>().sessions);
    let result = with_store(app.clone(), move |store| {
        let prior = store.task_get(&id)?;
        let path = checkout(store, &prior);
        // Once the data-loss checks pass, stop the task's shells: a shell's cwd keeps the folder busy on Windows and
        // `git worktree remove` fails.
        store.task_delete_record_with(
            &id,
            confirm_lost_commits,
            |task| emit(&handle, task, path.as_deref()),
            |worktree| {
                host.kill_task_sessions(&id, worktree, SHELL_EXIT_TIMEOUT);
            },
        )?;
        // Only a task with its own worktree: never the project's main checkout.
        Ok(prior.worktree_path.clone().map(std::path::PathBuf::from))
    })
    .await;
    if let Ok(Some(worktree)) = &result {
        remove_leftover_worktree(&app, &task_id, worktree).await;
    }
    let result = result.map(|_| ());
    reconcile_watchers(&app);
    result
}
/// How long a delete waits for the task's killed shells to exit before it removes the worktree.
const SHELL_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
/// After a delete, git may leave the worktree folder behind: a process running inside it keeps it busy (Windows).
/// Kill any task shell still there, then retry the removal for a few seconds. Never touches anything that is not the
/// task's worktree.
async fn remove_leftover_worktree(app: &tauri::AppHandle, task_id: &str, worktree: &Path) {
    if !worktree.exists() {
        return;
    }
    let host = std::sync::Arc::clone(&app.state::<AppState>().sessions);
    let (id, path) = (task_id.to_owned(), worktree.to_owned());
    let _ = tauri::async_runtime::spawn_blocking(move || {
        host.kill_task_sessions(&id, &path, SHELL_EXIT_TIMEOUT);
        for _ in 0..25 {
            match std::fs::remove_dir_all(&path) {
                Ok(()) => return,
                Err(_) if !path.exists() => return,
                Err(_) => std::thread::sleep(Duration::from_millis(200)),
            }
        }
        tracing::warn!(task = %id, "the task worktree folder could not be removed after its shells were stopped");
    })
    .await;
}

/// Best-effort listeners for processes attributable to the task checkout.
/// macOS uses accessible cwd plus descendants. Windows uses known task session PIDs and their descendants.
#[tauri::command]
#[specta::specta]
pub async fn task_ports(app: tauri::AppHandle, id: String) -> Result<Vec<u16>, AppError> {
    #[cfg(windows)]
    {
        let task_id = id.clone();
        let checkout = with_store(app.clone(), move |store| {
            Ok(checkout(store, &store.task_get(&task_id)?))
        })
        .await?;
        let Some(checkout) = checkout else {
            return Ok(Vec::new());
        };
        tauri::async_runtime::spawn_blocking(move || {
            let roots = app.state::<AppState>().sessions.task_process_roots(&id, &checkout);
            tessera_store::task_ports::ports_for_session_roots(&roots)
        })
        .await
        .map_err(|error| AppError::new("task.ports_failed", error.to_string()))
    }
    #[cfg(not(windows))]
    with_store(app, move |store| {
        let task = store.task_get(&id)?;
        Ok(checkout(store, &task)
            .map(|p| tessera_store::task_ports::ports_in_worktree(&p))
            .unwrap_or_default())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn git_failures_produce_null_facts() {
        let temp = tempfile::tempdir().expect("temp");
        let data = facts(temp.path(), "main");
        assert_eq!(data.ahead, None);
        assert_eq!(data.behind, None);
        assert_eq!(data.changed, None);
        assert_eq!(data.branch, None);
    }
    #[test]
    fn deletion_errors_keep_confirmation_details_and_setup_task_id() {
        let commits = AppError::from(TaskError::UnmergedCommits {
            list: vec!["abc".into()],
        });
        assert_eq!(commits.code, "task.unmerged_commits");
        assert_eq!(commits.list, Some(vec!["abc".into()]));
        let dirty = AppError::from(TaskError::DirtyWorktree);
        assert_eq!(dirty.code, "task.unmerged_commits");
        assert_eq!(dirty.dirty, Some(true));
        let setup = AppError::from(TaskError::SetupNotApproved {
            task_id: "task-id".into(),
        });
        assert_eq!(setup.task_id.as_deref(), Some("task-id"));
    }
}
