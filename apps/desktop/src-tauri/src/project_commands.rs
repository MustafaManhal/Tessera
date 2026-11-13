//! Project/run-script IPC. Blocking git and SQLite operations never run on the UI thread.
use crate::{error::AppError, project_types::*, state::AppState};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Manager;
use tessera_store::{
    Store,
    projects::ProjectError,
    repositories::{RunScript as StoredScript, new_id},
};

/// One cancellable clone per application; a second clone is rejected explicitly.
#[derive(Default)]
pub struct Clones(pub Mutex<Option<Arc<AtomicBool>>>);
impl From<ProjectError> for AppError {
    fn from(error: ProjectError) -> Self {
        let mut result = Self::new(error.code(), error.to_string());
        if let ProjectError::NotAGitRepo { can_init } = error {
            result.can_init = Some(can_init);
        }
        result
    }
}
/// Execute a short repository operation on the blocking pool.
pub(crate) async fn with_store<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(&Store) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        work(&store)
    })
    .await
    .map_err(|e| AppError::new("store.worker_failed", e.to_string()))?
}
/// List registered projects in configured sort order.
#[tauri::command]
#[specta::specta]
pub async fn project_list(app: tauri::AppHandle) -> Result<Vec<Project>, AppError> {
    with_store(app, |store| {
        let mut rows = store.projects().list()?;
        rows.sort_by_key(|p| (p.sort.unwrap_or(0), p.id.clone()));
        rows.into_iter().map(Project::try_from).collect()
    })
    .await
}
/// Add a local repository or clone into an explicitly selected directory.
#[tauri::command]
#[specta::specta]
pub async fn project_add(app: tauri::AppHandle, input: ProjectInput) -> Result<Project, AppError> {
    if input.path.is_some() == input.clone_url.is_some() {
        return Err(AppError::new("project.invalid_input", "supply a path or a clone URL"));
    }
    let root = app.state::<AppState>().dirs.root.clone();
    if let Some(url) = input.clone_url {
        let destination = input
            .clone_dir
            .ok_or_else(|| AppError::new("project.invalid_input", "clone_dir required"))?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let clones = app.state::<Clones>();
            let mut active = clones.0.lock().map_err(|_| AppError::lock_failed())?;
            if active.is_some() {
                return Err(AppError::new("project.clone_busy", "a clone is already running"));
            }
            *active = Some(cancel.clone());
        }
        // Clone uses a separate connection so status queries and cancellation remain responsive.
        let dirs = app.state::<AppState>().dirs.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let store = Store::open(&dirs)?;
            let mut project = store.project_clone(&url, Path::new(&destination), &root, &cancel)?;
            if let Some(name) = input.name {
                project.name = name;
                project = store.project_update_record(project)?;
            }
            Project::try_from(project)
        })
        .await
        .map_err(|e| AppError::new("project.clone_failed", e.to_string()));
        *app.state::<Clones>().0.lock().map_err(|_| AppError::lock_failed())? = None;
        return result?;
    }
    with_store(app, move |store| {
        let path = input
            .path
            .ok_or_else(|| AppError::new("project.invalid_input", "path required"))?;
        let mut project = store.project_add_local(Path::new(&path), &root)?;
        if let Some(name) = input.name {
            project.name = name;
            project = store.project_update_record(project)?;
        }
        Project::try_from(project)
    })
    .await
}
/// Cancel the application-owned clone without waiting for the database mutex.
#[tauri::command]
#[specta::specta]
pub fn project_clone_cancel(clones: tauri::State<'_, Clones>) -> Result<(), AppError> {
    if let Some(cancel) = clones.0.lock().map_err(|_| AppError::lock_failed())?.as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}
