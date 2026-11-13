//! Offline launch acceptance; production launch commands never create a PTY.
use super::*;
use std::{
    path::Path,
    process::Command,
    sync::{Arc, OnceLock, mpsc},
    time::{Duration, Instant},
};
use tessera_store::{DataDirs, agents::AgentProfileInput as StoredProfile, tasks::CreateTask};

fn fake_binary() -> &'static Path {
    static FIXTURE: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    &FIXTURE
        .get_or_init(|| {
            let tmp = tempfile::tempdir().unwrap();
            let binary = tmp
                .path()
                .join(if cfg!(windows) { "fake_agent.exe" } else { "fake_agent" });
            let output = Command::new("rustc")
                .arg(
                    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../crates/tessera-agents/examples/fake_agent.rs"),
                )
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            (tmp, binary)
        })
        .1
}
struct Fixture {
    store: Store,
    context: LaunchContext,
    profile: String,
    _tmp: tempfile::TempDir,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("data");
        let bin = tmp.path().join("bin with spaces");
        let home = tmp.path().join("home with 界 spaces");
        std::fs::create_dir_all(config.join("agents")).unwrap();
        std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(&home).unwrap();
        std::fs::copy(fake_binary(), bin.join(fake_binary().file_name().unwrap())).unwrap();
        std::fs::write(
            config.join("agents/fake.toml"),
            format!(
                r#"id = 'fake'
name = 'Offline fake'
binaries = ['fake_agent']
version-cmd = ['fake_agent', '--version']
prompt-mode = '{mode}'
model-flag = '--model'
yolo-flags = ['--fixture-skip-permissions']
hooks = 'none'
ready-pattern = '(?m)^>\r?$'
install-url = 'https://example.invalid/fake'
docs-url = 'https://example.invalid/fake'
icon = 'terminal'
"#
            ),
        )
        .unwrap();
        let store = Store::open(&DataDirs::from_root(&config)).unwrap();
        let profile=store.agent_profiles().save(StoredProfile {id:None,agent_id:"fake".into(),name:"Fixture".into(),model:Some("fixture-model".into()),extra_args:r#"["--fixture-option"]"#.into(),env:r#"{"EXTRA_OPTION":"plain","tessera_agent":"spoof","Tessera_Agent_Session_Id":"spoof","tessera_task_id":"spoof","Tessera_Session_Id":"spoof"}"#.into(),skip_permissions:false,is_default:true}).unwrap().unwrap().id;
        Self {
            store,
            context: LaunchContext {
                config,
                home,
                env: [
                    ("Path".into(), bin.to_string_lossy().into_owned()),
                    ("PathExt".into(), ".EXE;.CMD".into()),
                ]
                .into(),
            },
            profile,
            _tmp: tmp,
        }
    }
    fn input(&self, prompt: Option<&str>) -> AgentStartInput {
        AgentStartInput {
            task_id: None,
            profile_id: self.profile.clone(),
            prompt: prompt.map(String::from),
            cwd: None,
        }
    }
    fn task(&self, main: bool) -> (String, PathBuf) {
        let repo = self.context.home.join(if main { "main repo" } else { "worktree repo" });
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        );
        let project = self.store.project_add_local(&repo, self._tmp.path()).unwrap();
        let task = self
            .store
            .task_create_record(
                CreateTask {
                    project_id: project.id,
                    name: Some("Agent task".into()),
                    prompt: None,
                    base_branch: "main".into(),
                    existing_branch: None,
                    branch_name: None,
                    use_main_checkout: main,
                    run_setup: false,
                },
                |_| {},
            )
            .unwrap();
        let checkout = task
            .worktree_path
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::fs::canonicalize(repo).unwrap());
        (task.id, checkout)
    }
}
fn git(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}
#[test]
fn launch_plans_cover_all_prompt_modes_and_reserve_environment() {
    for mode in ["arg", "stdin", "type", "flag:--prompt"] {
        let f = Fixture::new(mode);
        let (task_id, checkout) = f.task(false);
        let mut input = f.input(Some("literal prompt"));
        input.task_id = Some(task_id.clone());
        input.cwd = Some("ignored".into());
        let (plan, row) = start(&f.store, &f.context, input).unwrap();
        assert_eq!(plan.cwd, checkout.to_string_lossy());
        assert_eq!(plan.agent_session_id, row.id);
        assert_eq!(row.prompt.as_deref(), Some("literal prompt"));
        assert_eq!(row.status, "starting");
        assert_eq!(plan.env.get("TESSERA_AGENT_SESSION_ID"), Some(&row.id));
        assert_eq!(plan.env.get("TESSERA_AGENT"), Some(&"fake".into()));
        assert_eq!(plan.env.get("TESSERA_TASK_ID"), Some(&task_id));
        assert_eq!(plan.env.get("EXTRA_OPTION"), Some(&"plain".into()));
        assert!(!plan.env.keys().any(|k| k.eq_ignore_ascii_case("TESSERA_SESSION_ID")));
        assert_eq!(
            plan.env
                .keys()
                .filter(|k| k.eq_ignore_ascii_case("TESSERA_AGENT"))
                .count(),
            1
        );
        assert!(!plan.skip_permissions);
        assert!(!plan.args.contains(&"--fixture-skip-permissions".into()));
        assert!(Path::new(&plan.program).is_file());
        assert!(plan.program.contains("bin with spaces"));
        assert_eq!(&plan.args[..3], ["--model", "fixture-model", "--fixture-option"]);
        match mode {
            "arg" => assert_eq!(&plan.args[3..], ["--", "literal prompt"]),
            "stdin" => assert_eq!(plan.stdin.as_deref(), Some("literal prompt")),
            "type" => {
                assert_eq!(plan.type_after_ready.as_deref(), Some("literal prompt"));
                assert_eq!(plan.ready_pattern.as_deref(), Some(r"(?m)^>\r?$"));
            }
            _ => assert_eq!(&plan.args[3..], ["--prompt", "literal prompt"]),
        }
        assert_eq!(f.store.agent_sessions().events(&row.id).unwrap().len(), 1);
    }
}
#[test]
fn launch_errors_do_not_create_sessions_and_cwd_precedence_is_explicit() {
    let mut f = Fixture::new("arg");
    let mut missing = f.input(None);
    missing.profile_id = "missing".into();
    assert_eq!(
        start(&f.store, &f.context, missing).unwrap_err().code,
        "agent.profile_not_found"
    );
    let mut missing = f.input(None);
    missing.task_id = Some("missing".into());
    assert_eq!(start(&f.store, &f.context, missing).unwrap_err().code, "task.not_found");
    let path = f.context.env.remove("Path").unwrap();
    assert_eq!(
        start(&f.store, &f.context, f.input(None)).unwrap_err().code,
        "agent.not_installed"
    );
    assert!(f.store.agent_sessions().list(None).unwrap().is_empty());
    f.context.env.insert("Path".into(), path);
    let (home, _) = start(&f.store, &f.context, f.input(None)).unwrap();
    assert_eq!(home.cwd, f.context.home.to_string_lossy());
    assert_eq!(home.stdin, None);
    assert!(!home.env.contains_key("TESSERA_TASK_ID"));
    let explicit = f.context.home.join("explicit");
    std::fs::create_dir(&explicit).unwrap();
    let mut input = f.input(None);
    input.cwd = Some(explicit.to_string_lossy().into_owned());
    assert_eq!(
        start(&f.store, &f.context, input).unwrap().0.cwd,
        explicit.to_string_lossy()
    );
    let (task, checkout) = f.task(true);
    let mut input = f.input(None);
    input.task_id = Some(task);
    input.cwd = Some("ignored".into());
    // Compare as paths: Windows may report the same folder as `C:/…` or `\\?\C:\…`.
    let cwd = start(&f.store, &f.context, input).unwrap().0.cwd;
    assert_eq!(
        std::fs::canonicalize(&cwd).unwrap(),
        std::fs::canonicalize(&checkout).unwrap()
    );
}
#[test]
fn launch_restart_preserves_prompt_and_failed_restart_leaves_old_live() {
    let mut f = Fixture::new("arg");
    let (task, _) = f.task(false);
    let mut input = f.input(Some("same restart prompt"));
    input.task_id = Some(task.clone());
    let (_, old) = start(&f.store, &f.context, input).unwrap();
    let path = f.context.env.remove("Path").unwrap();
    assert_eq!(
        restart(&f.store, &f.context, &old.id).unwrap_err().code,
        "agent.not_installed"
    );
    assert_eq!(session(&f.store, &old.id).unwrap(), old);
    f.context.env.insert("Path".into(), path);
    assert_eq!(
        restart(&f.store, &f.context, "missing").unwrap_err().code,
        "agent.session_not_found"
    );
    let (plan, ended, new) = restart(&f.store, &f.context, &old.id).unwrap();
    assert_ne!(old.id, new.id);
    assert_eq!(ended.status, "exited");
    assert!(ended.ended_at.is_some());
    assert_eq!(new.status, "starting");
    assert_eq!(new.prompt, old.prompt);
    assert_eq!(new.profile_id, old.profile_id);
    assert_eq!(new.task_id.as_deref(), Some(task.as_str()));
    assert_eq!(plan.args.last().map(String::as_str), Some("same restart prompt"));
    assert_eq!(plan.env.get("TESSERA_AGENT_SESSION_ID"), Some(&new.id));
    let terminal = f
        .store
        .agent_sessions()
        .mark_exited(&new.id, 9, now_millis())
        .unwrap()
        .unwrap();
    let (_, unchanged, _) = restart(&f.store, &f.context, &new.id).unwrap();
    assert_eq!(unchanged, AgentSession::from(terminal));
}
#[test]
fn launch_permission_flags_require_profile_opt_in() {
    let f = Fixture::new("arg");
    let p = f.store.agent_profiles().get(&f.profile).unwrap().unwrap();
    let enabled = f
        .store
        .agent_profiles()
        .save(StoredProfile {
            id: Some(p.id),
            agent_id: p.agent_id,
            name: p.name,
            model: p.model,
            extra_args: p.extra_args,
            env: p.env,
            skip_permissions: true,
            is_default: p.is_default,
        })
        .unwrap()
        .unwrap();
    let (plan, _) = start(&f.store, &f.context, f.input(None)).unwrap();
    assert_eq!(plan.profile_id, enabled.id);
    assert!(plan.skip_permissions);
    assert!(plan.args.contains(&"--fixture-skip-permissions".into()));
    // Every bundled agent gets a default profile with the switch off. No executable is invoked.
    for entry in tessera_agents::Catalog::load(&f.context.config)
        .entries
        .into_iter()
        .filter(|e| e.source == "bundled")
    {
        let command =
            tessera_agents::command_line(&entry.definition, &tessera_agents::LaunchProfile::default(), None).unwrap();
        for flag in &entry.definition.yolo_flags {
            assert!(!command.args.contains(flag), "{}", entry.definition.id);
        }
    }
}
struct RunningPty {
    host: tessera_pty::PtyHost,
    id: tessera_pty::SessionId,
}
impl Drop for RunningPty {
    fn drop(&mut self) {
        let _ = self.host.kill(&self.id);
    }
}
#[test]
fn launch_plans_run_in_real_ptys_including_ready_gated_bracketed_paste() {
    for mode in ["arg", "stdin", "type", "flag:--prompt"] {
        let f = Fixture::new(mode);
        let prompt = format!("hello from {mode}");
        let (plan, row) = start(&f.store, &f.context, f.input(Some(&prompt))).unwrap();
        let host = tessera_pty::PtyHost::new();
        let (tx, rx) = mpsc::channel();
        let sink: tessera_pty::EventSink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let mut spec = tessera_pty::SpawnSpec::new(&plan.cwd);
        spec.program = Some(plan.program.clone());
        spec.args = plan.args.clone();
        spec.env = plan.env.clone();
        spec.env.insert("FAKE_AGENT_REPORT_CONTEXT".into(), "1".into());
        spec.task_id = plan.task_id.clone();
        let id = host.spawn_with_sink(spec, Some(sink)).unwrap();
        let running = RunningPty { host, id };
        f.store
            .agent_sessions()
            .set_pane_session(&row.id, &running.id.as_string(), "fixture-pane", now_millis())
            .unwrap();
        if let Some(stdin) = &plan.stdin {
            running
                .host
                .write(&running.id, format!("{stdin}\r").as_bytes())
                .unwrap();
        }
        let mut output = String::new();
        let mut typed = false;
        let deadline = Instant::now() + Duration::from_secs(if cfg!(windows) { 30 } else { 10 });
        let code = loop {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|e| panic!("{mode}: {e}: {output}"));
            match event {
                tessera_pty::PtyEvent::Data(bytes) => {
                    running.host.ack(&running.id, bytes.len()).unwrap();
                    if bytes.windows(4).any(|b| b == b"\x1b[6n") {
                        running.host.write(&running.id, b"\x1b[1;1R").unwrap();
                    }
                    output.push_str(&String::from_utf8_lossy(&bytes));
                    if let Some(prompt) = &plan.type_after_ready
                        && !typed
                    {
                        // This fixture's declared regex is (?m)^>\r?$. Match its line semantics exactly.
                        assert_eq!(plan.ready_pattern.as_deref(), Some(r"(?m)^>\r?$"));
                        // ConPTY wraps output in escape sequences (cursor moves, show/hide): match the visible text.
                        if strip_escapes(&output)
                            .lines()
                            .any(|line| line.trim_end_matches('\r').trim() == ">")
                        {
                            running
                                .host
                                .write(&running.id, format!("\x1b[200~{prompt}\x1b[201~\r").as_bytes())
                                .unwrap();
                            typed = true;
                        }
                    }
                }
                tessera_pty::PtyEvent::Exit { code } => break code,
            }
        };
        assert_eq!(code, 0, "{mode}: {output}");
        assert!(output.contains(&format!("prompt: {prompt}")), "{mode}: {output}");
        assert!(output.contains(&format!("agent-session: {}", row.id)), "{output}");
        assert!(
            output.contains(&format!("host-session: {}", running.id.as_string())),
            "{output}"
        );
        assert_eq!(typed, mode == "type");
        let exited = f
            .store
            .agent_sessions()
            .mark_exited(&row.id, i32::try_from(code).unwrap(), now_millis())
            .unwrap()
            .unwrap();
        assert_eq!(exited.status, "exited");
        assert_eq!(exited.exit_code, Some(0));
    }
}

