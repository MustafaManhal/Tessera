//! Integration tests with real shells.
//!
//! Every test waits on an event with a deadline; there are no fixed sleeps for synchronisation. The Windows
//! branches use `cmd` or PowerShell and skip only the resize check when the default shell is `cmd.exe` (it has no
//! portable way to print the console size).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tessera_pty::{
    CREDIT_BYTES, EventSink, Platform, PtyError, PtyEvent, PtyHost, READ_BUFFER, SpawnSpec, default_shell,
};

/// Windows runners are slower (ConPTY re-renders output), so deadlines are three times longer there.
const TIMEOUT: Duration = Duration::from_secs(if cfg!(windows) { 30 } else { 10 });
const MIB: usize = 1024 * 1024;

/// Answers a cursor-position request (`ESC[6n`) found in `data` with a report at row 1, column 1.
fn reply_to_cursor_query(host: &PtyHost, id: &tessera_pty::SessionId, data: &[u8]) {
    const QUERY: &[u8] = b"\x1b[6n";
    if data.windows(QUERY.len()).any(|window| window == QUERY) {
        let _ = host.write(id, b"\x1b[1;1R");
    }
}

struct Running {
    host: PtyHost,
    id: tessera_pty::SessionId,
    events: Receiver<PtyEvent>,
    output: Vec<u8>,
    // Declared last so the folder is removed after the host has killed the children.
    _cwd: tempfile::TempDir,
}

impl Running {
    fn start(program: Option<&str>) -> Self {
        Self::start_with(program, &[])
    }

    fn start_with(program: Option<&str>, args: &[&str]) -> Self {
        let cwd = tempfile::tempdir().expect("temp dir");
        let host = PtyHost::new();
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let sink: EventSink = Arc::new(move |event| {
            let _ = sender.lock().expect("sink lock").send(event);
        });
        let mut spec = SpawnSpec::new(cwd.path());
        spec.program = program.map(str::to_string);
        spec.args = args.iter().map(|arg| (*arg).to_string()).collect();
        let id = host.spawn_with_sink(spec, Some(sink)).expect("spawn a shell");
        Self {
            host,
            id,
            events,
            output: Vec::new(),
            _cwd: cwd,
        }
    }

    /// ConPTY asks the terminal for the cursor position (`ESC[6n`) at start-up and holds all output until it gets
    /// an answer. A real terminal emulator (xterm.js) answers by itself; this headless test plays that part.
    fn reply_to_queries(&self, data: &[u8]) {
        reply_to_cursor_query(&self.host, &self.id, data);
    }

    fn send(&self, text: &str) {
        self.host.write(&self.id, text.as_bytes()).expect("write to the pty");
    }

    fn wait_for(&mut self, needle: &str) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if self
                .output
                .windows(needle.len())
                .any(|window| window == needle.as_bytes())
            {
                return;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for {needle:?}; output: {}",
                self.text()
            );
            match self.events.recv_timeout(remaining.min(Duration::from_millis(250))) {
                Ok(PtyEvent::Data(bytes)) => {
                    self.host.ack(&self.id, bytes.len()).expect("ack");
                    self.reply_to_queries(&bytes);
                    self.output.extend(bytes);
                }
                Ok(PtyEvent::Exit { code }) => {
                    panic!(
                        "the shell exited with {code} before {needle:?}; output: {}",
                        self.text()
                    );
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("the event channel closed before {needle:?}; output: {}", self.text());
                }
            }
        }
    }

    fn wait_exit(&mut self) -> u32 {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for the exit event; output: {}",
                self.text()
            );
            match self.events.recv_timeout(remaining.min(Duration::from_millis(250))) {
                Ok(PtyEvent::Data(bytes)) => {
                    self.host.ack(&self.id, bytes.len()).expect("ack");
                    self.reply_to_queries(&bytes);
                    self.output.extend(bytes);
                }
                Ok(PtyEvent::Exit { code }) => return code,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => panic!("the event channel closed before the exit"),
            }
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output).into_owned()
    }
}

fn default_shell_name() -> String {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    default_shell(&env, Platform::current())
}