/// Initialize a folder selected by the user.
#[tauri::command]
#[specta::specta]
pub async fn project_git_init(path: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || Store::project_git_init(Path::new(&path)))
        .await
        .map_err(|e| AppError::new("project.git_failed", e.to_string()))?
        .map_err(AppError::from)
}
/// Apply a typed patch; explicit null clears nullable values, omission preserves them.
#[tauri::command]
#[specta::specta]
pub async fn project_update(app: tauri::AppHandle, id: String, patch: ProjectPatch) -> Result<Project, AppError> {
    with_store(app, move |store| {
        let mut p = store.projects().get(&id)?.ok_or(ProjectError::NotFound)?;
        if let Some(v) = patch.name {
            p.name = v;
        }
        if let Some(v) = patch.default_branch {
            p.default_branch = v;
        }
        if let Some(v) = patch.worktree_dir {
            p.worktree_dir = v;
        }
        if let Some(v) = patch.setup_script {
            p.setup_script = v;
        }
        if let Some(v) = patch.setup_shell {
            p.setup_shell = v;
        }
        if let Some(v) = patch.port_base {
            p.port_base = v.map(i64::from);
        }
        if let Some(v) = patch.is_muted {
            p.is_muted = Some(i64::from(v));
        }
        if let Some(v) = patch.sort {
            p.sort = Some(i64::from(v));
        }
        if let Some(v) = patch.work_mode {
            p.work_mode = v.as_str().to_owned();
        }
        if let Some(v) = patch.copy_files {
            p.copy_files =
                Some(serde_json::to_string(&v).map_err(|e| AppError::new("project.invalid_copy_file", e.to_string()))?);
        }
        Project::try_from(store.project_update_record(p)?)
    })
    .await
}
/// Remove records and return the number of worktrees retained on disk.
#[tauri::command]
#[specta::specta]
pub async fn project_remove(app: tauri::AppHandle, id: String) -> Result<ProjectRemoval, AppError> {
    let result = with_store(app.clone(), move |store| {
        Ok(ProjectRemoval {
            tasks_with_worktrees: u32::try_from(store.project_remove_record(&id)?).unwrap_or(u32::MAX),
        })
    })
    .await;
    if result.is_ok() {
        crate::task_commands::reconcile_watchers(&app);
    }
    result
}
/// Approve the exact current setup script and shell.
#[tauri::command]
#[specta::specta]
pub async fn project_approve_setup(app: tauri::AppHandle, id: String) -> Result<Project, AppError> {
    with_store(app, move |store| Project::try_from(store.project_approve_setup(&id)?)).await
}
/// List scripts belonging to a project in sort order.
#[tauri::command]
#[specta::specta]
pub async fn run_script_list(app: tauri::AppHandle, project_id: String) -> Result<Vec<RunScript>, AppError> {
    with_store(app, move |store| {
        let mut scripts: Vec<_> = store
            .run_scripts()
            .list()?
            .into_iter()
            .filter(|s| s.project_id.as_deref() == Some(&project_id))
            .collect();
        scripts.sort_by_key(|s| (s.sort.unwrap_or(0), s.id.clone()));
        Ok(scripts.into_iter().map(RunScript::from).collect())
    })
    .await
}
/// Add a named run script.
#[tauri::command]
#[specta::specta]
pub async fn run_script_add(
    app: tauri::AppHandle,
    project_id: String,
    input: RunScriptInput,
) -> Result<RunScript, AppError> {
    with_store(app, move |store| {
        if store.projects().get(&project_id)?.is_none() {
            return Err(ProjectError::NotFound.into());
        }
        let s = StoredScript {
            id: new_id(),
            project_id: Some(project_id),
            name: Some(input.name),
            command: Some(input.command),
            auto_start: Some(i64::from(input.auto_start)),
            sort: Some(i64::from(input.sort.unwrap_or(0))),
        };
        store.run_scripts().insert(&s)?;
        Ok(s.into())
    })
    .await
}
/// Update a run script.
#[tauri::command]
#[specta::specta]
pub async fn run_script_update(
    app: tauri::AppHandle,
    id: String,
    patch: RunScriptPatch,
) -> Result<RunScript, AppError> {
    with_store(app, move |store| {
        let mut s = store
            .run_scripts()
            .get(&id)?
            .ok_or_else(|| AppError::new("project.script_not_found", "unknown run script"))?;
        if let Some(v) = patch.name {
            s.name = Some(v);
        }
        if let Some(v) = patch.command {
            s.command = Some(v);
        }
        if let Some(v) = patch.auto_start {
            s.auto_start = Some(i64::from(v));
        }
        if let Some(v) = patch.sort {
            s.sort = Some(i64::from(v));
        }
        store.run_scripts().update(&s)?;
        Ok(s.into())
    })
    .await
}
/// Delete a run script.
#[tauri::command]
#[specta::specta]
pub async fn run_script_remove(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    with_store(app, move |store| {
        if !store.run_scripts().delete(&id)? {
            return Err(AppError::new("project.script_not_found", "unknown run script"));
        }
        Ok(())
    })
    .await
}
