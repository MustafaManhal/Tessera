//! Project operations and setup approval, independent of the desktop IPC edge.
use crate::{
    Store, StoreError,
    repositories::{Project, new_id, now_seconds},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

/// Project operation failure.
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    /// The selected directory is not a repository; an existing folder can be initialized.
    #[error("not a git repository (can_init={can_init})")]
    NotAGitRepo {
        /// Whether initialization can be offered.
        can_init: bool,
    },
    /// The canonical repository path has already been added.
    #[error("project already added")]
    AlreadyAdded,
    /// Identifier was not found.
    #[error("unknown project")]
    NotFound,
    /// SQLite rejected an operation.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// Git failed.
    #[error(transparent)]
    Git(#[from] tessera_git::GitError),
    /// An unsafe copy specification was supplied.
    #[error("invalid copy file")]
    InvalidCopyFile,
    /// Filesystem or subprocess failure.
    #[error("project I/O: {0}")]
    Io(#[from] std::io::Error),
    /// A clone exceeded its deadline or was explicitly cancelled.
    #[error("clone cancelled or timed out")]
    CloneCancelled,
    /// Git rejected initialization or clone.
    #[error("git failed: {0}")]
    CommandFailed(String),
}
impl ProjectError {
    /// Stable code for IPC mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotAGitRepo { .. } => "project.not_a_git_repo",
            Self::AlreadyAdded => "project.already_added",
            Self::NotFound => "project.not_found",
            Self::Store(_) => "project.store_failed",
            Self::Git(e) => e.code(),
            Self::InvalidCopyFile => "project.invalid_copy_file",
            Self::Io(_) => "project.io",
            Self::CloneCancelled => "project.clone_cancelled",
            Self::CommandFailed(_) => "project.git_failed",
        }
    }
}
/// A file to transfer into a task worktree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopyFile {
    /// Portable relative path inside the repository.
    pub path: String,
    /// Either `copy` or `symlink`.
    pub mode: String,
}
/// Reject traversal on both Windows and Unix, regardless of the current host.
pub fn validate_copy_files(files: &[CopyFile]) -> Result<(), ProjectError> {
    for file in files {
        if !matches!(file.mode.as_str(), "copy" | "symlink")
            || file.path.is_empty()
            || file.path.contains([':', '\0'])
            || file.path.starts_with(['/', '\\'])
            || file.path.split(['/', '\\']).any(|part| part == "..")
            || Path::new(&file.path)
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(ProjectError::InvalidCopyFile);
        }
    }
    Ok(())
}
/// Current approval requirement for a project's setup script.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SetupState {
    /// No setup script is configured.
    None,
    /// Exact current script and shell have been approved.
    Approved,
    /// Approval is required before executing anything.
    NeedsApproval,
}
/// Hash the exact shell and script bytes; whitespace changes are significant.
pub fn setup_hash(shell: &str, script: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(shell.as_bytes());
    hash.update([0]);
    hash.update(script.as_bytes());
    hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}
