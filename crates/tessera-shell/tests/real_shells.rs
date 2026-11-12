//! Real PTY acceptance: isolated startup files, event deadlines and a minimal terminal query responder.
use std::{
    collections::BTreeMap,
    fs,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use tessera_pty::{PtyEvent, PtyHost, SessionId, SpawnSpec};
use tessera_shell::{ShellEvent, ShellParser, prepare_installed_launch};

struct Running {
    host: PtyHost,
    id: SessionId,
    events: mpsc::Receiver<PtyEvent>,
    parser: ShellParser,
    marks: Vec<ShellEvent>,
    output: Vec<u8>,
    /// Last bytes of the previous chunk, so a query split across two chunks is still found exactly once.
    query_tail: Vec<u8>,
    _directory: tempfile::TempDir,
}

impl Running {
    fn start(shell: &str, login: bool, enabled: bool) -> Option<Self> {
        let current: BTreeMap<String, String> = std::env::vars().collect();
        let Some(program) = tessera_pty::find_program(shell, &current, tessera_pty::Platform::current()) else {
            eprintln!("SKIP {shell}: executable is not installed");
            return None;
        };
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().join("cwd space λ#");
        let user = directory.path().join("user startup");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&user).unwrap();
        fs::write(user.join(".zshenv"), "printf 'USER_ENV\\n'\n").unwrap();
        fs::write(user.join(".zprofile"), "printf 'USER_PROFILE\\n'\n").unwrap();
        fs::write(
            user.join(".zshrc"),
            "printf 'USER_RC\\n'\nPS1='TEST> '\nprecmd() { return 0; }\n",
        )
        .unwrap();
        fs::write(user.join(".zlogin"), "printf 'USER_LOGIN\\n'\n").unwrap();
        fs::write(user.join(".bashrc"), "printf 'USER_RC\\n'\nPS1='TEST> '\nPROMPT_COMMAND='printf \"USER_PROMPT:%s\\n\" \"$?\"'\ntrap 'true' DEBUG\n").unwrap();
        fs::write(
            user.join(".bash_profile"),
            "printf 'USER_PROFILE\\n'\nsource \"$HOME/.bashrc\"\n",
        )
        .unwrap();
        let config = user.join("fish");
        fs::create_dir_all(&config).unwrap();
        fs::write(
            config.join("config.fish"),
            "function fish_prompt; printf 'TEST> '; end\n",
        )
        .unwrap();
        let mut env = current;
        env.insert("HOME".into(), user.to_string_lossy().into_owned());
        env.insert("ZDOTDIR".into(), user.to_string_lossy().into_owned());
        env.insert("XDG_CONFIG_HOME".into(), user.to_string_lossy().into_owned());
        env.insert("XDG_DATA_HOME".into(), user.join("data").to_string_lossy().into_owned());
        env.insert("SHELL_INTEGRATION".into(), "on".into());
        // Test-only: do not import real PowerShell user profiles.
        let args = if shell.starts_with("pwsh") {
            vec!["-NoProfile".into(), "-NoLogo".into()]
        } else if login {
            vec!["-l".into()]
        } else {
            vec![]
        };
        let plan =
            prepare_installed_launch(&program.to_string_lossy(), &args, &env, directory.path(), enabled).unwrap();
        assert_eq!(plan.injected, enabled);
        env.extend(plan.env);
        let mut spec = SpawnSpec::new(cwd);
        spec.program = Some(program.to_string_lossy().into_owned());
        spec.args = plan.args;
        spec.env = env;
        let host = PtyHost::new();
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let id = host
            .spawn_with_sink(
                spec,
                Some(Arc::new(move |event| {
                    let _ = sender.lock().unwrap().send(event);
                })),
            )
            .unwrap();
        Some(Self {
            host,
            id,
            events,
            parser: ShellParser::default(),
            marks: Vec::new(),
            output: Vec::new(),
            query_tail: Vec::new(),
            _directory: directory,
        })
    }

    fn send(&mut self, command: &str) {
        self.marks.clear();
        self.output.clear();
        self.host.write(&self.id, command.as_bytes()).unwrap();
    }

    fn wait(&mut self, predicate: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(if cfg!(windows) { 36 } else { 12 });
        while !predicate(self) {
            let event = self
                .events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| {
                    panic!(
                        "{error}: marks={:?}, output={}",
                        self.marks,
                        String::from_utf8_lossy(&self.output)
                    )
                });
            match event {
                PtyEvent::Data(bytes) => {
                    self.host.ack(&self.id, bytes.len()).unwrap();
                    self.output.extend(&bytes);
                    self.answer_cursor_queries(&bytes);
                    self.marks.extend(self.parser.feed(&bytes));
                }
                PtyEvent::Exit { code } => panic!("shell exited {code}: {}", String::from_utf8_lossy(&self.output)),
            }
        }
    }

    /// Replies once per cursor-position request (`ESC[6n`) in the NEW bytes. Answering on already-seen output would
    /// repeat the reply on every chunk, and PowerShell's line editor eats those stray bytes as typed input.
    fn answer_cursor_queries(&mut self, bytes: &[u8]) {
        const QUERY: &[u8] = b"\x1b[6n";
        let mut window = std::mem::take(&mut self.query_tail);
        window.extend_from_slice(bytes);
        for _ in window.windows(QUERY.len()).filter(|part| *part == QUERY) {
            let _ = self.host.write(&self.id, b"\x1b[1;1R");
        }
        let keep = window.len().min(QUERY.len() - 1);
        self.query_tail = window[window.len() - keep..].to_vec();
    }

    fn prompt(&mut self) {
        self.wait(|running| running.marks.contains(&ShellEvent::PromptEnd));
        self.settle();
    }

    /// PSReadLine on Windows finishes setting up the line editor after the prompt is drawn and drops characters typed
    /// in that window. Waiting for a quiet moment makes the next command reliable. Other shells need no wait.
    fn settle(&mut self) {
        if !cfg!(windows) {
            return;
        }
        while let Ok(event) = self.events.recv_timeout(Duration::from_millis(600)) {
            if let PtyEvent::Data(bytes) = event {
                self.host.ack(&self.id, bytes.len()).unwrap();
                self.answer_cursor_queries(&bytes);
                self.output.extend(&bytes);
                self.marks.extend(self.parser.feed(&bytes));
            }
        }
    }

    fn command(&mut self, command: &str, expected: i32) {
        self.send(command);
        self.wait(|running| {
            running.marks.contains(&ShellEvent::CommandEnd { exit: expected })
                && running.marks.contains(&ShellEvent::PromptEnd)
        });
        assert_eq!(
            self.marks
                .iter()
                .filter(|event| matches!(event, ShellEvent::CommandStart))
                .count(),
            1,
            "{:?}",
            self.marks
        );
        assert_eq!(
            self.marks
                .iter()
                .filter(|event| matches!(event, ShellEvent::CommandEnd { .. }))
                .count(),
            1,
            "{:?}",
            self.marks
        );
        let start = self
            .marks
            .iter()
            .position(|event| *event == ShellEvent::CommandStart)
            .unwrap();
        let end = self
            .marks
            .iter()
            .position(|event| *event == ShellEvent::CommandEnd { exit: expected })
            .unwrap();
        assert!(
            start < end,
            "marks={:?}, output={}",
            self.marks,
            String::from_utf8_lossy(&self.output)
        );
        self.settle();
    }
}

