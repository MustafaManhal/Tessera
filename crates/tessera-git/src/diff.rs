//! Merge-base review, including working-tree and untracked content. All Git reads use the SSH-aware runner.
use crate::{GitError, remote, revision, run_with_timeout};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Component, Path},
    time::Duration,
};
const LIMIT: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
/// One changed file in the review list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewChangedFile {
    /// Current repository-relative path.
    pub path: String,
    /// Previous path of a rename.
    pub old_path: Option<String>,
    /// Git status letter.
    pub status: String,
    /// Added lines.
    pub added: u64,
    /// Removed lines.
    pub removed: u64,
    /// Git or content identifies binary data.
    pub is_binary: bool,
}
/// Complete file texts, absent for binary or oversized content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewFileDiff {
    /// Merge-base contents.
    pub base_text: Option<String>,
    /// Current working contents.
    pub head_text: Option<String>,
    /// Either side exceeds one MiB.
    pub too_large: bool,
    /// Either side is binary.
    pub binary: bool,
    /// The index has unresolved stages.
    pub conflict: bool,
}
fn git(path: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    run_with_timeout(path, args, TIMEOUT)
}
fn merge_base(path: &Path, base: &str) -> Result<String, GitError> {
    revision(base)?;
    Ok(String::from_utf8_lossy(&git(path, &["merge-base", base, "HEAD"])?)
        .trim()
        .into())
}
fn relative(path: &str) -> Result<(), GitError> {
    if path.is_empty()
        || path.contains('\0')
        || path.contains('\\')
        || Path::new(path).components().any(|c| !matches!(c, Component::Normal(_)))
        || path.split('/').any(|c| c == ".." || c == ".")
    {
        return Err(GitError::InvalidPath { path: path.into() });
    }
    Ok(())
}
/// Working-file routing kept in one place. Reads are capped and symlinks are shown as link text, never followed.
pub fn review_working_text(root: &Path, path: &str) -> Result<Vec<u8>, GitError> {
    relative(path)?;
    if let Some((alias, dir)) = remote::split(root) {
        let file = remote::quote(&format!("{}/{path}", dir.trim_end_matches('/')));
        let mut bytes = remote::shell(
            &alias,
            &format!(
                "if test -L {file}; then printf L; readlink -- {file}; elif test -f {file}; then test -r {file} || exit 1; printf F; cat -- {file} | head -c {}; else test ! -e {file}; fi",
                LIMIT + 1
            ),
            TIMEOUT,
        )?;
        if !bytes.is_empty() {
            let link = bytes.remove(0) == b'L';
            if link && bytes.last() == Some(&b'\n') {
                bytes.pop();
            }
        }
        return Ok(bytes);
    }
    let file = root.join(path);
    match std::fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
        Ok(m) if m.file_type().is_symlink() => Ok(std::fs::read_link(file)?.to_string_lossy().as_bytes().to_vec()),
        Ok(m) if m.is_file() => {
            let mut bytes = Vec::new();
            std::fs::File::open(file)?
                .take((LIMIT + 1) as u64)
                .read_to_end(&mut bytes)?;
            Ok(bytes)
        }
        Ok(_) => Ok(Vec::new()),
    }
}
fn binary(bytes: &[u8]) -> bool {
    bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
}
/// Changed files against merge base, including unstaged and untracked files.
pub fn review_files(root: &Path, base: &str) -> Result<Vec<ReviewChangedFile>, GitError> {
    let base = merge_base(root, base)?;
    let names = git(
        root,
        &[
            "--literal-pathspecs",
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            "--no-ext-diff",
            &base,
            "--",
        ],
    )?;
    let mut records = names.split(|b| *b == 0);
    let mut files = BTreeMap::new();
    while let Some(status) = records.next().filter(|s| !s.is_empty()) {
        let Some(first) = records.next() else { break };
        let (old, path) = if status.starts_with(b"R") || status.starts_with(b"C") {
            (
                Some(String::from_utf8_lossy(first).into_owned()),
                records.next().unwrap_or(first),
            )
        } else {
            (None, first)
        };
        let path = String::from_utf8_lossy(path).into_owned();
        files.insert(
            path.clone(),
            ReviewChangedFile {
                path,
                old_path: old,
                status: String::from_utf8_lossy(&status[..1]).into(),
                added: 0,
                removed: 0,
                is_binary: false,
            },
        );
    }
    let stats = git(
        root,
        &[
            "diff",
            "--numstat",
            "-z",
            "--find-renames",
            "--no-ext-diff",
            &base,
            "--",
        ],
    )?;
    let mut records = stats.split(|b| *b == 0);
    while let Some(record) = records.next().filter(|r| !r.is_empty()) {
        let mut fields = record.splitn(3, |b| *b == b'\t');
        let a = fields.next().unwrap_or_default();
        let r = fields.next().unwrap_or_default();
        let mut path = fields.next().unwrap_or_default();
        if path.is_empty() {
            records.next();
            path = records.next().unwrap_or_default();
        }
        if let Some(file) = files.get_mut(String::from_utf8_lossy(path).as_ref()) {
            file.is_binary = a == b"-";
            file.added = String::from_utf8_lossy(a).parse().unwrap_or(0);
            file.removed = String::from_utf8_lossy(r).parse().unwrap_or(0);
        }
    }
    for path in git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
    {
        let path = String::from_utf8_lossy(path).into_owned();
        let text = review_working_text(root, &path)?;
        let is_binary = binary(&text);
        let added = if is_binary || text.len() > LIMIT {
            0
        } else {
            text.iter().filter(|b| **b == b'\n').count() as u64 + u64::from(!text.is_empty() && !text.ends_with(b"\n"))
        };
        files.insert(
            path.clone(),
            ReviewChangedFile {
                path,
                old_path: None,
                status: "?".into(),
                added,
                removed: 0,
                is_binary,
            },
        );
    }
    for path in git(root, &["diff", "--name-only", "--diff-filter=U", "-z"])?
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
    {
        if let Some(file) = files.get_mut(String::from_utf8_lossy(path).as_ref()) {
            file.status = "U".into();
        }
    }
    // Index changes may cancel committed branch changes in the merge-base view. Keep those files actionable.
    for state in crate::status(root)?.files {
        if files.contains_key(&state.path) {
            continue;
        }
        let text = if state.worktree == 'D' {
            Vec::new()
        } else {
            review_working_text(root, &state.path)?
        };
        let status = if state.conflicted {
            "U"
        } else if state.untracked {
            "?"
        } else if state.worktree == 'D' {
            "D"
        } else {
            "M"
        };
        files.insert(
            state.path.clone(),
            ReviewChangedFile {
                path: state.path,
                old_path: state.original_path,
                status: status.into(),
                added: 0,
                removed: 0,
                is_binary: binary(&text),
            },
        );
    }
    Ok(files.into_values().collect())
}
/// Load only a path in the current review set. Literal pathspecs prevent metacharacter expansion.
pub fn review_file_diff(root: &Path, base: &str, path: &str) -> Result<ReviewFileDiff, GitError> {
    relative(path)?;
    let file = review_files(root, base)?
        .into_iter()
        .find(|f| f.path == path)
        .ok_or_else(|| GitError::InvalidPath { path: path.into() })?;
    let base = merge_base(root, base)?;
    let old = file.old_path.as_deref().unwrap_or(path);
    let exists = !git(root, &["--literal-pathspecs", "ls-tree", "-z", &base, "--", old])?.is_empty();
    let spec = format!("{base}:{old}");
    let mut base_bytes = Vec::new();
    let mut too_large = false;
    if exists {
        let size = git(root, &["cat-file", "-s", &spec])?;
        too_large = String::from_utf8_lossy(&size)
            .trim()
            .parse::<usize>()
            .unwrap_or(LIMIT + 1)
            > LIMIT;
        if !too_large {
            base_bytes = git(root, &["show", &spec])?;
        }
    }
    let head = if file.status == "D" {
        Vec::new()
    } else {
        review_working_text(root, path)?
    };
    too_large |= head.len() > LIMIT;
    let binary = file.is_binary || binary(&base_bytes) || binary(&head);
    Ok(ReviewFileDiff {
        base_text: if too_large || binary {
            None
        } else {
            Some(String::from_utf8_lossy(&base_bytes).into())
        },
        head_text: if too_large || binary {
            None
        } else {
            Some(String::from_utf8_lossy(&head).into())
        },
        too_large,
        binary,
        conflict: file.status == "U",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    fn command(root: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    fn repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        command(tmp.path(), &["init", "-b", "main"]);
        command(tmp.path(), &["config", "user.name", "Fixture"]);
        command(tmp.path(), &["config", "user.email", "fixture@example.invalid"]);
        tmp
    }
    #[test]
    fn review_tracks_all_changes_and_limits_text() {
        let tmp = repo();
        let root = tmp.path();
        for name in ["modify.txt", "delete.txt", "rename.txt"] {
            std::fs::write(root.join(name), format!("{name} before\n")).unwrap();
        }
        command(root, &["add", "."]);
        command(root, &["commit", "-m", "base"]);
        command(root, &["checkout", "-b", "task"]);
        command(root, &["mv", "rename.txt", "renamed 界 file.txt"]);
        std::fs::write(root.join("modify.txt"), "after\n").unwrap();
        std::fs::remove_file(root.join("delete.txt")).unwrap();
        std::fs::write(root.join("added.txt"), "new\n").unwrap();
        command(root, &["add", "added.txt"]);
        std::fs::write(root.join("untracked 界.txt"), "one\ntwo").unwrap();
        std::fs::write(root.join("binary.dat"), [1, 0, 2]).unwrap();
        std::fs::write(root.join("large.txt"), vec![b'x'; LIMIT + 1]).unwrap();
        let files = review_files(root, "main").unwrap();
        for (name, status) in [
            ("modify.txt", "M"),
            ("delete.txt", "D"),
            ("added.txt", "A"),
            ("untracked 界.txt", "?"),
        ] {
            assert_eq!(files.iter().find(|f| f.path == name).unwrap().status, status);
        }
        let renamed = files.iter().find(|f| f.path == "renamed 界 file.txt").unwrap();
        assert_eq!(renamed.old_path.as_deref(), Some("rename.txt"));
        assert_eq!((renamed.added, renamed.removed), (0, 0));
        assert_eq!(
            review_file_diff(root, "main", "modify.txt")
                .unwrap()
                .head_text
                .as_deref(),
            Some("after\n")
        );
        assert_eq!(
            review_file_diff(root, "main", "delete.txt")
                .unwrap()
                .head_text
                .as_deref(),
            Some("")
        );
        assert_eq!(
            review_file_diff(root, "main", "renamed 界 file.txt")
                .unwrap()
                .base_text
                .as_deref(),
            Some("rename.txt before\n")
        );
        assert!(review_file_diff(root, "main", "binary.dat").unwrap().binary);
        let large = review_file_diff(root, "main", "large.txt").unwrap();
        assert!(large.too_large && large.base_text.is_none() && large.head_text.is_none());
        assert!(review_file_diff(root, "main", "../outside").is_err());
        assert!(review_file_diff(root, "main", "not-changed").is_err());
        let untracked = files.iter().find(|f| f.path == "untracked 界.txt").unwrap();
        assert_eq!(untracked.added, 2);
    }
    #[test]
    fn review_reports_conflicts() {
        let tmp = repo();
        let root = tmp.path();
        std::fs::write(root.join("conflict.txt"), "base\n").unwrap();
        command(root, &["add", "."]);
        command(root, &["commit", "-m", "base"]);
        command(root, &["checkout", "-b", "side"]);
        std::fs::write(root.join("conflict.txt"), "side\n").unwrap();
        command(root, &["commit", "-am", "side"]);
        command(root, &["checkout", "-b", "task", "main"]);
        std::fs::write(root.join("conflict.txt"), "task\n").unwrap();
        command(root, &["commit", "-am", "task"]);
        assert!(
            !Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["merge", "side"])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert!(review_file_diff(root, "main", "conflict.txt").unwrap().conflict);
    }
    #[test]
    fn remote_working_text_uses_ssh_routing() {
        let error =
            review_working_text(Path::new("ssh://review-routing-fixture/repo"), "file with 界.txt").unwrap_err();
        assert!(matches!(error, GitError::Remote { .. }), "{error:?}");
    }
}

/// Current index/worktree state, independently from the merge-base review.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexFile {
    pub path: String,
    pub old_path: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflict: bool,
}
/// A generated, exact patch for one textual hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewHunk {
    pub index: usize,
    pub header: String,
    pub patch: String,
}
#[derive(Debug, thiserror::Error)]
pub enum ReviewGitError {
    #[error("There are no staged changes to commit.")]
    NothingToCommit,
    #[error("Git commit failed:\n{output}")]
    HookFailed { output: String },
    #[error("The hunk changed. Refresh before applying it.")]
    StaleHunk,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Git(#[from] GitError),
}
/// Successful commit metadata and Git's hook/status output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewCommit {
    pub hash: String,
    pub output: String,
}
fn diagnostic(out: &std::process::Output) -> String {
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    if out.stdout.len() > LIMIT || out.stderr.len() > LIMIT {
        text.push_str("\n[Output truncated at 1 MiB per stream]\n");
    }
    text
}
fn checked(out: std::process::Output) -> Result<(), ReviewGitError> {
    if out.status.success() {
        Ok(())
    } else {
        Err(GitError::WorktreeFailed {
            stderr: diagnostic(&out),
        }
        .into())
    }
}
/// Index flags for stage/unstage/discard controls.
pub fn review_index(root: &Path) -> Result<Vec<IndexFile>, ReviewGitError> {
    let mut files: BTreeMap<String, IndexFile> = BTreeMap::new();
    for f in crate::status(root)?.files {
        let row = files.entry(f.path.clone()).or_insert_with(|| IndexFile {
            path: f.path,
            old_path: None,
            staged: false,
            unstaged: false,
            untracked: false,
            conflict: false,
        });
        row.old_path = row.old_path.take().or(f.original_path);
        row.staged |= f.staged;
        row.unstaged |= f.unstaged;
        row.untracked |= f.untracked;
        row.conflict |= f.conflicted;
    }
    Ok(files.into_values().collect())
}