/// Compute approval without executing the script.
pub fn setup_state(project: &Project) -> SetupState {
    let Some(script) = project.setup_script.as_deref().filter(|s| !s.is_empty()) else {
        return SetupState::None;
    };
    if project.setup_approved_hash.as_deref()
        == Some(setup_hash(project.setup_shell.as_deref().unwrap_or(""), script).as_str())
    {
        SetupState::Approved
    } else {
        SetupState::NeedsApproval
    }
}
impl Store {
    /// Add a local git repository. Worktrees default under the supplied app-data root.
    pub fn project_add_local(&self, path: &Path, app_data: &Path) -> Result<Project, ProjectError> {
        let repo = tessera_git::Repo::open(path).map_err(|e| match e {
            tessera_git::GitError::NotAGitRepo => ProjectError::NotAGitRepo {
                can_init: path.is_dir(),
            },
            other => ProjectError::Git(other),
        })?;
        let path = repo.root.to_string_lossy().into_owned();
        if self.projects().list()?.iter().any(|p| p.path == path) {
            return Err(ProjectError::AlreadyAdded);
        }
        let id = new_id();
        let now = now_seconds();
        let project = Project {
            name: repo.root.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            path,
            remote_url: repo.remote_url,
            default_branch: repo.default_branch.or(repo.branch).unwrap_or_else(|| "main".into()),
            worktree_dir: Some(app_data.join("worktrees").join(&id).to_string_lossy().into_owned()),
            id,
            setup_script: None,
            setup_shell: None,
            setup_approved_hash: None,
            copy_files: None,
            port_base: None,
            default_profile_id: None,
            is_muted: Some(0),
            sort: Some(0),
            ssh_host_id: None,
            created_at: Some(now),
            updated_at: Some(now),
        };
        self.projects().insert(&project)?;
        Ok(project)
    }
    /// Add a repository on an SSH host (M10.2). The caller opened `repo` over ssh without holding the store, and
    /// chose the remote worktree root (an `ssh://` path).
    pub fn project_add_remote(
        &self,
        repo: &tessera_git::Repo,
        ssh_host_id: &str,
        worktree_root: &str,
    ) -> Result<Project, ProjectError> {
        let path = repo.root.to_string_lossy().into_owned();
        if self.projects().list()?.iter().any(|p| p.path == path) {
            return Err(ProjectError::AlreadyAdded);
        }
        let id = new_id();
        let now = now_seconds();
        let project = Project {
            name: repo.root.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            path,
            remote_url: repo.remote_url.clone(),
            default_branch: repo
                .default_branch
                .clone()
                .or_else(|| repo.branch.clone())
                .unwrap_or_else(|| "main".into()),
            worktree_dir: Some(
                tessera_git::remote::join(Path::new(worktree_root), &id)
                    .to_string_lossy()
                    .into_owned(),
            ),
            id,
            setup_script: None,
            setup_shell: None,
            setup_approved_hash: None,
            copy_files: None,
            port_base: None,
            default_profile_id: None,
            is_muted: Some(0),
            sort: Some(0),
            ssh_host_id: Some(ssh_host_id.to_owned()),
            created_at: Some(now),
            updated_at: Some(now),
        };
        self.projects().insert(&project)?;
        Ok(project)
    }
    /// Initialize a selected existing folder without touching user git configuration.
    pub fn project_git_init(path: &Path) -> Result<(), ProjectError> {
        let output = std::process::Command::new("git")
            .arg("init")
            .arg("--")
            .arg(path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()?;
        if !output.status.success() {
            return Err(ProjectError::CommandFailed(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ));
        }
        Ok(())
    }
    /// Clone into a new chosen destination, with a ten-minute deadline and cancellation.
    /// Partial output is retained on failure for the caller to inspect; it is never registered.
    pub fn project_clone(
        &self,
        url: &str,
        destination: &Path,
        app_data: &Path,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<Project, ProjectError> {
        self.project_clone_with_timeout(url, destination, app_data, cancel, std::time::Duration::from_secs(600))
    }
    fn project_clone_with_timeout(
        &self,
        url: &str,
        destination: &Path,
        app_data: &Path,
        cancel: &std::sync::atomic::AtomicBool,
        timeout: std::time::Duration,
    ) -> Result<Project, ProjectError> {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) || timeout.is_zero() {
            return Err(ProjectError::CloneCancelled);
        }
        let mut command = std::process::Command::new("git");
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .args(["clone", "--quiet", "--", url])
            .arg(destination)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    return Err(ProjectError::CommandFailed(format!("clone exited {status}")));
                }
                return self.project_add_local(destination, app_data);
            }
            if cancel.load(std::sync::atomic::Ordering::Relaxed) || std::time::Instant::now() >= deadline {
                #[cfg(target_os = "macos")]
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-KILL", &format!("-{}", child.id())])
                    .status();
                #[cfg(windows)]
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .status();
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProjectError::CloneCancelled);
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    /// Replace project metadata after validating copy-file JSON; immutable identity is preserved.
    /// Script or shell changes clear the saved approval even if later reverted.
    pub fn project_update_record(&self, mut project: Project) -> Result<Project, ProjectError> {
        let previous = self.projects().get(&project.id)?.ok_or(ProjectError::NotFound)?;
        project.path = previous.path;
        project.created_at = previous.created_at;
        if let Some(json) = &project.copy_files {
            self.validate_copy_json(json)?;
        }
        project.setup_approved_hash =
            if project.setup_script == previous.setup_script && project.setup_shell == previous.setup_shell {
                previous.setup_approved_hash
            } else {
                None
            };
        project.updated_at = Some(now_seconds());
        self.projects().update(&project)?;
        Ok(project)
    }
    /// Remove project database records, leaving every worktree on disk; return retained-worktree count.
    pub fn project_remove_record(&self, id: &str) -> Result<usize, ProjectError> {
        if self.projects().get(id)?.is_none() {
            return Err(ProjectError::NotFound);
        }
        let tx = self.conn.unchecked_transaction().map_err(StoreError::from)?;
        let count: i64 = tx
            .query_row(
                "SELECT count(*) FROM tasks WHERE project_id=?1 AND worktree_path IS NOT NULL",
                [id],
                |r| r.get(0),
            )
            .map_err(StoreError::from)?;
        tx.execute("DELETE FROM tasks WHERE project_id=?1", [id])
            .map_err(StoreError::from)?;
        tx.execute("DELETE FROM task_groups WHERE project_id=?1", [id])
            .map_err(StoreError::from)?;
        tx.execute("DELETE FROM projects WHERE id=?1", [id])
            .map_err(StoreError::from)?;
        tx.commit().map_err(StoreError::from)?;
        Ok(usize::try_from(count).unwrap_or(usize::MAX))
    }
    /// Validate JSON with SQLite's built-in JSON parser, without another dependency.
    pub fn validate_copy_json(&self, json: &str) -> Result<(), ProjectError> {
        let valid: bool = self
            .conn
            .query_row("SELECT json_valid(?1)", [json], |r| r.get(0))
            .map_err(StoreError::from)?;
        if !valid {
            return Err(ProjectError::InvalidCopyFile);
        }
        let kind: String = self
            .conn
            .query_row("SELECT json_type(?1)", [json], |r| r.get(0))
            .map_err(StoreError::from)?;
        if kind != "array" {
            return Err(ProjectError::InvalidCopyFile);
        }
        let mut statement = self.conn.prepare("SELECT json_type(value), json_extract(value,'$.path'), json_extract(value,'$.mode') FROM json_each(?1)").map_err(StoreError::from)?;
        let rows = statement
            .query_map([json], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(StoreError::from)?;
        for row in rows {
            let (kind, path, mode) = row.map_err(|_| ProjectError::InvalidCopyFile)?;
            let (Some(path), Some(mode)) = (path, mode) else {
                return Err(ProjectError::InvalidCopyFile);
            };
            if kind != "object" {
                return Err(ProjectError::InvalidCopyFile);
            }
            validate_copy_files(&[CopyFile { path, mode }])?;
        }
        Ok(())
    }
    /// Approve the exact current script, without running it.
    pub fn project_approve_setup(&self, id: &str) -> Result<Project, ProjectError> {
        let mut project = self.projects().get(id)?.ok_or(ProjectError::NotFound)?;
        project.setup_approved_hash = project
            .setup_script
            .as_ref()
            .map(|s| setup_hash(project.setup_shell.as_deref().unwrap_or(""), s));
        project.updated_at = Some(now_seconds());
        self.projects().update(&project)?;
        Ok(project)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DataDirs;
    #[test]
    fn local_project_duplicate_approval_and_invalid_folder() {
        let temp = tempfile::tempdir().expect("temp");
        let repo = temp.path().join("repo");
        std::fs::create_dir(&repo).expect("dir");
        if std::process::Command::new("git").arg("--version").output().is_err() {
            eprintln!("skip: git missing");
            return;
        }
        assert!(
            std::process::Command::new("git")
                .arg("init")
                .arg(&repo)
                .status()
                .expect("git")
                .success()
        );
        let store = Store::open(&DataDirs::from_root(temp.path().join("data"))).expect("store");
        let mut project = store.project_add_local(&repo, temp.path()).expect("add");
        assert!(matches!(
            store.project_add_local(&repo, temp.path()),
            Err(ProjectError::AlreadyAdded)
        ));
        assert!(matches!(
            store.project_add_local(&temp.path().join("data"), temp.path()),
            Err(ProjectError::NotAGitRepo { can_init: true })
        ));
        assert_eq!(setup_state(&project), SetupState::None);
        project.setup_script = Some("echo hi".into());
        project.setup_shell = Some("bash".into());
        store.projects().update(&project).expect("update");
        let mut approved = store.project_approve_setup(&project.id).expect("approve");
        assert_eq!(setup_state(&approved), SetupState::Approved);
        approved.setup_script = Some("echo hi ".into());
        assert_eq!(setup_state(&approved), SetupState::NeedsApproval);
        approved.setup_script = Some("echo bye".into());
        assert_eq!(setup_state(&approved), SetupState::NeedsApproval);
    }
    #[test]
    fn clone_update_json_and_remove_keep_disk() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("source.git");
        if std::process::Command::new("git").arg("--version").output().is_err() {
            eprintln!("skip: git missing");
            return;
        }
        assert!(
            std::process::Command::new("git")
                .args(["init", "--bare"])
                .arg(&source)
                .status()
                .expect("git")
                .success()
        );
        let dirs = crate::DataDirs::from_root(temp.path().join("data"));
        let store = Store::open(&dirs).expect("store");
        let destination = temp.path().join("clone");
        let mut project = store
            .project_clone(
                source.to_str().expect("path"),
                &destination,
                temp.path(),
                &std::sync::atomic::AtomicBool::new(false),
            )
            .expect("clone");
        for json in [
            "null",
            "{}",
            "not json",
            "[{}]",
            r#"[{"path":"../x","mode":"copy"}]"#,
            r#"[{"path":"x","mode":"run"}]"#,
        ] {
            assert!(store.validate_copy_json(json).is_err(), "{json}");
        }
        store
            .validate_copy_json(r#"[{"path":".env","mode":"copy"}]"#)
            .expect("valid");
        project.setup_script = Some("echo hi".into());
        project = store.project_update_record(project).expect("update");
        project = store.project_approve_setup(&project.id).expect("approve");
        project.setup_script = Some("echo hi ".into());
        project = store.project_update_record(project).expect("changed");
        assert_eq!(project.setup_approved_hash, None);
        assert_eq!(store.project_remove_record(&project.id).expect("remove"), 0);
        assert!(destination.is_dir());
        assert!(store.projects().list().expect("list").is_empty());
        let init = temp.path().join("init");
        std::fs::create_dir(&init).expect("dir");
        Store::project_git_init(&init).expect("init");
        assert!(tessera_git::Repo::open(init).is_ok());
    }
    #[test]
    fn cancelled_or_expired_clone_never_creates_a_destination() {
        let temp = tempfile::tempdir().expect("temp");
        let store = Store::open(&crate::DataDirs::from_root(temp.path().join("data"))).expect("store");
        let destination = temp.path().join("never-cloned");
        assert!(matches!(
            store.project_clone(
                "invalid",
                &destination,
                temp.path(),
                &std::sync::atomic::AtomicBool::new(true)
            ),
            Err(ProjectError::CloneCancelled)
        ));
        assert!(matches!(
            store.project_clone_with_timeout(
                "invalid",
                &destination,
                temp.path(),
                &std::sync::atomic::AtomicBool::new(false),
                std::time::Duration::ZERO
            ),
            Err(ProjectError::CloneCancelled)
        ));
        assert!(!destination.exists());
    }
    #[test]
    fn unsafe_paths_and_modes_are_rejected() {
        for path in ["../x", "/x", "C:\\x", "a/../../x", "a\\..\\x", "\\\\host\\file", ""] {
            assert!(
                validate_copy_files(&[CopyFile {
                    path: path.into(),
                    mode: "copy".into()
                }])
                .is_err()
            );
        }
        assert!(
            validate_copy_files(&[CopyFile {
                path: "a/b".into(),
                mode: "copy".into()
            }])
            .is_ok()
        );
        assert!(
            validate_copy_files(&[CopyFile {
                path: "a".into(),
                mode: "execute".into()
            }])
            .is_err()
        );
        assert_ne!(setup_hash("ab", "c"), setup_hash("a", "bc"));
    }
}