fn shell_file_name() -> String {
    Path::new(&default_shell_name())
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn is_cmd() -> bool {
    shell_file_name().starts_with("cmd")
}

fn is_powershell() -> bool {
    let name = shell_file_name();
    name.starts_with("pwsh") || name.starts_with("powershell")
}

#[test]
fn echoes_and_reads_output() {
    let mut running = Running::start(None);
    if cfg!(windows) {
        if is_cmd() {
            running.send("set \"M=ok\" & echo tessera-%M%\r");
        } else {
            running.send("$m='ok'; Write-Output \"tessera-$m\"\r");
        }
    } else {
        running.send("echo \"tessera-$(printf ok)\"\r");
    }
    running.wait_for("tessera-ok");

    let snapshot = running.host.snapshot(&running.id).expect("snapshot");
    assert!(
        snapshot.windows(10).any(|window| window == b"tessera-ok"),
        "the scrollback ring must contain the output"
    );
}

#[test]
fn exports_tessera_environment() {
    let mut running = Running::start(None);
    let expected = format!("ENV=Tessera/{}", running.id);
    if cfg!(windows) {
        if is_cmd() {
            running.send("echo ENV=%TERM_PROGRAM%/%TESSERA_SESSION_ID%\r");
        } else {
            running.send("Write-Output \"ENV=$env:TERM_PROGRAM/$env:TESSERA_SESSION_ID\"\r");
        }
    } else {
        running.send("printf 'ENV=%s/%s\\n' \"$TERM_PROGRAM\" \"$TESSERA_SESSION_ID\"\r");
    }
    running.wait_for(&expected);
}

#[test]
fn resizes_the_terminal() {
    let mut running = Running::start(None);
    running.host.resize(&running.id, 100, 40, 0, 0).expect("resize");
    assert_eq!(running.host.size(&running.id).expect("size"), (100, 40));

    if cfg!(windows) {
        if is_cmd() {
            // cmd.exe cannot print the console size in a parseable way; the ConPTY path is covered by the
            // Windows CI run of the flush and exit tests. A human checks the visible size in the app.
            return;
        }
        assert!(is_powershell(), "unexpected default shell {}", default_shell_name());
        running.send("$s=$Host.UI.RawUI.WindowSize; Write-Output (\"SIZE:\" + $s.Width + \"x\" + $s.Height)\r");
        running.wait_for("SIZE:100x40");
    } else {
        running.send("stty size\r");
        running.wait_for("40 100");
    }
}

#[test]
fn propagates_the_exit_code() {
    let mut running = Running::start(None);
    running.send("exit 7\r");
    assert_eq!(running.wait_exit(), 7);
}

#[test]
fn kill_is_idempotent_and_ends_the_session() {
    let mut running = Running::start(None);
    if cfg!(windows) {
        if is_cmd() {
            running.send("ping -t 127.0.0.1\r");
        } else {
            running.send("Start-Sleep 30\r");
        }
    } else {
        running.send("sleep 30\r");
    }

    // Wait for the typed command to be echoed, then kill twice.
    let first = running
        .events
        .recv_timeout(TIMEOUT)
        .expect("the shell echoed the command");
    if let PtyEvent::Data(bytes) = first {
        running.output.extend(bytes);
    }
    running.host.kill(&running.id).expect("first kill");
    running.host.kill(&running.id).expect("second kill");
    let _code = running.wait_exit();
}

#[test]
fn a_missing_working_directory_is_refused() {
    let host = PtyHost::new();
    let missing = std::env::temp_dir().join("tessera-missing-cwd-integration-does-not-exist");
    let error = host.spawn(SpawnSpec::new(missing)).expect_err("must fail");
    assert!(matches!(error, PtyError::CwdMissing { .. }));
    assert!(host.list().is_empty(), "no session may be created");
}

#[test]
fn flow_control_caps_in_flight_bytes_and_acks_resume_output() {
    let twenty_mib = 20 * MIB;
    #[cfg(windows)]
    let (mut running, cleanup) = {
        let path = std::env::temp_dir().join(format!("tessera-throughput-{}.bin", std::process::id()));
        std::fs::write(&path, vec![b'x'; twenty_mib]).expect("write the throughput file");
        let running = Running::start_with(Some("cmd"), &["/c", "type", path.to_str().expect("utf-8 path")]);
        (running, Some(path))
    };
    #[cfg(not(windows))]
    let (mut running, cleanup): (Running, Option<std::path::PathBuf>) = (
        Running::start_with(Some("sh"), &["-c", "yes tessera | head -c 20971520"]),
        None,
    );

    // Phase 1: do not ack. The reader must stop at the 2 MiB credit and no more data may arrive.
    let deadline = Instant::now() + TIMEOUT;
    let mut total = 0_usize;
    let mut idle_rounds = 0;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out waiting for the credit limit; got {total} bytes"
        );
        match running.events.recv_timeout(remaining.min(Duration::from_millis(500))) {
            Ok(PtyEvent::Data(bytes)) => {
                total += bytes.len();
                running.reply_to_queries(&bytes);
                running.output.extend(bytes);
                idle_rounds = 0;
            }
            Ok(PtyEvent::Exit { code }) => panic!("the producer exited with {code} after only {total} bytes"),
            Err(RecvTimeoutError::Timeout) => {
                idle_rounds += 1;
                if idle_rounds >= 2 {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(
        total <= CREDIT_BYTES,
        "the host sent {total} bytes with no acknowledgements, past the {CREDIT_BYTES} byte credit"
    );
    assert!(
        total + READ_BUFFER >= CREDIT_BYTES,
        "flow control stopped too early: {total} bytes (credit {CREDIT_BYTES})"
    );
    let in_flight = running.host.in_flight(&running.id).expect("in flight");
    assert!(
        in_flight + READ_BUFFER >= total,
        "in-flight {in_flight} must account for the {total} bytes sent"
    );

    // Phase 2: acknowledge and drain the rest in flight.
    running.host.ack(&running.id, total).expect("ack");
    let deadline = Instant::now() + TIMEOUT;
    // ConPTY re-renders console output instead of passing bytes through and is slow on CI runners, so on Windows the
    // count is neither exact nor fast: two full credits past the limit already prove that acknowledgements resume
    // the flow.
    let target = if cfg!(windows) { CREDIT_BYTES * 2 } else { twenty_mib };
    while total < target {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out after {total} of {target} bytes");
        match running.events.recv_timeout(remaining.min(Duration::from_millis(500))) {
            Ok(PtyEvent::Data(bytes)) => {
                running.host.ack(&running.id, bytes.len()).expect("ack");
                total += bytes.len();
                running.reply_to_queries(&bytes);
                running.output.extend(bytes);
            }
            Ok(PtyEvent::Exit { code }) => panic!("the producer exited with {code} after {total} bytes"),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => panic!("the event channel closed after {total} bytes"),
        }
    }

    running.host.kill(&running.id).expect("kill the producer");
    if let Some(path) = cleanup {
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn attach_replays_detached_output_and_the_last_subscriber_wins() {
    let host = PtyHost::new();
    let dir = tempfile::tempdir().unwrap();
    let mut spec = SpawnSpec::new(dir.path());
    #[cfg(target_os = "macos")]
    {
        spec.program = Some("/bin/sh".into());
    }
    #[cfg(windows)]
    {
        spec.program = Some("cmd.exe".into());
        spec.args = vec!["/Q".into()];
    }
    spec.subscriber_owner = Some("source".into());
    let (tx, source) = mpsc::channel();
    let id = host
        .spawn_with_sink(
            spec,
            Some(Arc::new(move |event| {
                let _ = tx.send(event);
            })),
        )
        .unwrap();
    let wait_for = |events: &Receiver<PtyEvent>, marker: &[u8]| {
        let deadline = Instant::now() + TIMEOUT;
        let mut output = Vec::new();
        while !output.windows(marker.len()).any(|part| part == marker) {
            let event = events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            let PtyEvent::Data(bytes) = event else {
                panic!("child exited before receiving its marker");
            };
            reply_to_cursor_query(&host, &id, &bytes);
            host.ack(&id, bytes.len()).unwrap();
            output.extend(bytes);
        }
    };
    host.write(&id, b"echo before-detach\r").unwrap();
    wait_for(&source, b"before-detach");
    host.detach_owner("source");
    host.write(&id, b"echo while-detached\r").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    while !host
        .snapshot(&id)
        .unwrap()
        .windows(14)
        .any(|part| part == b"while-detached")
    {
        assert!(Instant::now() < deadline, "detached output did not reach the ring");
        std::thread::yield_now();
    }
    let snapshot = host.snapshot(&id).unwrap();
    let (tx, first) = mpsc::channel();
    host.attach(
        &id,
        "first".into(),
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .unwrap();
    let PtyEvent::Data(replay) = first.recv_timeout(TIMEOUT).unwrap() else {
        panic!("expected a scrollback replay");
    };
    assert!(replay.starts_with(&snapshot));
    let (tx, last) = mpsc::channel();
    host.attach(
        &id,
        "last".into(),
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .unwrap();
    wait_for(&last, b"while-detached");
    host.detach_owner("first");
    while first.try_recv().is_ok() {}
    assert!(!host.with_subscriber_owner(&id, "source", || host.kill(&id)).unwrap());
    host.write(&id, b"echo after-attach\r").unwrap();
    wait_for(&last, b"after-attach");
    assert!(first.try_recv().is_err());
    host.kill(&id).unwrap();
    assert!(matches!(
        host.attach(&tessera_pty::SessionId::new(), "last".into(), Arc::new(|_| {})),
        Err(PtyError::UnknownSession { .. })
    ));
}

#[test]
fn task_process_roots_match_tags_or_exact_checkout_and_clear_on_exit() {
    let host = PtyHost::new();
    let checkout = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let mut spec = SpawnSpec::new(checkout.path());
    #[cfg(target_os = "macos")]
    {
        spec.program = Some("/bin/sh".into());
    }
    #[cfg(windows)]
    {
        spec.program = Some("cmd.exe".into());
    }
    let untagged = host.spawn(spec.clone()).unwrap();
    let roots = host.task_process_roots("task", checkout.path());
    assert_eq!(roots.len(), 1);
    assert!(host.task_process_roots("task", other.path()).is_empty());
    spec.task_id = Some("task".into());
    let (tx, exit) = mpsc::channel();
    let tagged = host
        .spawn_with_sink(
            spec,
            Some(Arc::new(move |event| {
                if matches!(event, PtyEvent::Exit { .. }) {
                    let _ = tx.send(event);
                }
            })),
        )
        .unwrap();
    let tagged_roots = host.task_process_roots("task", other.path());
    assert_eq!(tagged_roots.len(), 1);
    assert_ne!(roots, tagged_roots);
    assert_eq!(host.task_process_roots("other", checkout.path()), roots);
    host.kill(&tagged).unwrap();
    assert!(matches!(exit.recv_timeout(TIMEOUT).unwrap(), PtyEvent::Exit { .. }));
    assert!(host.task_process_roots("task", other.path()).is_empty());
    host.kill(&untagged).unwrap();
}

#[test]
fn kill_task_sessions_stops_the_shells_in_the_checkout_and_waits_for_their_exit() {
    let host = PtyHost::new();
    let checkout = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let shell_in = |dir: &std::path::Path| {
        let mut spec = SpawnSpec::new(dir);
        #[cfg(target_os = "macos")]
        {
            spec.program = Some("/bin/sh".into());
        }
        #[cfg(windows)]
        {
            spec.program = Some("cmd.exe".into());
        }
        spec
    };
    let (tx, exit) = mpsc::channel();
    let inside = host
        .spawn_with_sink(
            shell_in(checkout.path()),
            Some(Arc::new(move |event| {
                if matches!(event, PtyEvent::Exit { .. }) {
                    let _ = tx.send(event);
                }
            })),
        )
        .unwrap();
    let outside = host.spawn(shell_in(other.path())).unwrap();
    assert_eq!(host.kill_task_sessions("task", checkout.path(), TIMEOUT), 1);
    // The call returns only after the shell has exited, so its exit event is already delivered.
    assert!(
        matches!(exit.try_recv(), Ok(PtyEvent::Exit { .. })),
        "{inside:?} still running"
    );
    assert_eq!(host.task_process_roots("task", other.path()).len(), 1);
    host.kill(&outside).unwrap();
}

#[test]
fn history_is_keyed_by_the_pane_when_the_ui_names_one() {
    let host = PtyHost::new();
    let dir = tempfile::tempdir().unwrap();
    let mut spec = SpawnSpec::new(dir.path());
    #[cfg(target_os = "macos")]
    {
        spec.program = Some("/bin/sh".into());
    }
    #[cfg(windows)]
    {
        spec.program = Some("cmd.exe".into());
    }
    let plain = host.spawn(spec.clone()).unwrap();
    spec.pane_id = Some("pane-1".into());
    let named = host.spawn(spec).unwrap();
    assert_eq!(host.history_key(&plain).unwrap(), plain.as_string());
    assert_eq!(host.history_key(&named).unwrap(), "pane-1");
    host.kill(&plain).unwrap();
    host.kill(&named).unwrap();
}
