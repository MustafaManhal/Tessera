//! M8.1 spike as tests: terminal sessions outlive the client (the app) that started them and come back with their
//! scrollback. Real daemon process, real shells, deadline waits (3x longer on Windows), no fixed sleeps for results.

use std::path::Path;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tessera_pty::{EventSink, PtyEvent};
use tesserad::{Client, ClientError, Endpoint, SpawnRequest};

fn deadline(seconds: u64) -> Duration {
    Duration::from_secs(if cfg!(windows) { seconds * 3 } else { seconds })
}

fn start_daemon(dir: &Path, idle_seconds: u64) -> Child {
    Command::new(env!("CARGO_BIN_EXE_tesserad"))
        .arg("--data")
        .arg(dir)
        .args(["--idle-seconds", &idle_seconds.to_string(), "--no-login-environment"])
        .spawn()
        .expect("start tesserad")
}

fn connect(dir: &Path) -> Client {
    let endpoint = Endpoint::new(dir);
    let end = Instant::now() + deadline(10);
    loop {
        match Client::connect(&endpoint, "test") {
            Ok(client) => return client,
            Err(error) if Instant::now() >= end => panic!("daemon did not answer: {error}"),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn wait_exit(child: &mut Child, within: Duration) -> bool {
    let end = Instant::now() + within;
    while Instant::now() < end {
        if child.try_wait().expect("wait").is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[derive(Clone, Default)]
struct Collector {
    bytes: Arc<Mutex<Vec<u8>>>,
    exit: Arc<Mutex<Option<u32>>>,
}

impl Collector {
    fn sink(&self) -> EventSink {
        let this = self.clone();
        Arc::new(move |event| match event {
            PtyEvent::Data(bytes) => this.bytes.lock().unwrap().extend_from_slice(&bytes),
            PtyEvent::Exit { code } => *this.exit.lock().unwrap() = Some(code),
        })
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned()
    }
    fn wait_for(&self, needle: &str) {
        let end = Instant::now() + deadline(15);
        while Instant::now() < end {
            if self.text().contains(needle) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("{needle:?} never appeared; output: {:?}", self.text());
    }
}

/// The shell and a command whose output differs from its echo, so the output proves the command ran:
/// `printf` of `ab` `cd` prints `abcd`; cmd's `echo ab^cd` prints `abcd`.
fn shell() -> (Option<String>, &'static str) {
    if cfg!(windows) {
        (Some("cmd.exe".into()), "echo ab^cd\r")
    } else {
        (Some("/bin/sh".into()), "printf '%s%s\\n' ab cd\r")
    }
}

fn spawn_request(dir: &Path) -> SpawnRequest {
    SpawnRequest {
        program: shell().0,
        cwd: dir.to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        pane_id: Some("pane-1".into()),
        ..SpawnRequest::default()
    }
}

/// Runs only as a child of the survival test: connect, start a shell, type, then exit without saying goodbye,
/// like an app that crashes or is killed.
#[test]
fn helper_client_that_exits_abruptly() {
    let Some(dir) = std::env::var_os("TESSERAD_HELPER_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    let client = connect(dir);
    let output = Collector::default();
    let session = client.spawn(spawn_request(dir), output.sink()).expect("spawn");
    client.write(session, shell().1.as_bytes()).expect("type");
    output.wait_for("abcd");
    std::process::exit(0);
}

#[test]
fn sessions_survive_the_client_and_reattach_with_their_scrollback() {
    let dir = tempfile::tempdir().unwrap();
    let mut daemon = start_daemon(dir.path(), 60);
    let _ready = connect(dir.path());

    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "helper_client_that_exits_abruptly",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("TESSERAD_HELPER_DIR", dir.path())
        .status()
        .expect("run helper");
    assert!(status.success(), "helper failed: {status}");

    let client = connect(dir.path());
    let end = Instant::now() + deadline(10);
    let session = loop {
        let sessions = client.list().expect("list");
        if let Some(info) = sessions
            .iter()
            .find(|s| s.pane_id.as_deref() == Some("pane-1") && !s.attached)
        {
            assert!(!info.exited, "the shell died with its client");
            break info.session.parse().expect("session id");
        }
        assert!(Instant::now() < end, "session not listed as detached: {sessions:?}");
        std::thread::sleep(Duration::from_millis(50));
    };

    let output = Collector::default();
    client.attach(session, output.sink()).expect("attach");
    output.wait_for("abcd"); // the scrollback from before the helper exited
    let next = if cfg!(windows) {
        "echo ef^gh\r"
    } else {
        "printf '%s%s\\n' ef gh\r"
    };
    client.write(session, next.as_bytes()).expect("type after re-attach");
    output.wait_for("efgh");

    client.kill(session).expect("kill");
    let end = Instant::now() + deadline(10);
    while output.exit.lock().unwrap().is_none() {
        assert!(Instant::now() < end, "no exit event after kill");
        std::thread::sleep(Duration::from_millis(50));
    }

    client.shutdown(false).expect("shutdown");
    assert!(wait_exit(&mut daemon, deadline(10)), "daemon did not quit on shutdown");
}

#[test]
fn a_wrong_token_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut daemon = start_daemon(dir.path(), 60);
    let client = connect(dir.path());
    let endpoint = Endpoint::new(dir.path());
    let real = endpoint.read_token().unwrap();
    std::fs::write(endpoint.token_path(), "0".repeat(64)).unwrap();
    assert!(matches!(
        Client::connect(&endpoint, "intruder"),
        Err(ClientError::Refused(_))
    ));
    std::fs::write(endpoint.token_path(), real).unwrap();
    client.shutdown(false).unwrap();
    assert!(wait_exit(&mut daemon, deadline(10)));
}

#[test]
fn an_idle_daemon_quits_and_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let mut daemon = start_daemon(dir.path(), 1);
    drop(connect(dir.path()));
    assert!(wait_exit(&mut daemon, deadline(15)), "idle daemon kept running");
    if !cfg!(windows) {
        assert!(
            !Endpoint::new(dir.path()).socket_path().exists(),
            "socket file left behind"
        );
    }
}

#[test]
fn a_second_daemon_leaves_the_first_alone() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = start_daemon(dir.path(), 60);
    let client = connect(dir.path());
    let pid = client.daemon_pid();
    let mut second = start_daemon(dir.path(), 60);
    assert!(wait_exit(&mut second, deadline(10)), "second daemon did not step aside");
    let again = connect(dir.path());
    assert_eq!(again.daemon_pid(), pid);
    again.shutdown(false).unwrap();
    assert!(wait_exit(&mut first, deadline(10)));
}

fn start_labelled(dir: &Path, label: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_tesserad"))
        .arg("--data")
        .arg(dir)
        .args([
            "--idle-seconds",
            "60",
            "--no-login-environment",
            "--version-label",
            label,
        ])
        .spawn()
        .expect("start tesserad")
}

#[test]
fn an_idle_daemon_from_another_build_is_replaced_and_a_busy_one_is_kept() {
    let exe = Path::new(env!("CARGO_BIN_EXE_tesserad"));
    let current = env!("CARGO_PKG_VERSION");

    // Idle and older: replaced by a daemon of this build.
    let dir = tempfile::tempdir().unwrap();
    let mut old = start_labelled(dir.path(), "0.0.1-old");
    let old_pid = connect(dir.path()).daemon_pid();
    let client = tesserad::connect_or_start(&Endpoint::new(dir.path()), exe, "test", current).expect("connect");
    assert_ne!(client.daemon_pid(), old_pid);
    assert_eq!(client.daemon_version(), current);
    assert!(wait_exit(&mut old, deadline(10)), "the old daemon kept running");
    client.shutdown(false).unwrap();

    // Busy and older: kept, its session untouched.
    let dir = tempfile::tempdir().unwrap();
    let mut old = start_labelled(dir.path(), "0.0.1-old");
    let first = connect(dir.path());
    let output = Collector::default();
    let session = first.spawn(spawn_request(dir.path()), output.sink()).expect("spawn");
    let client = tesserad::connect_or_start(&Endpoint::new(dir.path()), exe, "test", current).expect("connect");
    assert_eq!(client.daemon_pid(), first.daemon_pid());
    assert!(
        client
            .list()
            .unwrap()
            .iter()
            .any(|s| s.session == session.as_string() && !s.exited)
    );
    client.shutdown(false).unwrap();
    assert!(wait_exit(&mut old, deadline(10)));
}
