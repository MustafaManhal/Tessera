use std::{path::Path, process::Command, sync::mpsc, time::Duration};
use tessera_git::*;
fn git(path: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(["-c", "safe.bareRepository=all", "-C"])
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(o.status.success(), "{:?}: {}", args, String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().into()
}
fn repo() -> Option<tempfile::TempDir> {
    if !Command::new("git")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        eprintln!("skipping: git is unavailable");
        return None;
    }
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-b", "main"]);
    git(d.path(), &["config", "user.name", "Tessera Test"]);
    git(d.path(), &["config", "user.email", "test@example.invalid"]);
    git(d.path(), &["config", "commit.gpgsign", "false"]);
    Some(d)
}
fn commit(path: &Path) {
    git(path, &["add", "--all"]);
    git(path, &["commit", "--allow-empty", "-m", "fixture"]);
}
#[test]
fn worktree_lifecycle_and_dirty_protection() {
    let Some(d) = repo() else { return };
    commit(d.path());
    let r = Repo::open(d.path()).unwrap();
    assert_eq!(r.default_branch.as_deref(), Some("main"));
    let target = d.path().join("space 日本");
    worktree_add(&r, "My task", &target, "HEAD").unwrap();
    assert_eq!(worktree_list(d.path()).unwrap().len(), 2);
    assert_eq!(Repo::open(&target).unwrap().branch.as_deref(), Some("tessera/my-task"));
    assert!(matches!(
        worktree_add(&r, "My task", &d.path().join("other"), "HEAD"),
        Err(GitError::BranchExists)
    ));
    assert!(matches!(
        worktree_add(&r, "another", &target, "HEAD"),
        Err(GitError::PathExists)
    ));
    std::fs::write(target.join("keep.txt"), "keep").unwrap();
    assert!(worktree_remove(&r, &target, false).is_err());
    assert!(target.join("keep.txt").exists());
    worktree_remove(&r, &target, true).unwrap();
    branch_delete(&r, "tessera/my-task", false).unwrap();
    prune(&r).unwrap();
    assert_eq!(worktree_list(d.path()).unwrap().len(), 1);
}
#[test]
fn unborn_detached_bare_and_nonrepo() {
    let Some(d) = repo() else { return };
    let r = Repo::open(d.path()).unwrap();
    assert_eq!(r.branch.as_deref(), Some("main"));
    assert_eq!(r.default_branch, None);
    assert!(status(d.path()).unwrap().files.is_empty());
    assert!(worktree_add(&r, "x", &d.path().join("x"), "HEAD").is_err());
    commit(d.path());
    git(d.path(), &["checkout", "--detach"]);
    assert_eq!(Repo::open(d.path()).unwrap().branch, None);
    let bare = d.path().join("bare");
    std::fs::create_dir(&bare).unwrap();
    git(&bare, &["init", "--bare"]);
    assert!(Repo::open(&bare).unwrap().bare);
    let other = tempfile::tempdir().unwrap();
    assert!(matches!(Repo::open(other.path()), Err(GitError::NotAGitRepo)));
}
#[test]
fn status_diff_and_unmerged_commits() {
    let Some(d) = repo() else { return };
    let p = d.path();
    std::fs::write(p.join("text 日本.txt"), "one\n").unwrap();
    commit(p);
    git(p, &["branch", "base"]);
    std::fs::write(p.join("text 日本.txt"), "two\nthree\n").unwrap();
    std::fs::write(p.join("binary"), [0, 1, 2, 3]).unwrap();
    git(p, &["add", "binary"]);
    std::fs::write(p.join("untracked"), "new").unwrap();
    let status = status(p).unwrap();
    assert_eq!(status.files.len(), 3);
    assert!(status.files.iter().any(|s| s.untracked));
    assert!(status.files.iter().any(|s| s.staged));
    assert!(status.files.iter().any(|s| s.unstaged));
    let diff = changed_files(p, "base").unwrap();
    assert!(
        diff.iter()
            .any(|f| f.path == "binary" && f.is_binary && f.status == "A")
    );
    assert!(
        diff.iter()
            .any(|f| f.path == "text 日本.txt" && f.added == 2 && f.removed == 1 && f.status == "M")
    );
    commit(p);
    assert_eq!(unmerged_commits(p, "base").unwrap().len(), 1);
    assert!(changed_files(p, "--output=oops").is_err());
}
#[test]
fn watcher_emits_for_worktree_changes() {
    let Some(d) = repo() else { return };
    commit(d.path());
    let (tx, rx) = mpsc::channel();
    let _watch = WorktreeWatcher::new(d.path(), move || {
        let _ = tx.send(());
    })
    .unwrap();
    std::fs::write(d.path().join("changed"), "hello").unwrap();
    rx.recv_timeout(Duration::from_secs(10))
        .expect("worktree changed notification");
    assert!(!relevant_path(&d.path().join(".git").join("objects").join("abc")));
    assert!(relevant_path(&d.path().join(".git").join("index")));
}
#[test]
fn slugs_and_host_paths() {
    assert_eq!(slugify("Hello / 日本 !!!"), "hello-日本");
    assert_eq!(slugify("..."), "task");
    assert_eq!(slugify(&"a".repeat(80)).chars().count(), 48);
    assert_eq!(unique_slug("a", &["a".into(), "tessera/a-2".into()]), "a-3");
    let path = if cfg!(windows) {
        Path::new(r"C:\repo\space 日本")
    } else {
        Path::new("/repo/space 日本")
    };
    assert!(relevant_path(&path.join("source.rs")));
}
#[test]
fn fixture_parsers_and_malformed_inputs() {
    let s = parse_status(include_bytes!("fixtures/status.z"));
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!((s.ahead, s.behind), (2, 1));
    assert_eq!(s.files.len(), 4);
    assert_eq!(s.files[1].original_path.as_deref(), Some("old name"));
    assert!(s.files[2].conflicted);
    let w = parse_worktrees(include_bytes!("fixtures/worktrees.z"));
    assert_eq!(w.len(), 2);
    assert!(w[1].detached);
    assert_eq!(w[1].locked.as_deref(), Some("reason"));
    for n in 0..=255 {
        let bytes = [n, 0, n, b' ', 0];
        let _ = parse_status(&bytes);
        let _ = parse_worktrees(&bytes);
        let _ = parse_numstat(&bytes);
    }
    assert!(parse_status(b"1 bad\0? actual\0").files.iter().all(|f| f.untracked));
    assert!(parse_numstat(b"bad\t3\tfile\0").is_empty());
}

