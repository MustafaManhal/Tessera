//! Real git fixture coverage for task creation, failure rollback and deletion safety.
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use tessera_store::{
    DataDirs, Store,
    projects::SetupState,
    tasks::{CreateTask, TaskError, allocate_ports},
};

fn git(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn fixture() -> Option<(tempfile::TempDir, Store, String, PathBuf)> {
    if Command::new("git").arg("--version").output().is_err() {
        eprintln!("skip: git missing");
        return None;
    }
    let temp = tempfile::tempdir().expect("temp");
    let repo = temp.path().join("repo with 界 spaces");
    std::fs::create_dir(&repo).expect("dir");
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.email", "fixture@example.invalid"]);
    git(&repo, &["config", "user.name", "Fixture"]);
    std::fs::write(repo.join("hello.txt"), "hello\n").expect("file");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "initial"]);
    let store = Store::open(&DataDirs::from_root(temp.path().join("data"))).expect("store");
    let project = store.project_add_local(&repo, temp.path()).expect("project");
    Some((temp, store, project.id, repo))
}
fn input(project: &str, name: &str) -> CreateTask {
    CreateTask {
        project_id: project.into(),
        name: Some(name.into()),
        prompt: Some("stored prompt".into()),
        base_branch: "main".into(),
        existing_branch: None,
        use_main_checkout: false,
        run_setup: false,
    }
}
#[test]
fn end_to_end_dirty_and_unmerged_refusals_archive_restore_and_confirm_delete() {
    let Some((_temp, store, id, _repo)) = fixture() else {
        return;
    };
    let mut states = Vec::new();
    let task = store
        .task_create_record(input(&id, "A task"), |t| states.push(t.state.clone()))
        .expect("create");
    assert_eq!(
        states,
        vec![Some("backlog".into()), Some("setting_up".into()), Some("active".into())]
    );
    assert_eq!(task.prompt.as_deref(), Some("stored prompt"));
    let path = PathBuf::from(task.worktree_path.as_ref().expect("worktree"));
    std::fs::write(path.join("hello.txt"), "changed\n").expect("edit");
    assert!(matches!(
        store.task_delete_record(&task.id, false, |_| {}),
        Err(TaskError::DirtyWorktree)
    ));
    let archived = store.task_archive_record(&task.id, |_| {}).expect("archive");
    assert!(path.exists());
    assert_eq!(archived.port_start, None);
    let other = store.task_create_record(input(&id, "other"), |_| {}).expect("other");
    assert_eq!(other.port_start, task.port_start, "archive frees ports");
    let restored = store.task_restore_record(&task.id, |_| {}).expect("restore");
    assert_ne!(restored.port_start, other.port_start);
    git(&path, &["add", "."]);
    git(&path, &["commit", "-m", "task only"]);
    match store.task_delete_record(&task.id, false, |_| {}) {
        Err(TaskError::UnmergedCommits { list }) => assert_eq!(list.len(), 1),
        result => panic!("expected unmerged refusal: {result:?}"),
    }
    store
        .task_delete_record(&task.id, true, |_| {})
        .expect("confirmed delete");
    assert!(!path.exists());
    assert_eq!(
        store.task_get(&task.id).expect("task").state.as_deref(),
        Some("deleted")
    );
    store
        .task_delete_record(&other.id, false, |_| {})
        .expect("clean merged delete");
}
#[test]
fn copy_failure_rolls_back_owned_worktree_and_branch_and_records_error() {
    let Some((_temp, store, id, repo)) = fixture() else {
        return;
    };
    let mut project = store.projects().get(&id).expect("get").expect("project");
    project.copy_files = Some(r#"[{"path":"missing.txt","mode":"copy"}]"#.into());
    store.project_update_record(project.clone()).expect("update");
    assert!(store.task_create_record(input(&id, "copy fails"), |_| {}).is_err());
    let task = store.tasks().list().expect("list").pop().expect("error task");
    assert_eq!(task.state.as_deref(), Some("error"));
    assert!(task.last_message.is_some());
    assert_eq!(task.port_start, None);
    assert!(!tessera_git::branch_exists(&repo, &task.branch).expect("branch"));
    assert!(
        !Path::new(project.worktree_dir.as_ref().expect("root"))
            .join(&task.slug)
            .exists()
    );
    assert_eq!(tessera_git::worktree_list(&repo).expect("worktrees").len(), 1);
}
#[test]
fn existing_branch_and_existing_destination_are_preserved() {
    let Some((_temp, store, id, repo)) = fixture() else {
        return;
    };
    git(&repo, &["branch", "tessera/existing"]);
    assert!(matches!(
        store.task_create_record(input(&id, "existing"), |_| {}),
        Err(TaskError::Git(tessera_git::GitError::BranchExists))
    ));
    assert!(tessera_git::branch_exists(&repo, "tessera/existing").expect("branch"));
    let failed = store.tasks().list().expect("list").pop().expect("error task");
    store
        .task_delete_record(&failed.id, true, |_| {})
        .expect("delete failed task record");
    assert!(tessera_git::branch_exists(&repo, "tessera/existing").expect("foreign branch preserved"));
    let project = store.projects().get(&id).expect("project").expect("project");
    let path = Path::new(project.worktree_dir.as_ref().expect("root")).join("destination");
    std::fs::create_dir_all(&path).expect("dir");
    std::fs::write(path.join("kept"), "kept").expect("kept");
    assert!(matches!(
        store.task_create_record(input(&id, "destination"), |_| {}),
        Err(TaskError::Git(tessera_git::GitError::PathExists))
    ));
    assert_eq!(std::fs::read_to_string(path.join("kept")).expect("kept"), "kept");
}
#[test]
fn setup_file_transfer_and_approval_never_execute_a_script() {
    let Some((_temp, store, id, repo)) = fixture() else {
        return;
    };
    std::fs::write(repo.join("config.local"), "private fixture data").expect("file");
    let mut project = store.projects().get(&id).expect("project").expect("project");
    project.copy_files = Some(r#"[{"path":"config.local","mode":"copy"}]"#.into());
    project.setup_script = Some("touch NEVER_EXECUTE".into());
    project.setup_shell = Some("bash".into());
    project = store.project_update_record(project).expect("update");
    assert_eq!(
        tessera_store::projects::setup_state(&project),
        SetupState::NeedsApproval
    );
    let mut request = input(&id, "setup");
    request.run_setup = true;
    let task_id = match store.task_create_record(request, |_| {}) {
        Err(TaskError::SetupNotApproved { task_id }) => task_id,
        result => panic!("expected setup approval error: {result:?}"),
    };
    let task = store.task_get(&task_id).expect("task");
    let path = PathBuf::from(task.worktree_path.expect("path"));
    assert_eq!(
        std::fs::read_to_string(path.join("config.local")).expect("copy"),
        "private fixture data"
    );
    assert!(!path.join("NEVER_EXECUTE").exists());
    store.project_approve_setup(&id).expect("approve");
    let mut request = input(&id, "approved");
    request.run_setup = true;
    let task = store.task_create_record(request, |_| {}).expect("approved");
    assert!(
        !Path::new(task.worktree_path.as_ref().expect("path"))
            .join("NEVER_EXECUTE")
            .exists()
    );
}
#[test]
fn main_checkout_never_deletes_files_or_branch() {
    let Some((_temp, store, id, repo)) = fixture() else {
        return;
    };
    let mut request = input(&id, "main task");
    request.use_main_checkout = true;
    let task = store.task_create_record(request, |_| {}).expect("main");
    assert_eq!(task.branch, "main");
    assert_eq!(task.worktree_path, None);
    std::fs::write(repo.join("dirty.txt"), "do not remove").expect("dirty");
    store.task_archive_record(&task.id, |_| {}).expect("archive");
    store.task_restore_record(&task.id, |_| {}).expect("restore");
    store.task_delete_record(&task.id, true, |_| {}).expect("delete");
    assert_eq!(
        std::fs::read_to_string(repo.join("dirty.txt")).expect("kept"),
        "do not remove"
    );
    assert!(tessera_git::branch_exists(&repo, "main").expect("main exists"));
}
#[test]
fn port_allocator_is_deterministic_fills_gaps_and_detects_exhaustion() {
    assert_eq!(allocate_ports(10000, 10039, &[(10010, 10)]).expect("free"), 10000);
    assert_eq!(
        allocate_ports(10000, 10039, &[(10020, 10), (10000, 10)]).expect("gap"),
        10010
    );
    assert_eq!(
        allocate_ports(10000, 10039, &[(10000, 10), (10020, 10)]).expect("same gap"),
        10010
    );
    assert!(allocate_ports(65530, 65535, &[]).is_err());
    assert!(allocate_ports(0, 65535, &[]).is_err());
    assert!(allocate_ports(10000, 10019, &[(10000, 20)]).is_err());
}

#[test]
fn generated_names_unique_slugs_and_restore_exhaustion() {
    let Some((_temp, store, id, _repo)) = fixture() else {
        return;
    };
    let mut project = store.projects().get(&id).expect("get").expect("project");
    project.port_base = Some(65526);
    store.project_update_record(project).expect("update");
    let first = store.task_create_record(input(&id, "same"), |_| {}).expect("first");
    assert!(matches!(
        store.task_create_record(input(&id, "blocked"), |_| {}),
        Err(TaskError::PortsExhausted)
    ));
    store.task_archive_record(&first.id, |_| {}).expect("archive");
    let second = store.task_create_record(input(&id, "same"), |_| {}).expect("second");
    assert_eq!(second.slug, "same-2");
    assert!(matches!(
        store.task_restore_record(&first.id, |_| {}),
        Err(TaskError::PortsExhausted)
    ));
    assert_eq!(
        store.task_get(&first.id).expect("first").state.as_deref(),
        Some("archived")
    );
    store.task_archive_record(&second.id, |_| {}).expect("archive");
    store.task_restore_record(&first.id, |_| {}).expect("restore");
    store.task_archive_record(&first.id, |_| {}).expect("archive");
    let mut request = input(&id, "");
    request.name = None;
    let generated = store.task_create_record(request, |_| {}).expect("generated");
    assert!(generated.name.starts_with("Task "));
}

#[cfg(target_os = "macos")]
#[test]
fn symlink_transfer_is_contained_and_outside_source_is_rejected() {
    let Some((temp, store, id, repo)) = fixture() else {
        return;
    };
    std::fs::write(repo.join("local.txt"), "local").expect("local");
    let mut project = store.projects().get(&id).expect("get").expect("project");
    project.copy_files = Some(r#"[{"path":"local.txt","mode":"symlink"}]"#.into());
    store.project_update_record(project.clone()).expect("update");
    let task = store
        .task_create_record(input(&id, "linked"), |_| {})
        .expect("link task");
    let path = PathBuf::from(task.worktree_path.expect("path")).join("local.txt");
    assert!(path.symlink_metadata().expect("metadata").file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(path).expect("read"), "local");
    let outside = temp.path().join("outside.txt");
    std::fs::write(&outside, "outside").expect("outside");
    std::os::unix::fs::symlink(&outside, repo.join("escape.txt")).expect("symlink");
    project.copy_files = Some(r#"[{"path":"escape.txt","mode":"copy"}]"#.into());
    store.project_update_record(project).expect("update");
    assert!(matches!(
        store.task_create_record(input(&id, "escape"), |_| {}),
        Err(TaskError::Invalid(_))
    ));
    assert_eq!(std::fs::read_to_string(outside).expect("outside"), "outside");
}
#[test]
fn a_task_can_use_an_existing_branch_and_deleting_it_keeps_the_branch() {
    let Some((_temp, store, id, repo)) = fixture() else {
        return;
    };
    git(&repo, &["branch", "tessera/boss"]);
    let mut request = input(&id, "boss");
    request.existing_branch = Some("tessera/boss".into());
    let task = store
        .task_create_record(request, |_| {})
        .expect("create on the existing branch");
    assert_eq!(task.branch, "tessera/boss");
    assert_eq!(task.state.as_deref(), Some("active"));
    let path = PathBuf::from(task.worktree_path.as_ref().expect("worktree"));
    assert!(path.join("hello.txt").exists());
    let branches = tessera_git::branch_list(&repo).expect("branches");
    assert!(branches.contains(&"main".to_string()) && branches.contains(&"tessera/boss".to_string()));
    // The same branch cannot be checked out twice, so a second task works in the first one's folder.
    let mut again = input(&id, "boss again");
    again.existing_branch = Some("tessera/boss".into());
    let second = store
        .task_create_record(again, |_| {})
        .expect("second task shares the worktree");
    assert_eq!(
        std::fs::canonicalize(second.worktree_path.as_ref().unwrap()).unwrap(),
        std::fs::canonicalize(&path).unwrap()
    );
    store
        .task_delete_record(&second.id, false, |_| {})
        .expect("delete the sharing task");
    assert!(path.exists(), "deleting the sharing task leaves the folder");
    store.task_delete_record(&task.id, false, |_| {}).expect("delete");
    assert!(!path.exists());
    assert!(tessera_git::branch_exists(&repo, "tessera/boss").expect("the user's branch survives"));
}
#[test]
fn a_branch_already_checked_out_in_a_worktree_is_adopted_not_refused() {
    let Some((temp, store, id, repo)) = fixture() else {
        return;
    };
    git(&repo, &["branch", "tessera/other"]);
    let other = temp.path().join("other worktree");
    git(&repo, &["worktree", "add", other.to_str().unwrap(), "tessera/other"]);
    let mut request = input(&id, "adopt");
    request.existing_branch = Some("tessera/other".into());
    let task = store
        .task_create_record(request, |_| {})
        .expect("adopt the existing worktree");
    assert_eq!(task.branch, "tessera/other");
    assert_eq!(task.state.as_deref(), Some("active"));
    assert_eq!(
        std::fs::canonicalize(task.worktree_path.as_ref().unwrap()).unwrap(),
        std::fs::canonicalize(&other).unwrap()
    );
    store.task_delete_record(&task.id, true, |_| {}).expect("delete");
    assert!(other.join("hello.txt").exists(), "the user's worktree is untouched");
    assert!(tessera_git::branch_exists(&repo, "tessera/other").unwrap());

    // The branch checked out in the main folder becomes a main-checkout task.
    let mut main = input(&id, "on main");
    main.existing_branch = Some("main".into());
    let task = store.task_create_record(main, |_| {}).expect("main checkout task");
    assert_eq!(task.uses_main_checkout, Some(1));
    assert_eq!(task.branch, "main");
}
