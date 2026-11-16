//! Task lifecycle, isolated worktrees, setup-file transfer and port allocation.
use crate::{
    Store, StoreError,
    projects::{ProjectError, SetupState, setup_state},
    repositories::{Project, Task, new_id, now_seconds},
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tessera_git::{GitError, Repo, remote};

/// A task operation failure with stable machine-readable codes.
#[derive(Debug, thiserror::Error)]
pub enum TaskError {
    /// Unknown task or project.
    #[error("unknown task or project")]
    NotFound,
    /// Agents are deliberately unavailable until M6.
    #[error("agent requests are not supported yet")]
    AgentsUnsupported,
    /// No ten-port block remains in the configured range.
    #[error("port range exhausted")]
    PortsExhausted,
    /// An invalid transition or unsafe worktree ownership was encountered.
    #[error("invalid task operation: {0}")]
    Invalid(String),
    /// Lost commits require explicit confirmation.
    #[error("unmerged commits require confirmation")]
    UnmergedCommits {
        /// Commit hashes not in the base branch.
        list: Vec<String>,
    },
    /// Working-tree modifications require explicit confirmation.
    #[error("dirty worktree requires confirmation")]
    DirtyWorktree,
    /// The caller must ask for setup approval before requesting execution.
    #[error("setup script needs approval for task {task_id}")]
    SetupNotApproved {
        /// Task that was created without running setup.
        task_id: String,
    },
    /// Persistence failed.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// Git refused an operation.
    #[error(transparent)]
    Git(#[from] GitError),
    /// Project validation failed.
    #[error(transparent)]
    Project(#[from] ProjectError),
    /// Filesystem transfer failed.
    #[error("task file operation failed: {0}")]
    Io(#[from] std::io::Error),
}
impl TaskError {
    /// Stable IPC code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "task.not_found",
            Self::AgentsUnsupported => "task.agents_unsupported",
            Self::PortsExhausted => "task.ports_exhausted",
            Self::Invalid(_) => "task.invalid",
            Self::UnmergedCommits { .. } => "task.unmerged_commits",
            Self::DirtyWorktree => "task.unmerged_commits",
            Self::SetupNotApproved { .. } => "task.setup_not_approved",
            Self::Store(_) => "task.store_failed",
            Self::Git(e) => e.code(),
            Self::Project(e) => e.code(),
            Self::Io(_) => "task.io",
        }
    }
}
/// Core creation arguments. The IPC edge rejects nonempty agent requests.
pub struct CreateTask {
    /// Owning project identifier.
    pub project_id: String,
    /// Human name, or an automatically generated name.
    pub name: Option<String>,
    /// Stored prompt (not executed).
    pub prompt: Option<String>,
    /// Existing git revision for the new branch.
    pub base_branch: String,
    /// Check out this existing local branch in a worktree instead of creating a `tessera/` branch. The branch is kept
    /// when the task is deleted.
    pub existing_branch: Option<String>,
    /// The name for the new branch when the task makes one; `tessera/<task name>` when empty.
    pub branch_name: Option<String>,
    /// Use the user's current checkout without creating or deleting it.
    pub use_main_checkout: bool,
    /// Request setup; this validates approval but never executes scripts.
    pub run_setup: bool,
}
/// First available aligned ten-port block at or above base, excluding occupied ranges.
/// The upper limit is inclusive; useful for deterministic exhaustion tests.
pub fn allocate_ports(base: u16, upper: u16, occupied: &[(u16, u16)]) -> Result<u16, TaskError> {
    if base == 0 {
        return Err(TaskError::PortsExhausted);
    }
    let mut start = u32::from(base);
    while start + 9 <= u32::from(upper) {
        if occupied
            .iter()
            .all(|&(port, count)| start + 10 <= u32::from(port) || start >= u32::from(port) + u32::from(count))
        {
            return Ok(start as u16);
        }
        start += 10;
    }
    Err(TaskError::PortsExhausted)
}
impl Store {
    fn project_for_task(&self, task: &Task) -> Result<Project, TaskError> {
        self.projects()
            .get(task.project_id.as_deref().ok_or(TaskError::NotFound)?)?
            .ok_or(TaskError::NotFound)
    }
    /// Fetch a task or return a typed not-found error.
    pub fn task_get(&self, id: &str) -> Result<Task, TaskError> {
        self.tasks().get(id)?.ok_or(TaskError::NotFound)
    }
    fn free_ports(&self, project: &Project, except: &str) -> Result<u16, TaskError> {
        let used: Vec<_> = self
            .tasks()
            .list()?
            .iter()
            .filter(|t| {
                t.id != except
                    && t.project_id.as_deref() == Some(&project.id)
                    && !matches!(t.state.as_deref(), Some("archived" | "deleted" | "error"))
            })
            .filter_map(|t| {
                Some((
                    u16::try_from(t.port_start?).ok()?,
                    u16::try_from(t.port_count.unwrap_or(10)).ok()?,
                ))
            })
            .collect();
        let base = u16::try_from(project.port_base.unwrap_or(10000)).map_err(|_| TaskError::PortsExhausted)?;
        allocate_ports(base, u16::MAX, &used)
    }
    fn save_state(&self, task: &mut Task, state: &str, changed: &mut impl FnMut(&Task)) -> Result<(), TaskError> {
        task.state = Some(state.into());
        task.updated_at = Some(now_seconds());
        self.tasks().update(task)?;
        changed(task);
        Ok(())
    }
    /// Create a task and emit each persisted state through the callback.
    /// On setup transfer failure, only the newly owned worktree/branch are rolled back.
    pub fn task_create_record(&self, mut input: CreateTask, mut changed: impl FnMut(&Task)) -> Result<Task, TaskError> {
        let project = self.projects().get(&input.project_id)?.ok_or(TaskError::NotFound)?;
        let repo = Repo::open(&project.path)?;
        if input.use_main_checkout && repo.bare {
            return Err(TaskError::Invalid("bare repository has no main checkout".into()));
        }
        // Branch mode: tasks work on branches inside the project folder, never in a worktree.
        let mut branch_mode = project.work_mode == "branches" && !repo.bare;
        if branch_mode && !remote::is_remote(&repo.root) {
            // A worktree registration whose folder is gone still "uses" its branch; clear those before switching.
            let _ = tessera_git::prune(&repo);
        }
        if branch_mode
            && let Some(wanted) = input.existing_branch.as_deref().filter(|b| !b.trim().is_empty())
            && let Ok(list) = tessera_git::worktree_list(&repo.root)
        {
            // A branch that lives in another worktree cannot be switched to: the task adopts that folder instead.
            let there = list.iter().any(|w| {
                w.branch.as_deref() == Some(&format!("refs/heads/{wanted}"))
                    && Path::new(&w.path).exists()
                    && !remote::same(Path::new(&w.path), &repo.root)
                    && fs::canonicalize(&w.path).ok() != fs::canonicalize(&repo.root).ok()
            });
            if there {
                branch_mode = false;
            }
        }
        if branch_mode {
            input.use_main_checkout = true;
        }
        let id = new_id();
        let name = input
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("Task {}", &id[id.len() - 6..]));
        let existing: Vec<_> = self
            .tasks()
            .list()?
            .iter()
            .filter(|t| t.project_id.as_deref() == Some(&project.id))
            .map(|t| t.slug.clone())
            .collect();
        let slug = tessera_git::unique_slug(&name, &existing);
        // The branch a new task makes: the name the user typed, or one made from the task name.
        let new_branch = match input.branch_name.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            Some(typed) => {
                tessera_git::check_branch_name(typed).map_err(TaskError::Invalid)?;
                typed.to_owned()
            }
            None => format!("tessera/{slug}"),
        };
        let borrowed = input
            .existing_branch
            .clone()
            .filter(|b| !b.trim().is_empty() && !input.use_main_checkout);
        // A branch that is already checked out somewhere cannot be checked out again: work in that folder instead.
        let mut adopted: Option<PathBuf> = None;
        let mut borrowed = borrowed;
        if borrowed.is_some() && !remote::is_remote(&repo.root) {
            // Registrations whose folder was deleted (an old dev build, another app) block the branch for no reason.
            let _ = tessera_git::prune(&repo);
        }
        if let Some(existing) = &borrowed
            && let Ok(list) = tessera_git::worktree_list(&repo.root)
            && let Some(found) = list.iter().find(|w| {
                w.branch.as_deref() == Some(&format!("refs/heads/{existing}"))
                    && (remote::is_remote(Path::new(&w.path)) || Path::new(&w.path).exists())
            })
        {
            let there = PathBuf::from(&found.path);
            let is_main = remote::same(&there, &repo.root)
                || fs::canonicalize(&there)
                    .ok()
                    .zip(fs::canonicalize(&repo.root).ok())
                    .is_some_and(|(a, b)| a == b);
            if is_main {
                input.use_main_checkout = true;
                borrowed = None;
            } else {
                adopted = Some(there);
            }
        }
        // In branch mode, switch the project folder to the chosen (or a new) branch before the task exists.
        let mut switched: Option<String> = None;
        if branch_mode {
            let wanted = input.existing_branch.clone().filter(|b| !b.trim().is_empty());
            match wanted {
                Some(existing) if repo.branch.as_deref() != Some(existing.trim_start_matches("remotes/origin/")) => {
                    tessera_git::switch_branch(&repo, &existing, false, &input.base_branch)?;
                    switched = Some(existing.trim_start_matches("remotes/origin/").to_owned());
                }
                Some(existing) => switched = Some(existing),
                None => {
                    let fresh = new_branch.clone();
                    tessera_git::switch_branch(&repo, &fresh, true, &input.base_branch)?;
                    switched = Some(fresh);
                }
            }
        }
        let branch = if let Some(chosen) = switched {
            chosen
        } else if input.use_main_checkout && borrowed.is_none() {
            repo.branch
                .clone()
                .ok_or_else(|| TaskError::Invalid("main checkout is detached".into()))?
        } else if let Some(existing) = &borrowed {
            existing.clone()
        } else if input.use_main_checkout {
            repo.branch
                .clone()
                .ok_or_else(|| TaskError::Invalid("main checkout is detached".into()))?
        } else {
            new_branch.clone()
        };
        let path = if input.use_main_checkout {
            None
        } else if let Some(there) = &adopted {
            Some(there.clone())
        } else {
            let root = project
                .worktree_dir
                .as_ref()
                .ok_or_else(|| TaskError::Invalid("missing worktree directory".into()))?;
            let root = PathBuf::from(root);
            let root = if root.is_absolute() || remote::is_remote(&root) {
                root
            } else {
                repo.root.join(root)
            };
            Some(tessera_git::task_worktree_path(&root, &slug)?)
        };
        // A new branch whose name is taken must fail now, before any task exists.
        if !input.use_main_checkout
            && borrowed.is_none()
            && adopted.is_none()
            && !remote::is_remote(&repo.root)
            && tessera_git::branch_exists(&repo.root, &branch)?
        {
            return Err(TaskError::Git(GitError::BranchExists));
        }
        // A repository with no commits (or a base branch that is not there) cannot give a task a branch to start from.
        if !input.use_main_checkout
            && borrowed.is_none()
            && adopted.is_none()
            && !remote::is_remote(&repo.root)
            && !tessera_git::commit_exists(&repo.root, &input.base_branch)
        {
            return Err(TaskError::Git(GitError::WorktreeFailed {
                stderr: format!(
                    "The base branch \"{}\" has no commits yet. Make a first commit in this repository (for example `git commit --allow-empty -m \"Initial commit\"`), then create the task.",
                    input.base_branch
                ),
            }));
        }
        let now = now_seconds();
        let mut task = Task {
            id,
            project_id: Some(project.id.clone()),
            group_id: None,
            name,
            slug,
            branch,
            base_branch: input.base_branch,
            worktree_path: path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            // 0 owns its worktree and branch, 1 is the main checkout, 2 owns its worktree on a branch that was already there,
            // 3 works in a worktree that was already there (nothing is removed on delete).
            uses_main_checkout: Some(if adopted.is_some() {
                3
            } else if borrowed.is_some() {
                2
            } else {
                i64::from(input.use_main_checkout)
            }),
            board_column: None,
            state: Some("backlog".into()),
            prompt: input.prompt,
            issue_ref: None,
            port_start: Some(i64::from(self.free_ports(&project, "")?)),
            port_count: Some(10),
            pr_number: None,
            pr_url: None,
            pr_state: None,
            ci_state: None,
            last_message: None,
            tags: None,
            created_at: Some(now),
            updated_at: Some(now),
            archived_at: None,
        };
        self.tasks().insert(&task)?;
        changed(&task);
        self.save_state(&mut task, "setting_up", &mut changed)?;
        let mut created = false;
        let operation = (|| -> Result<(), TaskError> {
            if let Some(path) = path.as_ref().filter(|_| adopted.is_none()) {
                if let Some(parent) = path.parent() {
                    if remote::is_remote(parent) {
                        remote::create_dir_all(parent)?;
                    } else {
                        fs::create_dir_all(parent)?;
                    }
                }
                if borrowed.is_some() {
                    tessera_git::worktree_add_existing(&repo, &task.branch, path)?;
                } else {
                    tessera_git::worktree_add_exact(&repo, &task.branch, path, &task.base_branch)?;
                }
                created = true;
                let fallback = self.copy_task_files(&project, path)?;
                if fallback {
                    task.last_message = Some("Windows symlink permission denied; copied files instead".into());
                }
            }
            self.save_state(&mut task, "active", &mut changed)
        })();
        if let Err(error) = operation {
            let rollback = if created && borrowed.is_some() {
                // The branch was not ours: take the worktree away and leave the branch alone.
                path.as_deref()
                    .map_or(Ok(()), |p| tessera_git::worktree_remove(&repo, p, true))
                    .map_err(TaskError::from)
            } else if created {
                rollback_worktree(&repo, path.as_deref(), &task.branch)
            } else {
                Ok(())
            };
            if rollback.is_ok() {
                // Nothing of the task is left on disk: do not keep a failed task around. The UI drops it from the list
                // (state "deleted") and the caller gets the error.
                task.worktree_path = None;
                task.port_start = None;
                task.uses_main_checkout = None;
                task.last_message = Some(error.to_string());
                task.state = Some("deleted".into());
                changed(&task);
                self.tasks().delete(&task.id)?;
                return Err(error);
            }
            task.last_message = Some(match rollback {
                Ok(()) => error.to_string(),
                Err(cleanup) => format!("{error}; rollback failed: {cleanup}"),
            });
            if path.as_ref().is_some_and(|p| !p.exists()) || !created {
                task.worktree_path = None;
            }
            task.port_start = None;
            self.save_state(&mut task, "error", &mut changed)?;
            return Err(error);
        }
        if input.run_setup && setup_state(&project) == SetupState::NeedsApproval {
            // Creation succeeds independently of setup execution. Keep the task and expose its id to the UI.
            task.last_message = Some("SetupNotApproved: setup script needs approval".into());
            self.tasks().update(&task)?;
            changed(&task);
            return Err(TaskError::SetupNotApproved { task_id: task.id });
        }
        Ok(task)
    }
    fn copy_task_files(&self, project: &Project, destination: &Path) -> Result<bool, TaskError> {
        let Some(json) = &project.copy_files else {
            return Ok(false);
        };
        // Files to copy come from this computer's checkout; an SSH project has none here.
        if remote::is_remote(destination) {
            return Ok(false);
        }
        self.validate_copy_json(json)?;
        let mut statement = self
            .conn
            .prepare("SELECT json_extract(value,'$.path'), json_extract(value,'$.mode') FROM json_each(?1)")
            .map_err(StoreError::from)?;
        let rows = statement
            .query_map([json], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(StoreError::from)?;
        let source_root = fs::canonicalize(&project.path)?;
        let target_root = fs::canonicalize(destination)?;
        let mut fallback = false;
        for row in rows {
            let (relative, mode) = row.map_err(StoreError::from)?;
            // Treat both separator styles portably after lexical validation.
            let relative = relative.replace('\\', "/");
            let source = fs::canonicalize(source_root.join(&relative))?;
            if !source.starts_with(&source_root) {
                return Err(TaskError::Invalid("copy source escapes project".into()));
            }
            let target = target_root.join(&relative);
            ensure_safe_parent(&target_root, &target)?;
            if target.symlink_metadata().is_ok() {
                return Err(TaskError::Invalid(format!(
                    "copy destination already exists: {relative}"
                )));
            }
            if mode == "symlink" {
                #[cfg(target_os = "macos")]
                {
                    std::os::unix::fs::symlink(&source, &target)?;
                }
                #[cfg(windows)]
                {
                    let result = if source.is_dir() {
                        std::os::windows::fs::symlink_dir(&source, &target)
                    } else {
                        std::os::windows::fs::symlink_file(&source, &target)
                    };
                    if let Err(error) = result {
                        if error.kind() != std::io::ErrorKind::PermissionDenied && error.raw_os_error() != Some(1314) {
                            return Err(error.into());
                        }
                        copy_tree(&source, &target, &source_root)?;
                        fallback = true;
                    }
                }
                #[cfg(not(any(target_os = "macos", windows)))]
                {
                    return Err(TaskError::Invalid("unsupported platform".into()));
                }
            } else {
                copy_tree(&source, &target, &source_root)?;
            }
        }
        // On macOS this remains false; Windows may fall back from symlinks.
        let _ = &mut fallback;
        Ok(fallback)
    }
    /// Archive preserves all files and releases the task's port allocation.
    pub fn task_archive_record(&self, id: &str, mut changed: impl FnMut(&Task)) -> Result<Task, TaskError> {
        let mut task = self.task_get(id)?;
        if task.state.as_deref() == Some("deleted") {
            return Err(TaskError::Invalid("task is deleted".into()));
        }
        task.archived_at = Some(now_seconds());
        task.port_start = None;
        self.save_state(&mut task, "archived", &mut changed)?;
        Ok(task)
    }
    /// Restore an archived task with a newly available port block.
    pub fn task_restore_record(&self, id: &str, mut changed: impl FnMut(&Task)) -> Result<Task, TaskError> {
        let mut task = self.task_get(id)?;
        if task.state.as_deref() != Some("archived") {
            return Err(TaskError::Invalid("task is not archived".into()));
        }
        if task.uses_main_checkout.is_none() {
            return Err(TaskError::Invalid("failed creation has no checkout to restore".into()));
        }
        if matches!(task.uses_main_checkout, Some(0 | 2 | 3))
            && !task
                .worktree_path
                .as_deref()
                .is_some_and(|p| remote::is_remote(p) || Path::new(p).is_dir())
        {
            return Err(TaskError::Invalid("task worktree is missing".into()));
        }
        let project = self.project_for_task(&task)?;
        task.port_start = Some(i64::from(self.free_ports(&project, id)?));
        task.archived_at = None;
        self.save_state(&mut task, "active", &mut changed)?;
        Ok(task)
    }
    /// Rename a task without changing its branch, slug or worktree path.
    pub fn task_rename_record(
        &self,
        id: &str,
        name: String,
        mut changed: impl FnMut(&Task),
    ) -> Result<Task, TaskError> {
        if name.trim().is_empty() {
            return Err(TaskError::Invalid("empty task name".into()));
        }
        let mut task = self.task_get(id)?;
        task.name = name;
        task.updated_at = Some(now_seconds());
        self.tasks().update(&task)?;
        changed(&task);
        Ok(task)
    }
    /// Delete only an owned worktree/branch, with explicit confirmation for data loss.
    /// Main-checkout tasks never remove files or branches, regardless of confirmation.
    pub fn task_delete_record(&self, id: &str, confirm: bool, changed: impl FnMut(&Task)) -> Result<(), TaskError> {
        self.task_delete_record_with(id, confirm, changed, |_| {})
    }
    /// [`Self::task_delete_record`], calling `before_remove` with the worktree path once every data-loss check has
    /// passed and right before `git worktree remove`. The caller stops whatever keeps the folder busy there (the
    /// task's shells and file watcher: Windows cannot remove a folder that a process uses as its cwd).
    pub fn task_delete_record_with(
        &self,
        id: &str,
        confirm: bool,
        mut changed: impl FnMut(&Task),
        before_remove: impl FnOnce(&Path),
    ) -> Result<(), TaskError> {
        let mut task = self.task_get(id)?;
        if task.state.as_deref() == Some("deleted") {
            return Ok(());
        }
        if matches!(task.uses_main_checkout, Some(0 | 2)) {
            let project = self.project_for_task(&task)?;
            let repo = Repo::open(&project.path)?;
            let owns_branch = task.uses_main_checkout == Some(0);
            if owns_branch && !task.branch.starts_with("tessera/") {
                return Err(TaskError::Invalid("task branch is not owned".into()));
            }
            let branch_exists = owns_branch && tessera_git::branch_exists(&repo.root, &task.branch)?;
            if branch_exists {
                let commits = tessera_git::branch_unmerged_commits(&repo.root, &task.branch, &task.base_branch)?;
                if !confirm && !commits.is_empty() {
                    return Err(TaskError::UnmergedCommits { list: commits });
                }
            }
            if let Some(path) = &task.worktree_path {
                let path = Path::new(path);
                let on_host = remote::is_remote(path);
                if if on_host { remote::exists(path)? } else { path.exists() } {
                    let entries = tessera_git::worktree_list(&repo.root)?;
                    let owned = if on_host {
                        !remote::same(path, &repo.root)
                            && entries.iter().any(|w| {
                                w.branch.as_deref() == Some(&format!("refs/heads/{}", task.branch))
                                    && remote::same(Path::new(&w.path), path)
                            })
                    } else {
                        let canonical = fs::canonicalize(path)?;
                        canonical != fs::canonicalize(&repo.root)?
                            && entries.iter().any(|w| {
                                w.branch.as_deref() == Some(&format!("refs/heads/{}", task.branch))
                                    && fs::canonicalize(&w.path).ok().as_ref() == Some(&canonical)
                            })
                    };
                    if !owned {
                        return Err(TaskError::Invalid("worktree ownership does not match task".into()));
                    }
                    if !confirm && !tessera_git::status(path)?.files.is_empty() {
                        return Err(TaskError::DirtyWorktree);
                    }
                    before_remove(path);
                    tessera_git::worktree_remove(&repo, path, confirm)?;
                    task.worktree_path = None;
                    self.tasks().update(&task)?;
                }
            }
            if branch_exists && let Err(error) = tessera_git::branch_delete(&repo, &task.branch, confirm) {
                task.last_message = Some(error.to_string());
                task.port_start = None;
                self.save_state(&mut task, "error", &mut changed)?;
                return Err(error.into());
            }
        }
        task.port_start = None;
        self.save_state(&mut task, "deleted", &mut changed)?;
        Ok(())
    }
}
fn rollback_worktree(repo: &Repo, path: Option<&Path>, branch: &str) -> Result<(), TaskError> {
    if let Some(path) = path {
        tessera_git::worktree_remove(repo, path, true)?;
    }
    if tessera_git::branch_exists(&repo.root, branch)? {
        tessera_git::branch_delete(repo, branch, true)?;
    }
    Ok(())
}
fn ensure_safe_parent(root: &Path, target: &Path) -> Result<(), TaskError> {
    let parent = target
        .parent()
        .ok_or_else(|| TaskError::Invalid("invalid target".into()))?;
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| TaskError::Invalid("target escapes worktree".into()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if current.symlink_metadata().is_ok() {
            if !current.is_dir() || !fs::canonicalize(&current)?.starts_with(root) {
                return Err(TaskError::Invalid("target parent escapes worktree".into()));
            }
        } else {
            fs::create_dir(&current)?;
        }
    }
    Ok(())
}
fn copy_tree(source: &Path, target: &Path, root: &Path) -> Result<(), TaskError> {
    // Never follow nested symlinks: a directory fixture cannot copy arbitrary user files or loop.
    let metadata = source.symlink_metadata()?;
    if metadata.file_type().is_symlink() || !fs::canonicalize(source)?.starts_with(root) {
        return Err(TaskError::Invalid("nested copy symlink rejected".into()));
    }
    if metadata.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()), root)?;
        }
    } else if metadata.is_file() {
        fs::copy(source, target)?;
    } else {
        return Err(TaskError::Invalid("copy source is not a regular file".into()));
    }
    Ok(())
}

