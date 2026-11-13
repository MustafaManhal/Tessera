//! Git CLI operations for repository discovery and isolated task worktrees.
pub mod diff;
pub mod push;
pub use diff::{ReviewChangedFile, ReviewFileDiff, review_file_diff, review_files};
mod parse;
mod process;
#[path = "remote.rs"]
mod remote_base;
pub mod remote_stdin;
/// SSH operations, including the stdin extension, without modifying the base transport file.
pub mod remote {
    pub(crate) use crate::remote_base::git;
    pub use crate::remote_base::*;
    pub use crate::remote_stdin::git_stdin;
}
mod watch;
mod windows_path;
pub use parse::*;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
pub use watch::*;

/// A git operation failure with a stable application error code.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// Git could not be launched or a filesystem operation failed.
    #[error("git I/O: {0}")]
    Io(#[from] std::io::Error),
    /// Git exceeded the configured deadline and its child process was terminated.
    #[error("git command timed out after {timeout:?}")]
    Timeout {
        /// The deadline duration requested for this invocation.
        timeout: Duration,
    },
    /// The directory is not a repository.
    #[error("not a git repository")]
    NotAGitRepo,
    /// The requested task branch already exists.
    #[error("branch already exists")]
    BranchExists,
    /// The destination already exists, including a dangling symlink.
    #[error("destination path already exists")]
    PathExists,
    /// An unsafe task slug or worktree path spelling.
    #[error("invalid worktree path {}", path.display())]
    InvalidPath {
        /// The destination supplied to the worktree operation.
        path: PathBuf,
    },
    /// Git rejected an operation.
    #[error("git operation failed: {stderr}")]
    WorktreeFailed {
        /// Git's diagnostic output.
        stderr: String,
    },
    /// A reference argument could be interpreted as an option.
    #[error("invalid revision")]
    InvalidRevision,
    /// The filesystem watcher failed.
    #[error("watcher failed: {0}")]
    Watch(#[from] notify::Error),
    /// The SSH host of a remote repository could not be reached (M10.2).
    #[error("{message}")]
    Remote {
        /// What ssh reported, or why the host is unknown.
        message: String,
    },
}
impl GitError {
    /// Stable IPC error code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "git.io",
            Self::Timeout { .. } => "git.timeout",
            Self::NotAGitRepo => "git.not_a_repo",
            Self::BranchExists => "git.branch_exists",
            Self::PathExists => "git.path_exists",
            Self::InvalidPath { .. } => "git.invalid_path",
            Self::WorktreeFailed { .. } => "git.worktree_failed",
            Self::InvalidRevision => "git.invalid_revision",
            Self::Watch(_) => "git.watch_failed",
            Self::Remote { .. } => "ssh.remote_failed",
        }
    }
}
/// Default deadline per Git child invocation.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

fn run<I, S>(path: &Path, args: I) -> Result<Vec<u8>, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_with_timeout(path, args, DEFAULT_TIMEOUT)
}

/// Keeps a helper process from opening a console window on Windows (a no-op elsewhere). Every process Tessera starts
/// in the background goes through this, or each git call would flash a terminal.
pub trait NoWindow {
    /// Starts the process without a console window.
    fn no_window(&mut self) -> &mut Self;
}
impl NoWindow for Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

