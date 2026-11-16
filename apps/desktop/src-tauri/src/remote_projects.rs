//! Projects on an SSH host (M10.2, FR-63).
//!
//! A remote project's path is `ssh://<alias>/<path on the host>` (see `tessera_git::remote`). Git runs on the host
//! through the system `ssh`, so tasks and worktrees are created there and status and diffs come back as text. Panes in
//! a remote task (shells and agents) are `ssh -tt <host> 'cd <worktree> && exec …'` in an ordinary local PTY, so the
//! terminal, status patterns and attention signals work as for local panes. The host must have a POSIX shell and
//! `git`; agents must be installed on the host. Hooks are not installed on the host: agent status there comes from the
//! terminal (OSC, patterns, silence).
use crate::{
    error::AppError,
    project_types::Project,
    ssh_commands::{SshHostInfo, SshLaunch, resolve_launch_with},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tessera_git::remote::{self, RemoteHost};
use tessera_pty::SpawnSpec;

/// The ssh launch as a [`RemoteHost`]: the plan's arguments minus the target, which comes last.
#[must_use]
pub fn remote_host(launch: SshLaunch) -> Option<RemoteHost> {
    let mut options = launch.args;
    let target = options.pop()?;
    Some(RemoteHost {
        program: PathBuf::from(launch.program),
        options,
        target,
        env: launch.env,
    })
}

/// Lets `tessera_git` reach SSH hosts. The resolver opens its own store connection: Git calls on a remote path can
/// happen while the app's store lock is held (task creation), so it must never take that lock.
pub fn install(app: &tauri::AppHandle) {
    let app = app.clone();
    remote::set_resolver(move |alias| {
        let dirs = app.state::<AppState>().dirs.clone();
        let saved = tessera_store::Store::open(&dirs).ok()?.ssh_hosts().ok()?;
        let (_, launch) = resolve_launch_with(&app, saved, |h| h.alias == alias).ok()?;
        remote_host(launch)
    });
}

/// Turns a pane whose working directory is on an SSH host into `ssh -tt` with a local working directory. Local panes
/// pass through unchanged.
///
/// # Errors
/// `ssh.remote_failed` when the host is not in the list.
pub fn localize(mut spec: SpawnSpec, local_home: &Path) -> Result<SpawnSpec, AppError> {
    let Some((alias, dir)) = remote::split(&spec.cwd) else {
        return Ok(spec);
    };
    let host = remote::host(&alias).map_err(|e| AppError::new(e.code(), e.to_string()))?;
    spec.args = host.pane_args(&dir, &remote_command(&spec));
    spec.program = Some(host.program.to_string_lossy().into_owned());
    spec.env.extend(host.env);
    spec.cwd = local_home.to_path_buf();
    Ok(spec)
}

/// What runs on the host: the login shell, or the program with its `TESSERA_*` and profile environment.
fn remote_command(spec: &SpawnSpec) -> String {
    let mut line = String::from("env");
    for (key, value) in &spec.env {
        // A shell pane forwards only Tessera's own variables; an agent also gets its profile's environment.
        if (spec.program.is_some() || key.starts_with("TESSERA_"))
            && !(spec.task_id.is_some() && key == "TESSERA_TASK_ID")
            && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            line.push_str(&format!(" {key}={}", remote::quote(value)));
        }
    }
    if let Some(task) = &spec.task_id {
        line.push_str(&format!(" TESSERA_TASK_ID={}", remote::quote(task)));
    }
    match &spec.program {
        None => line.push_str(" \"${SHELL:-/bin/sh}\" -l"),
        Some(program) => {
            line.push(' ');
            line.push_str(&remote::quote(program));
            for arg in &spec.args {
                line.push(' ');
                line.push_str(&remote::quote(arg));
            }
        }
    }
    line
}

/// Adds a repository on an SSH host.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RemoteProjectInput {
    /// Host id from the SSH host list.
    pub host_id: String,
    /// Repository folder on the host: absolute, or starting with `~/`.
    pub path: String,
    /// Display name (default: the folder name).
    pub name: Option<String>,
}