#[cfg(not(windows))]
fn posix(shell: &str, login: bool) {
    let Some(mut running) = Running::start(shell, login, true) else {
        return;
    };
    running.prompt();
    assert!(running.marks.contains(&ShellEvent::PromptStart));
    assert!(
        running
            .marks
            .iter()
            .any(|mark| matches!(mark, ShellEvent::Cwd { path } if path.ends_with("cwd space λ#"))),
        "marks={:?}, output={}",
        running.marks,
        String::from_utf8_lossy(&running.output)
    );
    let startup = String::from_utf8_lossy(&running.output);
    if shell != "fish" {
        assert!(startup.contains("USER_RC"), "{startup}");
    }
    if login {
        assert!(startup.contains("USER_PROFILE"), "{startup}");
    }
    if login && shell == "zsh" {
        assert!(startup.contains("USER_LOGIN"), "{startup}");
    }
    running.command("echo hi\r", 0);
    running.command("false\r", 1);
    if shell == "bash" {
        assert!(String::from_utf8_lossy(&running.output).contains("USER_PROMPT:1"));
    }
    running.command("echo recovered\r", 0);
    running.command("cd ..\r", 0);
    assert!(
        running
            .marks
            .iter()
            .any(|mark| matches!(mark, ShellEvent::Cwd { path } if !path.ends_with("cwd space λ#"))),
        "marks={:?}, output={}",
        running.marks,
        String::from_utf8_lossy(&running.output)
    );
}

#[test]
#[cfg(not(windows))]
fn bash_real_commands_and_login_startup() {
    posix("bash", false);
    posix("bash", true);
}
#[test]
#[cfg(not(windows))]
fn zsh_real_commands_and_login_startup() {
    posix("zsh", false);
    posix("zsh", true);
}
#[test]
#[cfg(not(windows))]
fn fish_real_commands() {
    posix("fish", false);
}

#[test]
fn powershell_real_commands() {
    let name = if cfg!(windows) { "pwsh.exe" } else { "pwsh" };
    let Some(mut running) = Running::start(name, false, true) else {
        return;
    };
    running.prompt();
    running.command("Write-Output hi\r", 0);
    running.send("Write-Error 'intentional test failure'\r");
    running.wait(|running| {
        running
            .marks
            .iter()
            .any(|mark| matches!(mark, ShellEvent::CommandEnd { exit } if *exit != 0))
            && running.marks.contains(&ShellEvent::PromptEnd)
    });
    running.command("Write-Output recovered\r", 0);
}

#[test]
#[cfg(not(windows))]
fn disabled_integration_leaves_shell_usable_and_emits_no_marks() {
    for shell in ["bash", "zsh"] {
        let Some(mut running) = Running::start(shell, false, false) else {
            continue;
        };
        running.wait(|running| String::from_utf8_lossy(&running.output).contains("TEST> "));
        running.send("printf 'disabled-%s\\n' ok\r");
        running.wait(|running| String::from_utf8_lossy(&running.output).contains("disabled-ok"));
        assert!(running.marks.is_empty(), "{:?}", running.marks);
    }
}
