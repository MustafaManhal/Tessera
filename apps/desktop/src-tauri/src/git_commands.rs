//! Git commands (FR-26, FR-27, FR-31). Thin wrappers over `tessera-git`; the git CLI calls are blocking, so every
//! command runs on Tauri's blocking pool through `async` + `spawn_blocking`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;
use tessera_git::{GitError, Repo};

use crate::error::AppError;

impl From<GitError> for AppError {
    fn from(error: GitError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

/// Repository facts for the project list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RepoInfo {
    /// Absolute repository root.
    pub root: String,
    /// Current branch; `None` for a detached HEAD.
    pub branch: Option<String>,
    /// The default branch (origin HEAD, `main`, `master`, or the first branch).
    pub default_branch: Option<String>,
    /// Fetch URL of `origin`, if any.
    pub remote_url: Option<String>,
    /// True for a bare repository.
    pub bare: bool,
}

/// One file in a worktree status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StatusFile {
    /// Path relative to the worktree root.
    pub path: String,
    /// The previous path for a rename.
    pub original_path: Option<String>,
    /// Staged change, one letter (`M`, `A`, `D`, `R`, `.`).
    pub index: String,
    /// Unstaged change, one letter.
    pub worktree: String,
    /// Has staged changes.
    pub staged: bool,
    /// Has unstaged changes.
    pub unstaged: bool,
    /// Not tracked.
    pub untracked: bool,
    /// Renamed.
    pub renamed: bool,
    /// Has a merge conflict.
    pub conflicted: bool,
}

/// A worktree status: branch, tracking counts and files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GitStatus {
    /// Current branch, `None` when detached.
    pub branch: Option<String>,
    /// Upstream branch, if set.
    pub upstream: Option<String>,
    /// Commits ahead of upstream.
    pub ahead: u32,
    /// Commits behind upstream.
    pub behind: u32,
    /// Changed, staged and untracked files.
    pub files: Vec<StatusFile>,
}

/// One entry of `git worktree list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorktreeInfo {
    /// Absolute path.
    pub path: String,
    /// HEAD commit id.
    pub head: Option<String>,
    /// Checked-out branch.
    pub branch: Option<String>,
    /// The main bare entry.
    pub bare: bool,
    /// Detached HEAD.
    pub detached: bool,
    /// Lock reason, when locked.
    pub locked: Option<String>,
    /// Prune reason, when prunable.
    pub prunable: Option<String>,
}

fn clamp(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

impl From<Repo> for RepoInfo {
    fn from(repo: Repo) -> Self {
        Self {
            root: repo.root.to_string_lossy().into_owned(),
            branch: repo.branch,
            default_branch: repo.default_branch,
            remote_url: repo.remote_url,
            bare: repo.bare,
        }
    }
}

impl From<tessera_git::Status> for GitStatus {
    fn from(status: tessera_git::Status) -> Self {
        Self {
            branch: status.branch,
            upstream: status.upstream,
            ahead: clamp(status.ahead),
            behind: clamp(status.behind),
            files: status
                .files
                .into_iter()
                .map(|file| StatusFile {
                    path: file.path,
                    original_path: file.original_path,
                    index: file.index.to_string(),
                    worktree: file.worktree.to_string(),
                    staged: file.staged,
                    unstaged: file.unstaged,
                    untracked: file.untracked,
                    renamed: file.renamed,
                    conflicted: file.conflicted,
                })
                .collect(),
        }
    }
}

impl From<tessera_git::Worktree> for WorktreeInfo {
    fn from(tree: tessera_git::Worktree) -> Self {
        Self {
            path: tree.path,
            head: tree.head,
            branch: tree.branch,
            bare: tree.bare,
            detached: tree.detached,
            locked: tree.locked,
            prunable: tree.prunable,
        }
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, GitError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::new("git.io", format!("the git task failed: {error}")))?
        .map_err(AppError::from)
}

/// Repository facts for a folder inside a repo (error `git.not_a_repo` otherwise).
#[tauri::command]
#[specta::specta]
pub async fn git_repo_info(path: String) -> Result<RepoInfo, AppError> {
    blocking(move || Repo::open(PathBuf::from(path)).map(RepoInfo::from)).await
}

/// Local branches, then remote-tracking branches, of the repository at `path`.
#[tauri::command]
#[specta::specta]
pub async fn git_branches(path: String) -> Result<Vec<String>, AppError> {
    blocking(move || tessera_git::branch_list(&PathBuf::from(path))).await
}

/// Status of the worktree at `path`.
#[tauri::command]
#[specta::specta]
pub async fn git_status(path: String) -> Result<GitStatus, AppError> {
    blocking(move || tessera_git::status(&PathBuf::from(path)).map(GitStatus::from)).await
}

/// All worktrees of the repository at `path`.
#[tauri::command]
#[specta::specta]
pub async fn worktree_list(path: String) -> Result<Vec<WorktreeInfo>, AppError> {
    blocking(move || {
        tessera_git::worktree_list(&PathBuf::from(path)).map(|trees| {
            trees
                .into_iter()
                // A registration whose folder is gone (a deleted copy, another app's cleanup) is not a checkout.
                .filter(|tree| {
                    tessera_git::remote::is_remote(std::path::Path::new(&tree.path))
                        || std::path::Path::new(&tree.path).exists()
                })
                .map(WorktreeInfo::from)
                .collect()
        })
    })
    .await
}

/// A worktree with what the worktrees manager shows about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorktreeDetail {
    /// Absolute path.
    pub path: String,
    /// Checked-out branch (short name).
    pub branch: Option<String>,
    /// Short HEAD commit id.
    pub head: Option<String>,
    /// Detached HEAD.
    pub detached: bool,
    /// The project folder itself.
    pub is_main: bool,
    /// Git lists it but its folder is gone.
    pub missing: bool,
    /// Lock reason, when locked.
    pub locked: Option<String>,
    /// Uncommitted changes (false when unknown or missing).
    pub dirty: bool,
    /// The remote branch with this branch's name (`origin/x`); none means the branch exists only on this computer.
    pub remote_branch: Option<String>,
}