#[cfg(test)]
mod persistence_failure_tests {
    use super::*;
    #[test]
    fn active_state_write_failure_rolls_back_worktree_and_records_error() {
        use std::process::Command;
        if Command::new("git").arg("--version").output().is_err() {
            eprintln!("skip: git missing");
            return;
        }
        let temp = tempfile::tempdir().expect("temp");
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).expect("dir");
        for args in [
            vec!["init", "-b", "main"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        ] {
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(&repo)
                    .args(args)
                    .output()
                    .expect("git")
                    .status
                    .success()
            );
        }
        let store = Store::open(&crate::DataDirs::from_root(temp.path().join("data"))).expect("store");
        let project = store.project_add_local(&repo, temp.path()).expect("project");
        store.conn.execute_batch("CREATE TRIGGER fail_active BEFORE UPDATE ON tasks WHEN NEW.state='active' BEGIN SELECT RAISE(FAIL,'fixture failure'); END;").expect("trigger");
        assert!(
            store
                .task_create_record(
                    CreateTask {
                        project_id: project.id,
                        name: Some("rollback".into()),
                        prompt: None,
                        base_branch: "main".into(),
                        existing_branch: None,
                        branch_name: None,
                        use_main_checkout: false,
                        run_setup: false
                    },
                    |_| {}
                )
                .is_err()
        );
        // A failed creation leaves no task behind, and no worktree or branch either.
        assert!(store.tasks().list().expect("list").is_empty());
        assert!(!tessera_git::branch_exists(&repo, "tessera/rollback").expect("branch"));
    }
}