/// Removes CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC \\`) and two-byte escapes, leaving the visible text.
#[cfg(test)]
fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' || (c == '\x1b' && chars.peek() == Some(&'\\')) {
                        if c == '\x1b' {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[test]
fn resume_requires_template_and_captured_id_and_omits_prompt() {
    let f = Fixture::new("arg");
    let (plan, _) = start(
        &f.store,
        &f.context,
        AgentStartInput {
            task_id: None,
            profile_id: f.profile.clone(),
            prompt: Some("original prompt".into()),
            cwd: Some(f.context.home.to_string_lossy().into_owned()),
        },
    )
    .unwrap();
    assert_eq!(
        resume(&f.store, &f.context, &plan.agent_session_id).unwrap_err().code,
        "agent.resume_unsupported"
    );
    let definition = f.context.config.join("agents/fake.toml");
    let text = std::fs::read_to_string(&definition).unwrap();
    std::fs::write(
        &definition,
        format!("{text}\nresume = ['fake_agent', '--resume', '{{external_session_id}}']\n"),
    )
    .unwrap();
    f.store
        .agent_sessions()
        .set_external_session_id(&plan.agent_session_id, "vendor-id")
        .unwrap();
    let (resumed, _) = resume(&f.store, &f.context, &plan.agent_session_id).unwrap();
    assert_eq!(resumed.args, ["--resume", "vendor-id"]);
    assert_eq!(resumed.cwd, plan.cwd);
    assert_eq!(resumed.profile_id, plan.profile_id);
    assert!(resumed.stdin.is_none() && resumed.type_after_ready.is_none());
    assert_ne!(resumed.agent_session_id, plan.agent_session_id);
}