/// Every worktree of the repository at `path`, with its state. Worktrees are local: git never sends them to a remote,
/// only their branches can be pushed.
#[tauri::command]
#[specta::specta]
pub async fn worktree_details(path: String) -> Result<Vec<WorktreeDetail>, AppError> {
    blocking(move || {
        let repo = Repo::open(&path)?;
        let same = |a: &std::path::Path, b: &std::path::Path| {
            a == b
                || std::fs::canonicalize(a)
                    .ok()
                    .zip(std::fs::canonicalize(b).ok())
                    .is_some_and(|(x, y)| x == y)
        };
        let mut out = Vec::new();
        for tree in tessera_git::worktree_list(&repo.root)? {
            if tree.bare {
                continue;
            }
            let at = PathBuf::from(&tree.path);
            let remote = tessera_git::remote::is_remote(&at);
            let missing = !remote && !at.exists();
            let branch = tree
                .branch
                .as_deref()
                .map(|b| b.trim_start_matches("refs/heads/").to_owned());
            let dirty = !missing && tessera_git::status(&at).is_ok_and(|status| !status.files.is_empty());
            let remote_branch = match &branch {
                Some(name) => tessera_git::remote_branch_of(&repo.root, name).ok().flatten(),
                None => None,
            };
            out.push(WorktreeDetail {
                is_main: same(&at, &repo.root),
                path: tree.path,
                head: tree.head.map(|h| h.chars().take(7).collect()),
                detached: tree.detached,
                branch,
                missing,
                locked: tree.locked,
                dirty,
                remote_branch,
            });
        }
        Ok(out)
    })
    .await
}

/// Move a linked worktree to another folder. The project folder cannot be moved.
#[tauri::command]
#[specta::specta]
pub async fn worktree_move(project_path: String, worktree_path: String, new_path: String) -> Result<(), AppError> {
    blocking(move || {
        let repo = Repo::open(&project_path)?;
        let from = PathBuf::from(&worktree_path);
        if from == repo.root || std::fs::canonicalize(&from).ok() == std::fs::canonicalize(&repo.root).ok() {
            return Err(GitError::InvalidPath { path: from });
        }
        tessera_git::worktree_move(&repo, &from, &PathBuf::from(new_path))
    })
    .await
}

/// Detach a worktree from its branch: the folder and its files stay, the branch becomes free.
#[tauri::command]
#[specta::specta]
pub async fn worktree_unlink(project_path: String, worktree_path: String) -> Result<(), AppError> {
    blocking(move || {
        let repo = Repo::open(&project_path)?;
        let target = PathBuf::from(&worktree_path);
        let known = tessera_git::worktree_list(&repo.root)?
            .iter()
            .any(|tree| std::path::Path::new(&tree.path) == target);
        if !known || !target.exists() {
            return Err(GitError::InvalidPath { path: target });
        }
        tessera_git::worktree_detach(&target)
    })
    .await
}

/// Forget worktrees whose folder is gone.
#[tauri::command]
#[specta::specta]
pub async fn worktree_prune(project_path: String) -> Result<(), AppError> {
    blocking(move || {
        let repo = Repo::open(&project_path)?;
        tessera_git::prune(&repo)
    })
    .await
}

/// Remove a linked worktree of the repository at `project_path`. The project folder itself is never removed, and
/// git refuses a worktree with changes unless `force` is set. The branch stays.
#[tauri::command]
#[specta::specta]
pub async fn worktree_remove(project_path: String, worktree_path: String, force: bool) -> Result<(), AppError> {
    blocking(move || {
        let repo = Repo::open(&project_path)?;
        let target = PathBuf::from(&worktree_path);
        let same = |a: &std::path::Path, b: &std::path::Path| {
            a == b
                || std::fs::canonicalize(a)
                    .ok()
                    .zip(std::fs::canonicalize(b).ok())
                    .is_some_and(|(x, y)| x == y)
        };
        if same(&target, &repo.root) {
            return Err(GitError::InvalidPath { path: target });
        }
        let known = tessera_git::worktree_list(&repo.root)?
            .iter()
            .any(|tree| same(std::path::Path::new(&tree.path), &target));
        if !known {
            return Err(GitError::InvalidPath { path: target });
        }
        tessera_git::worktree_remove(&repo, &target, force)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_errors_keep_their_stable_codes() {
        assert_eq!(AppError::from(GitError::NotAGitRepo).code, "git.not_a_repo");
        assert_eq!(AppError::from(GitError::BranchExists).code, "git.branch_exists");
    }

    #[test]
    fn counts_are_clamped_to_u32() {
        assert_eq!(clamp(7), 7);
        assert_eq!(clamp(u64::MAX), u32::MAX);
    }

    #[test]
    fn opening_a_folder_outside_a_repo_is_not_a_repo() {
        let dir = tempfile::tempdir().expect("temp dir");
        let error = Repo::open(dir.path()).expect_err("not a repo");
        assert_eq!(AppError::from(error).code, "git.not_a_repo");
    }
}
