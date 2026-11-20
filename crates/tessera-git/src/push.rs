//! Push a task branch and merge it locally (FR-51). `run_with_timeout` routes `remote://` paths through
//! `remote::git`, so ssh projects use the same code path as local ones.

use crate::{GitError, run_with_timeout, status};
use std::path::Path;
use std::time::Duration;

const GIT_TIMEOUT: Duration = Duration::from_secs(120);

/// `git push -u origin <branch>` in the task worktree. The user's git credentials apply — no token
/// injection. Returns git's stdout; failures carry stderr in [`GitError::WorktreeFailed`].
pub fn push_branch(worktree: &Path, branch: &str) -> Result<String, GitError> {
    let out = run_with_timeout(worktree, ["push", "-u", "origin", branch], GIT_TIMEOUT)?;
    Ok(String::from_utf8_lossy(&out).trim().to_owned())
}

/// What `merge_local` reports back to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalMerge {
    /// True when the merge committed cleanly.
    pub merged: bool,
    /// Unmerged paths when the merge stopped on conflicts.
    pub conflicts: Vec<String>,
    /// The checked-out branch the merge landed on.
    pub branch: String,
}

/// Merge `branch` into `base` inside the project's main checkout. Refuses when the checkout is dirty or
/// not on `base`; conflicts come back as paths instead of an error so the UI can show them.
pub fn merge_local(main_checkout: &Path, base: &str, branch: &str) -> Result<LocalMerge, GitError> {
    let current = current_branch(main_checkout)?;
    if current != base {
        return Err(GitError::WorktreeFailed {
            stderr: format!("The main checkout is on {current}, not {base}. Check out {base} first."),
        });
    }
    let state = status(main_checkout)?;
    if !state.files.is_empty() {
        return Err(GitError::WorktreeFailed {
            stderr: "The main checkout has uncommitted changes; commit or stash them first.".into(),
        });
    }
    // A merge commit needs an identity. People who use git have one; a fresh machine may not, and the merge must not
    // fail for that: fall back to a neutral name for this one command (nothing is written to their git config).
    let has_identity = run_with_timeout(main_checkout, ["config", "user.email"], GIT_TIMEOUT)
        .map(|out| !out.is_empty())
        .unwrap_or(false);
    let mut args: Vec<&str> = Vec::new();
    if !has_identity {
        args.extend([
            "-c",
            "user.name=Tessera",
            "-c",
            "user.email=tessera@users.noreply.github.com",
        ]);
    }
    args.extend(["merge", "--no-ff", "--no-edit", "--", branch]);
    match run_with_timeout(main_checkout, args, GIT_TIMEOUT) {
        Ok(_) => Ok(LocalMerge {
            merged: true,
            conflicts: vec![],
            branch: current,
        }),
        Err(GitError::WorktreeFailed { stderr }) if stderr.contains("CONFLICT") || has_conflicts(main_checkout) => {
            Ok(LocalMerge {
                merged: false,
                conflicts: conflict_paths(main_checkout)?,
                branch: current,
            })
        }
        Err(error) => Err(error),
    }
}

fn current_branch(path: &Path) -> Result<String, GitError> {
    let out = run_with_timeout(path, ["rev-parse", "--abbrev-ref", "HEAD"], GIT_TIMEOUT)?;
    Ok(String::from_utf8_lossy(&out).trim().to_owned())
}

fn has_conflicts(path: &Path) -> bool {
    run_with_timeout(path, ["diff", "--name-only", "--diff-filter=U"], GIT_TIMEOUT)
        .map(|out| !out.is_empty())
        .unwrap_or(false)
}

fn conflict_paths(path: &Path) -> Result<Vec<String>, GitError> {
    let out = run_with_timeout(path, ["diff", "--name-only", "--diff-filter=U"], GIT_TIMEOUT)?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-b", "main"]);
        std::fs::write(main.join("file.txt"), "one\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-m", "init"]);
        (tmp, main)
    }

    fn worktree(tmp: &tempfile::TempDir, main: &Path, branch: &str) -> std::path::PathBuf {
        let wt = tmp.path().join(format!("wt-{}", branch.replace('/', "-")));
        git(main, &["worktree", "add", "-b", branch, wt.to_str().unwrap(), "main"]);
        wt
    }

    #[test]
    fn merge_local_clean_and_conflict() {
        let (tmp, main) = repo();
        let wt = worktree(&tmp, &main, "task-1");
        // Clean merge: task adds a file.
        std::fs::write(wt.join("task.txt"), "task\n").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-m", "task"]);
        let result = merge_local(&main, "main", "task-1").unwrap();
        assert!(result.merged);
        assert!(main.join("task.txt").exists());

        // Conflicting merge on a second branch.
        let wt2 = worktree(&tmp, &main, "task-2");
        std::fs::write(wt2.join("file.txt"), "two\n").unwrap();
        git(&wt2, &["add", "."]);
        git(&wt2, &["commit", "-m", "conflict"]);
        // Main moves forward with a different edit to the same file.
        std::fs::write(main.join("file.txt"), "main-side\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-m", "main edit"]);
        let result = merge_local(&main, "main", "task-2").unwrap();
        assert!(!result.merged);
        assert_eq!(result.conflicts, ["file.txt"]);
        // Abort so the repo is left clean for the dirty-check test.
        git(&main, &["merge", "--abort"]);
    }

    #[test]
    fn merge_local_refuses_dirty_and_wrong_branch() {
        let (tmp, main) = repo();
        let wt = worktree(&tmp, &main, "task-1");
        std::fs::write(wt.join("x.txt"), "x\n").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-m", "task"]);
        std::fs::write(main.join("dirty.txt"), "dirty\n").unwrap();
        let err = merge_local(&main, "main", "task-1").unwrap_err();
        assert!(err.to_string().contains("uncommitted"));
        std::fs::remove_file(main.join("dirty.txt")).unwrap();
        git(&main, &["checkout", "-b", "other"]);
        let err = merge_local(&main, "main", "task-1").unwrap_err();
        assert!(err.to_string().contains("other"));
    }
}