fn index_file(root: &Path, path: &str) -> Result<IndexFile, ReviewGitError> {
    relative(path)?;
    review_index(root)?
        .into_iter()
        .find(|f| f.path == path)
        .ok_or_else(|| ReviewGitError::Invalid("The file has no index or working-tree changes.".into()))
}
fn indexed(root: &Path, path: &str) -> Result<bool, ReviewGitError> {
    relative(path)?;
    Ok(!git(root, &["--literal-pathspecs", "ls-files", "-z", "--", path])?.is_empty())
}
/// Split Git-generated patch text, retaining its trusted file headers on each hunk.
pub fn split_review_hunks(text: &str) -> Vec<ReviewHunk> {
    let mut result = Vec::new();
    let mut prefix = String::new();
    let mut body = String::new();
    let mut header = String::new();
    for line in text.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            if !body.is_empty() {
                result.push(ReviewHunk {
                    index: result.len(),
                    header: header.clone(),
                    patch: format!("{prefix}{body}"),
                });
                body.clear();
            }
            prefix.clear();
            header.clear();
        }
        if line.starts_with("@@ ") {
            if !body.is_empty() {
                result.push(ReviewHunk {
                    index: result.len(),
                    header: header.clone(),
                    patch: format!("{prefix}{body}"),
                });
                body.clear();
            }
            header = line.trim_end().into();
            body.push_str(line);
        } else if !body.is_empty() {
            body.push_str(line);
        } else {
            prefix.push_str(line);
        }
    }
    if !body.is_empty() {
        result.push(ReviewHunk {
            index: result.len(),
            header,
            patch: format!("{prefix}{body}"),
        });
    }
    result
}
/// Hunk patches compare the index and working tree, or HEAD and index for staged hunks.
pub fn review_hunks(root: &Path, path: &str, staged: bool) -> Result<Vec<ReviewHunk>, ReviewGitError> {
    let file = match index_file(root, path) {
        Ok(file) => file,
        Err(ReviewGitError::Invalid(_)) => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    if file.conflict || (staged && file.old_path.is_some()) {
        return Ok(Vec::new());
    }
    let mut args = vec![
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--full-index",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=3",
    ];
    if staged {
        args.push("--cached");
    } else if file.untracked {
        args.push("--no-index");
    }
    args.push("--");
    if file.untracked && !staged {
        args.push("/dev/null");
    }
    args.push(path);
    let out = remote::git_stdin(root, &args, &[], TIMEOUT)?;
    if !out.status.success() && !(file.untracked && !staged && out.status.code() == Some(1)) {
        checked(out)?;
        return Ok(Vec::new());
    }
    if out.stdout.len() > LIMIT {
        return Err(ReviewGitError::Invalid(
            "The patch is too large. Use file actions instead.".into(),
        ));
    }
    let text = std::str::from_utf8(&out.stdout)
        .map_err(|_| ReviewGitError::Invalid("This file has no textual hunks. Use file actions instead.".into()))?;
    Ok(split_review_hunks(text))
}
/// Stage all unstaged changes for a selected file (and the tracked source of an inferred rename).
pub fn review_stage_file(root: &Path, path: &str, old_path: Option<&str>) -> Result<(), ReviewGitError> {
    index_file(root, path)?;
    let mut args = vec!["--literal-pathspecs", "add", "-A", "--", path];
    if let Some(old) = old_path
        && indexed(root, old)?
    {
        args.push(old);
    }
    git(root, &args)?;
    Ok(())
}
/// Unstage without changing working-file contents.
pub fn review_unstage_file(root: &Path, path: &str, old_path: Option<&str>) -> Result<(), ReviewGitError> {
    let file = index_file(root, path)?;
    let mut args = vec![
        "--literal-pathspecs",
        "restore",
        "--staged",
        "--source=HEAD",
        "--",
        path,
    ];
    if let Some(old) = file.old_path.as_deref().or(old_path) {
        relative(old)?;
        if old != path {
            args.push(old);
        }
    }
    git(root, &args)?;
    Ok(())
}
/// Discard only unstaged changes. Caller must obtain explicit in-app confirmation.
pub fn review_discard_file(root: &Path, path: &str, old_path: Option<&str>) -> Result<(), ReviewGitError> {
    let file = index_file(root, path)?;
    if file.untracked {
        if let Some(old) = old_path
            && indexed(root, old)?
        {
            git(root, &["--literal-pathspecs", "restore", "--worktree", "--", old])?;
        }
        git(root, &["--literal-pathspecs", "clean", "-f", "--", path])?;
    } else if file.unstaged {
        git(root, &["--literal-pathspecs", "restore", "--worktree", "--", path])?;
    } else {
        return Err(ReviewGitError::Invalid(
            "Only unstaged changes can be discarded. Unstage the file first.".into(),
        ));
    }
    Ok(())
}
/// Apply a verified generated hunk. mode is stage, unstage, or discard (working tree only).
pub fn review_apply_hunk(
    root: &Path,
    path: &str,
    index: usize,
    expected_patch: &str,
    mode: &str,
) -> Result<(), ReviewGitError> {
    if !matches!(mode, "stage" | "unstage" | "discard") {
        return Err(ReviewGitError::Invalid("Unknown hunk operation.".into()));
    }
    let hunks = review_hunks(root, path, mode == "unstage")?;
    let hunk = hunks
        .get(index)
        .filter(|h| h.patch == expected_patch)
        .ok_or(ReviewGitError::StaleHunk)?;
    let mut args = vec!["apply", "--whitespace=nowarn"];
    if mode != "discard" {
        args.push("--cached");
    }
    if mode != "stage" {
        args.push("-R");
    }
    let mut check = args.clone();
    check.extend(["--check", "-"]);
    checked(remote::git_stdin(root, &check, hunk.patch.as_bytes(), TIMEOUT)?)?;
    args.push("-");
    checked(remote::git_stdin(root, &args, hunk.patch.as_bytes(), TIMEOUT)?)
}
/// Commit staged changes, preserving hook output. No hook bypass or implicit staging.
pub fn review_commit(root: &Path, message: &str) -> Result<ReviewCommit, ReviewGitError> {
    if message.trim().is_empty() || message.len() > 65536 {
        return Err(ReviewGitError::Invalid(
            "Write a commit message of at most 64 KiB.".into(),
        ));
    }
    if git(root, &["diff", "--cached", "--name-only", "-z"])?.is_empty() {
        return Err(ReviewGitError::NothingToCommit);
    }
    let out = remote::git_stdin(root, &["commit", "--file=-"], message.as_bytes(), TIMEOUT)?;
    let output = diagnostic(&out);
    if !out.status.success() {
        return Err(ReviewGitError::HookFailed { output });
    }
    let hash = String::from_utf8_lossy(&git(root, &["rev-parse", "HEAD"])?)
        .trim()
        .into();
    Ok(ReviewCommit { hash, output })
}

#[cfg(test)]
mod stage_tests {
    use super::*;
    use std::process::Command;
    fn cmd(root: &Path, args: &[&str]) -> Vec<u8> {
        let out = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    }
    fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        cmd(root, &["init", "-b", "main"]);
        cmd(root, &["config", "user.name", "Fixture"]);
        cmd(root, &["config", "user.email", "fixture@example.invalid"]);
        std::fs::write(
            root.join("text 界 file.txt"),
            (1..=30).map(|n| format!("line {n}\n")).collect::<String>(),
        )
        .unwrap();
        std::fs::write(root.join("binary.dat"), [1, 0, 2]).unwrap();
        std::fs::write(root.join("rename.txt"), "rename fixture\n").unwrap();
        cmd(root, &["add", "."]);
        cmd(root, &["commit", "-m", "base"]);
        tmp
    }
    #[test]
    fn hunk_stage_unstage_roundtrip_discard_and_stale_refusal() {
        let tmp = fixture();
        let root = tmp.path();
        let path = "text 界 file.txt";
        let original = std::fs::read_to_string(root.join(path)).unwrap();
        let changed = original
            .replace("line 2\n", "changed two\n")
            .replace("line 25\n", "changed twenty-five\n");
        std::fs::write(root.join(path), &changed).unwrap();
        let hunks = review_hunks(root, path, false).unwrap();
        assert_eq!(hunks.len(), 2);
        review_apply_hunk(root, path, 0, &hunks[0].patch, "stage").unwrap();
        let index = String::from_utf8(cmd(root, &["show", &format!(":{path}")])).unwrap();
        assert!(index.contains("changed two"));
        assert!(!index.contains("changed twenty-five"));
        assert_eq!(std::fs::read_to_string(root.join(path)).unwrap(), changed);
        let staged = review_hunks(root, path, true).unwrap();
        assert_eq!(staged.len(), 1);
        review_apply_hunk(root, path, 0, &staged[0].patch, "unstage").unwrap();
        assert_eq!(
            String::from_utf8(cmd(root, &["show", &format!(":{path}")])).unwrap(),
            original
        );
        let hunks = review_hunks(root, path, false).unwrap();
        review_apply_hunk(root, path, 0, &hunks[0].patch, "discard").unwrap();
        let after = std::fs::read_to_string(root.join(path)).unwrap();
        assert!(!after.contains("changed two"));
        assert!(after.contains("changed twenty-five"));
        assert!(matches!(
            review_apply_hunk(root, path, 0, &hunks[0].patch, "stage"),
            Err(ReviewGitError::StaleHunk)
        ));
        assert!(review_index(root).unwrap().iter().all(|f| !f.staged));
    }
    #[test]
    fn index_changes_remain_visible_when_working_tree_matches_merge_base() {
        let tmp = fixture();
        let root = tmp.path();
        cmd(root, &["checkout", "-b", "task"]);
        std::fs::write(root.join("rename.txt"), "committed task change\n").unwrap();
        cmd(root, &["add", "rename.txt"]);
        cmd(root, &["commit", "-m", "task change"]);
        std::fs::write(root.join("rename.txt"), "rename fixture\n").unwrap();
        assert!(
            review_files(root, "main")
                .unwrap()
                .iter()
                .any(|f| f.path == "rename.txt")
        );
        let hunks = review_hunks(root, "rename.txt", false).unwrap();
        review_apply_hunk(root, "rename.txt", 0, &hunks[0].patch, "stage").unwrap();
        assert!(
            review_files(root, "main")
                .unwrap()
                .iter()
                .any(|f| f.path == "rename.txt")
        );
        // A staged deletion with a new working file has two porcelain records for the same path.
        cmd(root, &["rm", "--cached", "rename.txt"]);
        let state = review_index(root).unwrap();
        let same = state.iter().filter(|f| f.path == "rename.txt").collect::<Vec<_>>();
        assert_eq!(same.len(), 1);
        assert!(same[0].staged && same[0].untracked);
        review_discard_file(root, "rename.txt", None).unwrap();
        assert!(!root.join("rename.txt").exists());
        assert!(
            review_index(root)
                .unwrap()
                .iter()
                .any(|f| f.path == "rename.txt" && f.staged)
        );
    }
    #[test]
    fn binary_rename_and_untracked_file_actions() {
        let tmp = fixture();
        let root = tmp.path();
        std::fs::write(root.join("binary.dat"), [3, 0, 4]).unwrap();
        assert!(review_hunks(root, "binary.dat", false).unwrap().is_empty());
        review_stage_file(root, "binary.dat", None).unwrap();
        assert_eq!(cmd(root, &["show", ":binary.dat"]), [3, 0, 4]);
        review_unstage_file(root, "binary.dat", None).unwrap();
        review_discard_file(root, "binary.dat", None).unwrap();
        assert_eq!(std::fs::read(root.join("binary.dat")).unwrap(), [1, 0, 2]);
        std::fs::rename(root.join("rename.txt"), root.join("renamed 界.txt")).unwrap();
        review_stage_file(root, "renamed 界.txt", Some("rename.txt")).unwrap();
        assert!(
            review_index(root)
                .unwrap()
                .iter()
                .any(|f| f.old_path.as_deref() == Some("rename.txt") && f.staged)
        );
        review_unstage_file(root, "renamed 界.txt", Some("rename.txt")).unwrap();
        review_discard_file(root, "renamed 界.txt", Some("rename.txt")).unwrap();
        assert!(root.join("rename.txt").is_file());
        assert!(!root.join("renamed 界.txt").exists());
        std::fs::write(root.join("new 界 file.txt"), "new file\n").unwrap();
        let hunks = review_hunks(root, "new 界 file.txt", false).unwrap();
        assert_eq!(hunks.len(), 1);
        review_apply_hunk(root, "new 界 file.txt", 0, &hunks[0].patch, "stage").unwrap();
        review_unstage_file(root, "new 界 file.txt", None).unwrap();
        review_discard_file(root, "new 界 file.txt", None).unwrap();
        assert!(!root.join("new 界 file.txt").exists());
    }
    #[test]
    fn commit_hook_output_nothing_staged_and_stdin_route() {
        let tmp = fixture();
        let root = tmp.path();
        assert!(matches!(
            review_commit(root, "Nothing"),
            Err(ReviewGitError::NothingToCommit)
        ));
        std::fs::write(root.join("rename.txt"), "changed\n").unwrap();
        review_stage_file(root, "rename.txt", None).unwrap();
        let hook = root.join(".git/hooks/pre-commit");
        std::fs::write(
            &hook,
            "#!/bin/sh\nprintf 'hook refused\\n'\nprintf 'hook diagnostic\\n' >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let old = cmd(root, &["rev-parse", "HEAD"]);
        let error = review_commit(root, "Denied").unwrap_err();
        assert!(
            matches!(&error,ReviewGitError::HookFailed{output} if output.contains("hook refused") && output.contains("hook diagnostic"))
        );
        assert_eq!(cmd(root, &["rev-parse", "HEAD"]), old);
        assert!(review_index(root).unwrap().iter().any(|f| f.staged));
        std::fs::remove_file(hook).unwrap();
        let committed = review_commit(root, "Fixture commit").unwrap();
        assert!(!committed.hash.is_empty());
        assert!(review_index(root).unwrap().is_empty());
        let output = remote::git_stdin(root, &["hash-object", "--stdin"], &vec![b'x'; 131072], TIMEOUT).unwrap();
        assert!(output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .trim()
                .chars()
                .all(|c| c.is_ascii_hexdigit())
        );
        assert!(matches!(
            remote::git_stdin(
                Path::new("ssh://review-stdin-fixture/repo"),
                &["apply", "--cached", "-"],
                b"patch",
                TIMEOUT
            ),
            Err(GitError::Remote { .. })
        ));
    }
}