/// Run Git in a repository directory and return stdout within a caller-provided deadline.
/// Timeout terminates and reaps the Git child and returns `git.timeout`.
///
/// # Errors
/// Returns [`GitError::Timeout`] when the deadline expires, I/O errors for process failures,
/// or [`GitError::WorktreeFailed`] with Git's diagnostic for a nonzero exit status.
pub fn run_with_timeout<I, S>(path: &Path, args: I, timeout: Duration) -> Result<Vec<u8>, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    if let Some((alias, dir)) = remote::split(path) {
        return remote::git(&alias, &dir, args, timeout);
    }
    let mut command = Command::new("git");
    command.no_window();
    command.args(["--no-pager", "-c", "safe.bareRepository=all"]);
    #[cfg(windows)]
    let path = windows_path::git_path(path);
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    command
        .arg("-C")
        .arg(path)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0");
    let output = process::output(&mut command, timeout).inspect_err(|error| {
        if matches!(error, GitError::Timeout { .. }) {
            tracing::debug!(?timeout, "Git command timed out");
        }
    })?;
    if !output.status.success() {
        return Err(GitError::WorktreeFailed {
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    Ok(output.stdout)
}
fn line(path: &Path, args: &[&str]) -> Result<String, GitError> {
    Ok(String::from_utf8_lossy(&run(path, args)?)
        .trim_end_matches(['\r', '\n'])
        .to_owned())
}
fn optional_line(path: &Path, args: &[&str]) -> Result<Option<String>, GitError> {
    match line(path, args) {
        Ok(value) => Ok(Some(value)),
        Err(GitError::WorktreeFailed { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}
/// Checks a branch name the way `git check-ref-format --branch` does, in words a user can act on.
///
/// # Errors
/// A sentence saying what is wrong with the name.
pub fn check_branch_name(name: &str) -> Result<(), String> {
    let bad = |why: &str| Err(format!("The branch name \"{name}\" is not valid: {why}."));
    if name.is_empty() || name.len() > 200 {
        return bad("use between 1 and 200 characters");
    }
    if name.starts_with('-') || name.starts_with('/') || name.ends_with('/') || name.ends_with('.') {
        return bad("it cannot start with - or / or end with / or .");
    }
    if name.contains("..") || name.contains("//") || name.contains("@{") || name == "@" {
        return bad("it cannot contain .. or // or @{");
    }
    if name
        .chars()
        .any(|c| c.is_control() || c == ' ' || "~^:?*[\\".contains(c))
    {
        return bad("it cannot contain spaces or any of ~ ^ : ? * [ \\");
    }
    if name
        .split('/')
        .any(|part| part.starts_with('.') || part.ends_with(".lock"))
    {
        return bad("a part of it cannot start with . or end with .lock");
    }
    Ok(())
}
fn revision(value: &str) -> Result<(), GitError> {
    if value.is_empty() || value.starts_with('-') || value.contains('\0') {
        Err(GitError::InvalidRevision)
    } else {
        Ok(())
    }
}
/// Discovered repository metadata. A detached HEAD has no branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    /// Absolute worktree root, or git directory for a bare repository.
    pub root: PathBuf,
    /// Current symbolic branch, including the unborn branch.
    pub branch: Option<String>,
    /// Origin's default branch, main/master, or the first local branch.
    pub default_branch: Option<String>,
    /// Origin fetch URL, if configured.
    pub remote_url: Option<String>,
    /// Whether this repository has no working tree.
    pub bare: bool,
}
impl Repo {
    /// Discover a repository from any directory inside it.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, GitError> {
        let path = path.as_ref();
        let bare = match line(path, &["rev-parse", "--is-bare-repository"]) {
            Ok(v) => v == "true",
            Err(GitError::WorktreeFailed { .. }) => return Err(GitError::NotAGitRepo),
            Err(e) => return Err(e),
        };
        let printed = line(
            path,
            &["rev-parse", if bare { "--absolute-git-dir" } else { "--show-toplevel" }],
        )?;
        let root = PathBuf::from(remote::rebase(path, &printed).unwrap_or(printed));
        let branch = optional_line(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        let branches = line(path, &["for-each-ref", "--format=%(refname:short)", "refs/heads/"])?;
        let default_branch = optional_line(
            path,
            &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        )?
        .or_else(|| {
            ["main", "master"]
                .into_iter()
                .find(|b| branches.lines().any(|s| s == *b))
                .map(str::to_owned)
        })
        .or_else(|| branches.lines().next().map(str::to_owned));
        Ok(Self {
            root,
            branch,
            default_branch,
            remote_url: optional_line(path, &["remote", "get-url", "origin"])?,
            bare,
        })
    }
}
/// Turn a task name into a Unicode-safe branch slug of at most 48 characters.
pub fn slugify(name: &str) -> String {
    let mut result = String::new();
    let mut dash = false;
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            if dash && !result.is_empty() {
                result.push('-');
            }
            result.push(c);
            dash = false;
        } else {
            dash = true;
        }
    }
    let result = result
        .chars()
        .take(48)
        .collect::<String>()
        .trim_end_matches('-')
        .to_owned();
    if result.is_empty() {
        "task".into()
    } else if windows_path::reserved_component(&result) {
        format!("task-{result}")
    } else {
        result
    }
}
/// Find an unused slug, accepting either slugs or full tessera branch names.
pub fn unique_slug(name: &str, existing: &[String]) -> String {
    let base = slugify(name);
    let mut candidate = base.clone();
    let mut n = 2;
    while existing.iter().any(|s| {
        branch_names_match(s, &candidate, cfg!(windows))
            || branch_names_match(s, &format!("tessera/{candidate}"), cfg!(windows))
    }) {
        let suffix = format!("-{n}");
        candidate = format!(
            "{}{}",
            base.chars()
                .take(48 - suffix.len())
                .collect::<String>()
                .trim_end_matches('-'),
            suffix
        );
        n += 1;
    }
    candidate
}
/// Builds the on-disk path for a task slug below its worktree root.
/// On Windows it validates the full destination and stores Git-compatible spelling.
///
/// # Errors
/// Returns [`GitError::InvalidPath`] for an ambiguous Windows path or unsafe slug.
pub fn task_worktree_path(root: &Path, slug: &str) -> Result<PathBuf, GitError> {
    let path = root.join(slug);
    if slugify(slug) != slug {
        return Err(GitError::InvalidPath { path });
    }
    if remote::is_remote(root) {
        return Ok(remote::join(root, slug));
    }
    #[cfg(windows)]
    return Ok(windows_path::git_path(&windows_path::worktree_destination(&path)?));
    #[cfg(not(windows))]
    Ok(path)
}

/// Create a task branch and worktree from an existing revision.
pub fn worktree_add(repo: &Repo, branch: &str, path: &Path, base: &str) -> Result<(), GitError> {
    // A task name becomes `tessera/<slug>`.
    let branch = format!("tessera/{}", slugify(branch.strip_prefix("tessera/").unwrap_or(branch)));
    worktree_add_exact(repo, &branch, path, base)
}

/// Like [`worktree_add`], but the new branch gets exactly the name given (checked with [`check_branch_name`]).
///
/// # Errors
/// An invalid name, an existing branch or path, or Git's refusal.
pub fn worktree_add_exact(repo: &Repo, branch: &str, path: &Path, base: &str) -> Result<(), GitError> {
    revision(base)?;
    if remote::is_remote(&repo.root) {
        return remote_worktree_add(repo, branch, path, base);
    }
    let destination = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repo.root.join(path)
    };
    #[cfg(windows)]
    let destination = windows_path::worktree_destination(&destination)?;
    let path = destination.as_path();
    #[cfg(windows)]
    let git_destination = windows_path::git_path(path);
    #[cfg(not(windows))]
    let git_destination = path;
    let branch = branch.to_owned();
    check_branch_name(&branch).map_err(|_| GitError::InvalidRevision)?;
    if branch_exists(&repo.root, &branch)? {
        return Err(GitError::BranchExists);
    }
    match path.symlink_metadata() {
        Ok(_) => return Err(GitError::PathExists),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    // Reserve the branch atomically before attaching the worktree. A failed `-b` add
    // can leave a branch behind; separate creation lets us prove cleanup ownership.
    if let Err(error) = run(&repo.root, ["branch", "--", &branch, base]) {
        if matches!(error, GitError::Timeout { .. }) {
            return Err(error);
        }
        if branch_exists(&repo.root, &branch)? {
            return Err(GitError::BranchExists);
        }
        return Err(error);
    }
    let added = run(
        &repo.root,
        [
            OsStr::new("worktree"),
            OsStr::new("add"),
            OsStr::new("--"),
            git_destination.as_os_str(),
            OsStr::new(&branch),
        ],
    );
    if let Err(error) = added {
        // Only remove a registered worktree whose branch and canonical path match.
        // Never delete an unrelated destination that appeared in the meantime.
        let cleanup = (|| -> Result<(), GitError> {
            let registered = worktree_list(&repo.root)?.iter().any(|w| {
                w.branch.as_deref() == Some(&format!("refs/heads/{branch}"))
                    && std::fs::canonicalize(&w.path)
                        .ok()
                        .zip(std::fs::canonicalize(path).ok())
                        .is_some_and(|(a, b)| a == b)
            });
            if registered {
                worktree_remove(repo, path, true)?;
            }
            branch_delete(repo, &branch, true)?;
            Ok(())
        })();
        if let Err(cleanup) = cleanup {
            if !matches!(error, GitError::Timeout { .. }) {
                return Err(cleanup);
            }
            tracing::warn!(%cleanup, branch, "could not roll back timed out worktree add");
        }
        return Err(error);
    }
    tracing::info!(branch, path=%path.display(), "created task worktree");
    Ok(())
}
/// Add a worktree that checks out a branch which already exists. The branch is not created, and it is the caller's to
/// keep: removing the worktree later must not delete it. Git refuses when the branch is checked out somewhere else.
pub fn worktree_add_existing(repo: &Repo, branch: &str, path: &Path) -> Result<(), GitError> {
    revision(branch)?;
    if remote::is_remote(&repo.root) {
        return Err(GitError::InvalidPath { path: path.into() });
    }
    if !branch_exists(&repo.root, branch)? {
        return Err(GitError::InvalidRevision);
    }
    let destination = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repo.root.join(path)
    };
    #[cfg(windows)]
    let destination = windows_path::worktree_destination(&destination)?;
    let path = destination.as_path();
    #[cfg(windows)]
    let git_destination = windows_path::git_path(path);
    #[cfg(not(windows))]
    let git_destination = path;
    match path.symlink_metadata() {
        Ok(_) => return Err(GitError::PathExists),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    run(
        &repo.root,
        [
            OsStr::new("worktree"),
            OsStr::new("add"),
            OsStr::new("--"),
            git_destination.as_os_str(),
            OsStr::new(branch),
        ],
    )?;
    tracing::info!(branch, path=%path.display(), "created task worktree on an existing branch");
    Ok(())
}

/// Local branches, then remote-tracking branches as `remotes/origin/main`, without the `HEAD` pointers.
pub fn branch_list(path: &Path) -> Result<Vec<String>, GitError> {
    let local = line(path, &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"])?;
    let remote = line(path, &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/remotes/"])?;
    let mut names: Vec<String> = local.lines().map(str::to_owned).collect();
    names.extend(
        remote
            .lines()
            .filter(|n| !n.ends_with("/HEAD") && n.contains('/'))
            .map(|n| format!("remotes/{n}")),
    );
    names.retain(|n| !n.is_empty());
    Ok(names)
}

/// [`worktree_add`] on an SSH host: the same branch reservation and rollback, with paths compared as text.
fn remote_worktree_add(repo: &Repo, branch: &str, path: &Path, base: &str) -> Result<(), GitError> {
    let Some((alias, destination)) = remote::split(path) else {
        return Err(GitError::InvalidPath { path: path.into() });
    };
    let branch = branch.to_owned();
    check_branch_name(&branch).map_err(|_| GitError::InvalidRevision)?;
    if branch_exists(&repo.root, &branch)? {
        return Err(GitError::BranchExists);
    }
    let check = format!("test ! -e {0} && test ! -L {0}", remote::quote(&destination));
    if let Err(error) = remote::shell(&alias, &check, DEFAULT_TIMEOUT) {
        return Err(match error {
            GitError::WorktreeFailed { .. } => GitError::PathExists,
            other => other,
        });
    }
    run(&repo.root, ["branch", "--", &branch, base])?;
    if let Err(error) = run(
        &repo.root,
        [
            OsStr::new("worktree"),
            OsStr::new("add"),
            OsStr::new("--"),
            path.as_os_str(),
            OsStr::new(&branch),
        ],
    ) {
        let registered = worktree_list(&repo.root)?.iter().any(|w| {
            w.branch.as_deref() == Some(&format!("refs/heads/{branch}"))
                && remote::split(Path::new(&w.path)).is_some_and(|(_, p)| p == destination)
        });
        if registered {
            worktree_remove(repo, path, true)?;
        }
        branch_delete(repo, &branch, true)?;
        return Err(error);
    }
    tracing::info!(branch, path=%path.display(), "created remote task worktree");
    Ok(())
}
/// List attached worktrees, including bare, detached, locked and prunable entries.
pub fn worktree_list(path: &Path) -> Result<Vec<Worktree>, GitError> {
    let mut list = parse_worktrees(&run(path, ["worktree", "list", "--porcelain", "-z"])?);
    for worktree in &mut list {
        if let Some(remote) = remote::rebase(path, &worktree.path) {
            worktree.path = remote;
        }
    }
    Ok(list)
}
/// Remove a worktree; dirty files are retained unless force is explicitly selected.
pub fn worktree_remove(repo: &Repo, path: &Path, force: bool) -> Result<(), GitError> {
    #[cfg(windows)]
    let path = if remote::is_remote(path) {
        path.to_path_buf()
    } else {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            repo.root.join(path)
        };
        windows_path::git_path(&windows_path::worktree_destination(&absolute)?)
    };
    let mut args = vec![OsStr::new("worktree"), OsStr::new("remove")];
    if force {
        args.push(OsStr::new("--force"));
    }
    args.extend([OsStr::new("--"), path.as_os_str()]);
    run(&repo.root, args)?;
    Ok(())
}
/// Prune stale administrative worktree records using Git's expiry policy.
pub fn prune(repo: &Repo) -> Result<(), GitError> {
    run(&repo.root, ["worktree", "prune"])?;
    Ok(())
}
/// Switch the checkout at `repo.root` to `branch`, or to a new `branch` created from `base` when `create` is set.
/// A `remotes/origin/x` name creates a local branch that tracks it. Git refuses when local changes would be lost.
///
/// # Errors
/// Invalid names, a missing branch, or Git's refusal (for example a branch checked out in another worktree).
pub fn switch_branch(repo: &Repo, branch: &str, create: bool, base: &str) -> Result<(), GitError> {
    revision(branch)?;
    if create {
        revision(base)?;
        run(&repo.root, ["switch", "--create", branch, base])?;
    } else if let Some(remote) = branch.strip_prefix("remotes/") {
        run(&repo.root, ["switch", "--track", remote])?;
    } else {
        run(&repo.root, ["switch", branch])?;
    }
    Ok(())
}
/// Move a linked worktree to a new folder (`git worktree move`). The main checkout cannot be moved.
///
/// # Errors
/// Git's refusal: a locked worktree, an existing destination, or the main checkout.
pub fn worktree_move(repo: &Repo, from: &Path, to: &Path) -> Result<(), GitError> {
    if remote::is_remote(&repo.root) {
        return Err(GitError::InvalidPath { path: to.into() });
    }
    run(
        &repo.root,
        [
            OsStr::new("worktree"),
            OsStr::new("move"),
            OsStr::new("--"),
            from.as_os_str(),
            to.as_os_str(),
        ],
    )?;
    Ok(())
}
/// Detach the worktree at `path` from its branch (`git switch --detach`): the files stay, the branch is free to be
/// checked out elsewhere.
///
/// # Errors
/// Git's refusal.
pub fn worktree_detach(path: &Path) -> Result<(), GitError> {
    run(path, ["switch", "--detach"])?;
    Ok(())
}
/// The remote-tracking branch that has the same name as `branch` (`origin/feature`), if the repository has fetched
/// one. A branch with none exists only on this computer.
///
/// # Errors
/// Git failures.
pub fn remote_branch_of(path: &Path, branch: &str) -> Result<Option<String>, GitError> {
    let list = line(path, &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/remotes/"])?;
    Ok(list
        .lines()
        .find(|entry| entry.split_once('/').is_some_and(|(_, name)| name == branch))
        .map(str::to_owned))
}
/// Delete a branch, preserving unmerged commits unless force is selected.
pub fn branch_delete(repo: &Repo, branch: &str, force: bool) -> Result<(), GitError> {
    revision(branch)?;
    run(&repo.root, ["branch", if force { "-D" } else { "-d" }, "--", branch])?;
    Ok(())
}
/// Read status without depending on Git's user-facing formatting.
pub fn status(path: &Path) -> Result<Status, GitError> {
    Ok(parse_status(&run(
        path,
        ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    )?))
}
/// Tracked working-tree changes relative to the merge base, including staged changes.
pub fn changed_files(path: &Path, base: &str) -> Result<Vec<ChangedFile>, GitError> {
    revision(base)?;
    let base = line(path, &["merge-base", base, "HEAD"])?;
    let mut files = parse_numstat(&run(
        path,
        ["diff", "--numstat", "-z", "--no-ext-diff", "--no-renames", &base, "--"],
    )?);
    let names = run(
        path,
        [
            "diff",
            "--name-status",
            "-z",
            "--no-ext-diff",
            "--no-renames",
            &base,
            "--",
        ],
    )?;
    let mut records = names.split(|b| *b == 0);
    while let (Some(state), Some(name)) = (records.next(), records.next()) {
        if let Some(file) = files.iter_mut().find(|f| f.path == String::from_utf8_lossy(name)) {
            file.status = String::from_utf8_lossy(state).into_owned();
        }
    }
    Ok(files)
}
/// Commit IDs reachable from HEAD but not from the supplied base.
pub fn unmerged_commits(path: &Path, base: &str) -> Result<Vec<String>, GitError> {
    revision(base)?;
    Ok(line(path, &["rev-list", &format!("{base}..HEAD"), "--"])?
        .lines()
        .map(str::to_owned)
        .collect())
}

/// Check whether a local branch exists without accepting an option as a revision.
pub fn branch_exists(path: &Path, branch: &str) -> Result<bool, GitError> {
    revision(branch)?;
    let names = line(path, &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"])?;
    Ok(names
        .lines()
        .any(|name| branch_names_match(name, branch, cfg!(windows))))
}

fn branch_names_match(a: &str, b: &str, ignore_case: bool) -> bool {
    a == b || (ignore_case && a.to_lowercase() == b.to_lowercase())
}
/// Count commits ahead of and behind a base revision (rather than an optional upstream).
pub fn ahead_behind(path: &Path, base: &str) -> Result<(u64, u64), GitError> {
    revision(base)?;
    let text = line(
        path,
        &["rev-list", "--left-right", "--count", &format!("{base}...HEAD"), "--"],
    )?;
    let mut parts = text.split_whitespace();
    let behind = parts.next().and_then(|v| v.parse().ok());
    let ahead = parts.next().and_then(|v| v.parse().ok());
    match (ahead, behind) {
        (Some(a), Some(b)) => Ok((a, b)),
        _ => Err(GitError::WorktreeFailed {
            stderr: "invalid revision counts".into(),
        }),
    }
}
/// Commits reachable from a named branch but not the base, even after worktree removal.
pub fn branch_unmerged_commits(path: &Path, branch: &str, base: &str) -> Result<Vec<String>, GitError> {
    revision(branch)?;
    revision(base)?;
    Ok(line(path, &["rev-list", &format!("{base}..{branch}"), "--"])?
        .lines()
        .map(str::to_owned)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_names_are_valid_windows_components_and_branch_comparison_is_platform_aware() {
        assert_eq!(slugify("  CoN.  "), "task-con");
        assert_eq!(slugify("NuL"), "task-nul");
        assert_eq!(slugify("LPT²"), "task-lpt²");
        assert_eq!(slugify("console."), "console");
        assert!(branch_names_match("Tessera/Élan", "tessera/élan", true));
        assert!(!branch_names_match("Tessera/Élan", "tessera/élan", false));
        assert!(!branch_names_match("tessera/abc", "tessera/abcd", true));
        assert!(task_worktree_path(Path::new("root"), "nul").is_err());
    }
}