/// Adds a project on an SSH host: checks the folder is a Git repository there, and puts task worktrees under
/// `~/.tessera/worktrees/<project id>` on the host.
#[tauri::command]
#[specta::specta]
pub async fn project_add_remote(app: tauri::AppHandle, input: RemoteProjectInput) -> Result<Project, AppError> {
    tauri::async_runtime::spawn_blocking(move || add(&app, input))
        .await
        .map_err(|e| AppError::new("project.worker_failed", e.to_string()))?
}

fn git_error(error: tessera_git::GitError) -> AppError {
    match error {
        tessera_git::GitError::NotAGitRepo => {
            AppError::new("project.not_a_repo", "That folder on the host is not a Git repository.")
        }
        other => AppError::new(other.code(), other.to_string()),
    }
}

fn add(app: &tauri::AppHandle, input: RemoteProjectInput) -> Result<Project, AppError> {
    let host: SshHostInfo = {
        let saved = {
            let state = app.state::<AppState>();
            let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
            store
                .ssh_hosts()
                .map_err(|e| AppError::new("ssh.store", e.to_string()))?
        };
        resolve_launch_with(app, saved, |h| h.id == input.host_id)?.0
    };
    let alias = host.alias;
    let home = remote::home(&alias).map_err(git_error)?;
    let path = input.path.trim();
    let path = match path.strip_prefix("~") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
        _ => path.to_owned(),
    };
    if !path.starts_with('/') {
        return Err(AppError::new(
            "project.invalid_input",
            "Enter the folder on the host as an absolute path, or one that starts with ~/.",
        ));
    }
    let repo = tessera_git::Repo::open(remote::encode(&alias, &path)).map_err(git_error)?;
    let worktrees = remote::encode(&alias, &format!("{home}/.tessera/worktrees"));
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let mut project = store.project_add_remote(&repo, &input.host_id, &worktrees)?;
    if let Some(name) = input.name.filter(|n| !n.trim().is_empty()) {
        project.name = name;
        project = store.project_update_record(project)?;
    }
    Project::try_from(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn host() -> RemoteHost {
        RemoteHost {
            program: "/usr/bin/ssh".into(),
            options: vec!["-p".into(), "2222".into()],
            target: "box".into(),
            env: BTreeMap::from([("SSH_ASKPASS".to_owned(), "/x/tessera".to_owned())]),
        }
    }

    #[test]
    fn a_launch_becomes_a_remote_host() {
        let launch = SshLaunch {
            program: "/usr/bin/ssh".into(),
            args: vec!["-p".into(), "2222".into(), "box".into()],
            env: host().env,
            title: "box".into(),
            notice: None,
        };
        assert_eq!(remote_host(launch), Some(host()));
    }

    #[test]
    fn remote_panes_run_ssh_with_the_shell_or_the_agent_on_the_host() {
        remote::set_resolver(|alias| (alias == "box").then(host));
        let home = Path::new("/Users/me");
        let mut spec = SpawnSpec::new("ssh://box/srv/wt/fix");
        spec.task_id = Some("t1".into());
        spec.env.insert("ZDOTDIR".into(), "/local/only".into());
        let shell = localize(spec.clone(), home).unwrap();
        assert_eq!(shell.program.as_deref(), Some("/usr/bin/ssh"));
        assert_eq!(shell.cwd, home);
        assert_eq!(
            shell.args.last().unwrap(),
            "cd '/srv/wt/fix' && exec env TESSERA_TASK_ID='t1' \"${SHELL:-/bin/sh}\" -l"
        );
        assert_eq!(shell.env.get("SSH_ASKPASS").map(String::as_str), Some("/x/tessera"));
        let mut agent = spec.clone();
        agent.env.clear();
        agent.program = Some("claude".into());
        agent.args = vec!["--resume".into(), "it's".into()];
        agent.env.insert("TESSERA_AGENT".into(), "claude".into());
        assert_eq!(
            localize(agent, home).unwrap().args.last().unwrap(),
            "cd '/srv/wt/fix' && exec env TESSERA_AGENT='claude' TESSERA_TASK_ID='t1' 'claude' '--resume' 'it'\\''s'"
        );
        let local = SpawnSpec::new("/tmp");
        assert_eq!(localize(local.clone(), home).unwrap().cwd, local.cwd);
        let unknown = SpawnSpec::new("ssh://nope/x");
        assert_eq!(localize(unknown, home).unwrap_err().code, "ssh.remote_failed");
    }

    /// A remote project end to end against a real sshd (the same `TESSERA_SSH_LIVE_*` variables as the SSH login
    /// test; the host needs a POSIX shell and git): add the repository, create a task (branch and worktree on the
    /// host), read status and changed files, run a pane in the worktree through `ssh -tt`, delete the task.
    #[test]
    #[ignore = "needs a real sshd (TESSERA_SSH_LIVE_HOST and friends)"]
    fn live_remote_project() {
        use crate::ssh_commands::{forget_password, keychain, known_host, plan};
        use std::sync::{Arc, Mutex, mpsc};
        use std::time::{Duration, Instant};
        use tessera_pty::{EventSink, PtyEvent, PtyHost};
        use tessera_store::{DataDirs, Store, tasks::CreateTask};

        let var = |name: &str| {
            std::env::var(format!("TESSERA_SSH_LIVE_{name}"))
                .ok()
                .filter(|v| !v.is_empty())
        };
        let password = var("PASSWORD");
        let alias = format!("tessera-remote-{}", std::process::id());
        if let Some(password) = &password {
            keychain(&alias).unwrap().set_password(password).unwrap();
        }
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let ssh = tessera_pty::find_program(
            if cfg!(windows) { "ssh.exe" } else { "ssh" },
            &env,
            tessera_pty::Platform::current(),
        )
        .unwrap();
        let cli = var("CLI").map(PathBuf::from).unwrap_or_else(|| {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(3).unwrap();
            root.join("target")
                .join("debug")
                .join(if cfg!(windows) { "tessera.exe" } else { "tessera" })
        });
        let info = SshHostInfo {
            id: "live".into(),
            alias: alias.clone(),
            host: var("HOST").expect("TESSERA_SSH_LIVE_HOST"),
            port: var("PORT").map(|p| p.parse().unwrap()),
            user: var("USER"),
            auth: if password.is_some() { "password" } else { "key" }.into(),
            key_path: var("KEY"),
            proxy_jump: None,
            source: "manual".into(),
            password_saved: password.is_some(),
        };
        let mut launch = plan(&info, &ssh, &cli, |t| known_host(&ssh, t));
        let target = launch.args.pop().unwrap();
        if password.is_some() {
            launch.args.extend(["-o".into(), "PubkeyAuthentication=no".into()]);
        }
        launch.args.extend(
            var("OPTS")
                .map(|o| o.split_whitespace().map(String::from).collect::<Vec<_>>())
                .unwrap_or_default(),
        );
        launch.args.push(target);
        let host = remote_host(launch).unwrap();
        let resolved = host.clone();
        let wanted = alias.clone();
        remote::set_resolver(move |a| (a == wanted).then(|| resolved.clone()));

        // A repository on the host with one commit.
        let home = remote::home(&alias).expect("reach the host");
        let base = format!("{home}/tessera-live-{}", std::process::id());
        let repo_dir = format!("{base}/repo");
        remote::shell(
            &alias,
            &format!(
                "mkdir -p {0} && cd {0} && git init -q -b main && echo one > a.txt && git add a.txt && \
                 git -c user.email=t@example.com -c user.name=t commit -q -m init",
                remote::quote(&repo_dir)
            ),
            Duration::from_secs(30),
        )
        .expect("create the repository on the host");

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let repo = tessera_git::Repo::open(remote::encode(&alias, &repo_dir)).expect("open over ssh");
            assert_eq!(repo.root, PathBuf::from(remote::encode(&alias, &repo_dir)));
            assert_eq!(repo.default_branch.as_deref(), Some("main"));
            let data = tempfile::tempdir().unwrap();
            let store = Store::open(&DataDirs::from_root(data.path())).unwrap();
            let project = store
                .project_add_remote(&repo, "live", &remote::encode(&alias, &format!("{base}/wt")))
                .unwrap();
            let task = store
                .task_create_record(
                    CreateTask {
                        project_id: project.id.clone(),
                        name: Some("Remote fix".into()),
                        prompt: None,
                        base_branch: "main".into(),
                        existing_branch: None,
                        branch_name: None,
                        use_main_checkout: false,
                        run_setup: false,
                    },
                    |_| {},
                )
                .expect("create the task on the host");
            let worktree = PathBuf::from(task.worktree_path.clone().unwrap());
            let (_, worktree_dir) = remote::split(&worktree).unwrap();
            assert!(worktree_dir.starts_with(&format!("{base}/wt/")), "{worktree_dir}");
            assert!(remote::exists(&worktree).unwrap());
            remote::shell(
                &alias,
                &format!("echo two >> {}/a.txt", remote::quote(&worktree_dir)),
                Duration::from_secs(20),
            )
            .unwrap();
            let changed = tessera_git::changed_files(&worktree, "main").unwrap();
            assert_eq!(changed.len(), 1, "{changed:?}");
            assert!(!tessera_git::status(&worktree).unwrap().files.is_empty());

            // The review panel's data over ssh (M7.1 on M10.2): files, diff texts, a path with a space.
            remote::shell(
                &alias,
                &format!(
                    "cd {0} && echo x > 'new file.txt' && git mv a.txt b.txt",
                    remote::quote(&worktree_dir)
                ),
                Duration::from_secs(20),
            )
            .unwrap();
            let files = tessera_git::review_files(&worktree, "main").expect("review files over ssh");
            let names: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
            assert!(names.contains(&"new file.txt") && names.contains(&"b.txt"), "{names:?}");
            let diff = tessera_git::review_file_diff(&worktree, "main", "new file.txt").expect("diff over ssh");
            assert!(format!("{diff:?}").contains('x'), "{diff:?}");

            // A pane in the task: `git` runs in the worktree on the host and prints the task branch.
            let mut spec = SpawnSpec::new(&worktree);
            spec.program = Some("git".into());
            spec.args = vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()];
            let home_dir = tempfile::tempdir().unwrap();
            let spec = localize(spec, home_dir.path()).unwrap();
            let pty = PtyHost::new();
            let (sender, events) = mpsc::channel();
            let sender = Mutex::new(sender);
            let sink: EventSink = Arc::new(move |event| {
                let _ = sender.lock().unwrap().send(event);
            });
            let id = pty.spawn_with_sink(spec, Some(sink)).unwrap();
            let mut output = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(60);
            let code = loop {
                assert!(Instant::now() < deadline, "{}", String::from_utf8_lossy(&output));
                match events.recv_timeout(Duration::from_millis(250)) {
                    Ok(PtyEvent::Data(bytes)) => {
                        pty.ack(&id, bytes.len()).unwrap();
                        if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                            let _ = pty.write(&id, b"\x1b[1;1R");
                        }
                        output.extend(bytes);
                    }
                    Ok(PtyEvent::Exit { code }) => break code,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => panic!("pty closed"),
                }
            };
            let text = String::from_utf8_lossy(&output);
            assert!(text.contains(&task.branch), "pane output: {text}");
            assert_eq!(code, 0, "pane output: {text}");

            store
                .task_delete_record(&task.id, true, |_| {})
                .expect("delete the task");
            assert!(
                !remote::exists(&worktree).unwrap(),
                "the worktree is gone from the host"
            );
            assert!(!tessera_git::branch_exists(&repo.root, &task.branch).unwrap());
        }));
        let _ = remote::shell(
            &alias,
            &format!("rm -rf {}", remote::quote(&base)),
            Duration::from_secs(30),
        );
        if password.is_some() {
            forget_password(&alias).unwrap();
        }
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}