#[test]
fn real_rename_conflict_and_tracking() {
    let Some(d) = repo() else { return };
    let p = d.path();
    std::fs::write(p.join("file"), "original\n").unwrap();
    commit(p);
    git(p, &["branch", "side"]);
    git(p, &["config", "branch.main.remote", "."]);
    git(p, &["config", "branch.main.merge", "refs/heads/side"]);
    std::fs::write(p.join("file"), "main\n").unwrap();
    commit(p);
    assert_eq!(status(p).unwrap().ahead, 1);
    git(p, &["checkout", "side"]);
    std::fs::write(p.join("file"), "side\n").unwrap();
    commit(p);
    git(p, &["checkout", "main"]);
    let output = Command::new("git")
        .arg("-C")
        .arg(p)
        .args(["merge", "side"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(status(p).unwrap().files.iter().any(|f| f.conflicted));
    git(p, &["merge", "--abort"]);
    git(p, &["mv", "file", "renamed 日本"]);
    let state = status(p).unwrap();
    assert!(
        state
            .files
            .iter()
            .any(|f| f.renamed && f.original_path.as_deref() == Some("file"))
    );
}

#[test]
fn origin_default_and_linked_metadata_watch() {
    let Some(d) = repo() else { return };
    let p = d.path();
    commit(p);
    git(p, &["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(p, &["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
    git(
        p,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"],
    );
    let r = Repo::open(p).unwrap();
    assert_eq!(r.default_branch.as_deref(), Some("origin/trunk"));
    assert_eq!(r.remote_url.as_deref(), Some("https://example.invalid/repo.git"));
    let sibling = tempfile::tempdir().unwrap();
    let target = sibling.path().join("linked");
    worktree_add(&r, "linked", &target, "HEAD").unwrap();
    let (tx, rx) = mpsc::channel();
    let _watch = WorktreeWatcher::new(&target, move || {
        let _ = tx.send(());
    })
    .unwrap();
    git(&target, &["checkout", "--detach"]);
    rx.recv_timeout(Duration::from_secs(10))
        .expect("linked HEAD notification");
}

#[cfg(target_os = "macos")]
#[test]
fn failed_checkout_hook_rolls_back_new_worktree_and_branch() {
    use std::os::unix::fs::PermissionsExt;
    let Some(d) = repo() else {
        return;
    };
    commit(d.path());
    let hook = d.path().join(".git/hooks/post-checkout");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").expect("hook");
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("executable");
    let repository = Repo::open(d.path()).expect("repo");
    let destination = d.path().join("failed-checkout");
    assert!(worktree_add(&repository, "failed-checkout", &destination, "main").is_err());
    assert!(!destination.exists());
    assert!(!branch_exists(d.path(), "tessera/failed-checkout").expect("branch"));
    assert_eq!(worktree_list(d.path()).expect("worktrees").len(), 1);
}

#[test]
fn branch_detection_distinguishes_tags_from_local_branches() {
    let Some(d) = repo() else { return };
    commit(d.path());
    git(d.path(), &["branch", "collision"]);
    git(d.path(), &["tag", "collision"]);
    git(d.path(), &["tag", "tag-only"]);
    assert!(branch_exists(d.path(), "collision").unwrap());
    assert!(!branch_exists(d.path(), "tag-only").unwrap());
    assert_eq!(branch_exists(d.path(), "COLLISION").unwrap(), cfg!(windows));
}

#[test]
#[cfg(windows)]
fn worktree_lifecycle_accepts_a_long_verbatim_windows_path() {
    let Some(d) = repo() else { return };
    commit(d.path());
    let repo = Repo::open(d.path()).unwrap();
    let root = std::fs::canonicalize(d.path())
        .unwrap()
        .join("a".repeat(110))
        .join("b".repeat(110))
        .join("c".repeat(110));
    std::fs::create_dir_all(&root).unwrap();
    let target = root.join("long-path");
    assert!(target.to_string_lossy().starts_with(r"\\?\"));
    assert!(target.to_string_lossy().len() > 260);
    // Git for Windows has its own limit on the length of a worktree's git directory path: even with
    // `core.longpaths` it can answer "$GIT_DIR too big". That is a clean failure we accept; anything else is a bug.
    match worktree_add(&repo, "long-path", &target, "HEAD") {
        Ok(_) => {}
        Err(tessera_git::GitError::WorktreeFailed { stderr }) if stderr.contains("too big") => {
            assert!(!target.exists(), "a failed add must not leave the folder behind");
            return;
        }
        Err(other) => panic!("unexpected error: {other:?}"),
    }
    assert!(status(&target).unwrap().files.is_empty());
    assert_eq!(worktree_list(&repo.root).unwrap().len(), 2);
    worktree_remove(&repo, &target, false).unwrap();
    assert!(!target.exists());
}
