//! Where terminal sessions live (M8.3, FR-24): in the session daemon `tesserad` when it runs, so shells and agents
//! survive quitting or updating the app, else in this process (the fallback). Release builds use the daemon unless
//! `TESSERA_SESSION_DAEMON=0`; debug builds only with `TESSERA_SESSION_DAEMON=1`, so killed dev and test runs do not
//! leave shells running in a daemon.
//!
//! The daemon connection starts in the background as soon as the app starts; the first spawn waits for it at most
//! [`CONNECT_WAIT`]. The app is one daemon client: output of every session arrives on that connection and is routed to
//! the window sink registered for it. Window ownership (who may ack, kill or detach) is kept here, as the local host
//! keeps it for in-process sessions. A dropped connection ends every daemon pane with an exit and the next spawn
//! reconnects (starting a new daemon when needed).

use crate::error::AppError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tessera_pty::{EventSink, PtyHost, SessionId, SpawnObserver, SpawnSpec};
use tesserad::{Client, ClientError, Endpoint, SpawnRequest};

/// How long a spawn waits for the background daemon connection before using the local host.
pub const CONNECT_WAIT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Default)]
struct Meta {
    owner: Option<String>,
    pane_id: Option<String>,
}

enum Daemon {
    /// The background connection has not finished.
    Pending,
    /// Connected.
    Ready(Arc<Client>),
    /// Off by setting, missing binary or failed start: everything runs locally.
    Off(String),
}

struct Inner {
    daemon: Daemon,
    /// Daemon sessions this app knows: owner window and pane.
    meta: HashMap<SessionId, Meta>,
}

/// The session backend shared by the PTY, restore, task and window code.
pub struct Sessions {
    local: PtyHost,
    endpoint: Endpoint,
    executable: Option<PathBuf>,
    inner: Mutex<Inner>,
    ready: Condvar,
}

fn lock(mutex: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn daemon_error(error: ClientError) -> AppError {
    match error {
        ClientError::Failed { code, message } => AppError::new(code, message),
        other => AppError::new("pty.daemon", other.to_string()),
    }
}

/// `tesserad` next to the app executable (release bundles and `target/<profile>` in development).
#[must_use]
pub fn daemon_executable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "tesserad.exe" } else { "tesserad" };
    let candidate = exe.parent()?.join(name);
    candidate.is_file().then_some(candidate)
}

impl Sessions {
    /// A backend for the data folder `data_root`; call [`Sessions::connect_in_background`] once after managing it.
    #[must_use]
    pub fn new(local: PtyHost, data_root: &Path) -> Self {
        let disabled = match std::env::var("TESSERA_SESSION_DAEMON").as_deref() {
            Ok("0") => true,
            Ok("1") => false,
            _ => cfg!(debug_assertions),
        };
        let executable = daemon_executable();
        let daemon = if disabled {
            Daemon::Off("off (TESSERA_SESSION_DAEMON; debug builds need =1)".into())
        } else if executable.is_none() {
            Daemon::Off("tesserad is not next to the app".into())
        } else {
            Daemon::Pending
        };
        Self {
            local,
            endpoint: Endpoint::new(data_root),
            executable,
            inner: Mutex::new(Inner {
                daemon,
                meta: HashMap::new(),
            }),
            ready: Condvar::new(),
        }
    }

    /// Connects to (or starts) the daemon off the main thread.
    pub fn connect_in_background(self: &Arc<Self>) {
        if !matches!(lock(&self.inner).daemon, Daemon::Pending) {
            if let Daemon::Off(reason) = &lock(&self.inner).daemon {
                tracing::info!(%reason, "terminal sessions run in the app (no session daemon)");
            }
            return;
        }
        let this = Arc::clone(self);
        let started = std::thread::Builder::new()
            .name("tessera-session-daemon".into())
            .spawn(move || this.connect());
        if started.is_err() {
            self.settle(Daemon::Off("could not start the connect thread".into()));
        }
    }

    fn connect(&self) {
        let Some(exe) = &self.executable else { return };
        let client = format!("tessera {}", env!("CARGO_PKG_VERSION"));
        let outcome = match tesserad::connect_or_start(&self.endpoint, exe, &client, env!("CARGO_PKG_VERSION")) {
            Ok(client) => {
                tracing::info!(
                    pid = client.daemon_pid(),
                    version = client.daemon_version(),
                    "terminal sessions run in the session daemon"
                );
                Daemon::Ready(Arc::new(client))
            }
            Err(error) => {
                tracing::warn!(%error, "session daemon unavailable; terminal sessions run in the app");
                Daemon::Off(error.to_string())
            }
        };
        self.settle(outcome);
    }

    fn settle(&self, daemon: Daemon) {
        lock(&self.inner).daemon = daemon;
        self.ready.notify_all();
    }

    /// The daemon client, waiting for the background connection at most [`CONNECT_WAIT`]; reconnects once when an
    /// earlier connection broke. `None` means the local host serves.
    fn daemon(&self) -> Option<Arc<Client>> {
        let mut inner = lock(&self.inner);
        let deadline = Instant::now() + CONNECT_WAIT;
        while matches!(inner.daemon, Daemon::Pending) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                tracing::warn!("session daemon did not answer in time; this terminal runs in the app");
                return None;
            }
            inner = self
                .ready
                .wait_timeout(inner, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        let broken = match &inner.daemon {
            Daemon::Ready(client) if client.is_connected() => return Some(Arc::clone(client)),
            Daemon::Ready(_) => true,
            Daemon::Pending | Daemon::Off(_) => false,
        };
        if !broken {
            return None;
        }
        // The daemon went away (its panes ended with an exit): forget its sessions and connect again.
        inner.meta.clear();
        inner.daemon = Daemon::Pending;
        drop(inner);
        self.connect();
        match &lock(&self.inner).daemon {
            Daemon::Ready(client) => Some(Arc::clone(client)),
            _ => None,
        }
    }

    /// The daemon client only if one is connected now (never waits, never reconnects).
    fn connected(&self) -> Option<Arc<Client>> {
        match &lock(&self.inner).daemon {
            Daemon::Ready(client) if client.is_connected() => Some(Arc::clone(client)),
            _ => None,
        }
    }

    fn is_daemon_session(&self, id: &SessionId) -> bool {
        lock(&self.inner).meta.contains_key(id)
    }

    /// Whether sessions currently run in the daemon (for logs, diagnostics and tests).
    #[must_use]
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn uses_daemon(&self) -> bool {
        self.connected().is_some()
    }

    /// Starts a session. `spec.subscriber_owner` is the owning window.
    ///
    /// # Errors
    /// Spawn failures from either backend.
    pub fn spawn(&self, spec: SpawnSpec, sink: EventSink, observer: SpawnObserver) -> Result<SessionId, AppError> {
        // A pane in a task on an SSH host runs `ssh -tt` locally (M10.2).
        let home = std::env::home_dir().unwrap_or_else(std::env::temp_dir);
        let spec = crate::remote_projects::localize(spec, &home)?;
        let Some(client) = self.daemon() else {
            return Ok(self.local.spawn_observed(spec, Some(sink), observer)?);
        };
        let request = SpawnRequest {
            program: spec.program,
            args: spec.args,
            cwd: spec.cwd.to_string_lossy().into_owned(),
            env: spec.env,
            cols: spec.cols,
            rows: spec.rows,
            task_id: spec.task_id,
            pane_id: spec.pane_id.clone(),
            session: spec.session_id.map(|id| id.as_string()),
        };
        let id = client.spawn(request, sink).map_err(daemon_error)?;
        lock(&self.inner).meta.insert(
            id,
            Meta {
                owner: spec.subscriber_owner,
                pane_id: spec.pane_id,
            },
        );
        Ok(id)
    }

    /// Subscribes `owner` to a running session: scrollback first, then live output.
    ///
    /// # Errors
    /// `pty.unknown_session` when it is gone or exited.
    pub fn attach(&self, id: &SessionId, owner: String, sink: EventSink) -> Result<(), AppError> {
        if let Some(client) = self.daemon_for(id) {
            client.attach(*id, sink).map_err(daemon_error)?;
            let mut inner = lock(&self.inner);
            let meta = inner.meta.entry(*id).or_default();
            meta.owner = Some(owner);
            return Ok(());
        }
        Ok(self.local.attach(id, owner, sink)?)
    }

    /// The daemon client for a session the daemon owns, also one this app has not seen yet (a restored pane).
    fn daemon_for(&self, id: &SessionId) -> Option<Arc<Client>> {
        if self.is_daemon_session(id) {
            return self.connected();
        }
        let client = self.connected()?;
        let known = client
            .list()
            .ok()?
            .into_iter()
            .find(|info| info.session == id.as_string())?;
        lock(&self.inner).meta.insert(
            *id,
            Meta {
                owner: None,
                pane_id: known.pane_id,
            },
        );
        Some(client)
    }

    /// Writes input bytes.
    ///
    /// # Errors
    /// Unknown session or a broken daemon connection.
    pub fn write(&self, id: &SessionId, bytes: &[u8]) -> Result<(), AppError> {
        if self.is_daemon_session(id) {
            let client = self.connected().ok_or_else(lost)?;
            return client.write(*id, bytes).map_err(daemon_error);
        }
        Ok(self.local.write(id, bytes)?)
    }

    /// Resizes a session.
    ///
    /// # Errors
    /// Unknown session or a broken daemon connection.
    pub fn resize(&self, id: &SessionId, cols: u16, rows: u16, px_w: u16, px_h: u16) -> Result<(), AppError> {
        if self.is_daemon_session(id) {
            let client = self.connected().ok_or_else(lost)?;
            return client.resize(*id, cols, rows, px_w, px_h).map_err(daemon_error);
        }
        Ok(self.local.resize(id, cols, rows, px_w, px_h)?)
    }

    fn owned_by(&self, id: &SessionId, owner: &str) -> bool {
        lock(&self.inner)
            .meta
            .get(id)
            .is_some_and(|meta| meta.owner.as_deref() == Some(owner))
    }

    /// Returns flow-control credit, only for the window that owns the session.
    ///
    /// # Errors
    /// Unknown session or a broken daemon connection.
    pub fn ack(&self, id: &SessionId, owner: &str, bytes: usize) -> Result<(), AppError> {
        if self.is_daemon_session(id) {
            if self.owned_by(id, owner) {
                let client = self.connected().ok_or_else(lost)?;
                client.ack(*id, bytes).map_err(daemon_error)?;
            }
            return Ok(());
        }
        self.local
            .with_subscriber_owner(id, owner, || self.local.ack(id, bytes))?;
        Ok(())
    }

    /// Kills a session the window owns; returns false when another window owns it (a moved tab).
    ///
    /// # Errors
    /// Unknown session or a broken daemon connection.
    pub fn kill(&self, id: &SessionId, owner: &str) -> Result<bool, AppError> {
        if self.is_daemon_session(id) {
            if !self.owned_by(id, owner) {
                return Ok(false);
            }
            let client = self.connected().ok_or_else(lost)?;
            client.kill(*id).map_err(daemon_error)?;
            lock(&self.inner).meta.remove(id);
            return Ok(true);
        }
        Ok(self.local.with_subscriber_owner(id, owner, || self.local.kill(id))?)
    }

    /// A window closed. With other windows still open the user closed this one: its sessions end. When it was the
    /// last window the app is quitting: daemon sessions are only detached and come back on the next start.
    pub fn window_closed(&self, owner: &str, last_window: bool) {
        let owned: Vec<SessionId> = lock(&self.inner)
            .meta
            .iter()
            .filter(|(_, meta)| meta.owner.as_deref() == Some(owner))
            .map(|(id, _)| *id)
            .collect();
        if let Some(client) = self.connected() {
            for id in &owned {
                let result = if last_window {
                    client.detach(*id)
                } else {
                    client.kill(*id)
                };
                if let Err(error) = result {
                    tracing::debug!(%error, "could not release a session of a closed window");
                }
            }
        }
        {
            let mut inner = lock(&self.inner);
            for id in &owned {
                if last_window {
                    if let Some(meta) = inner.meta.get_mut(id) {
                        meta.owner = None;
                    }
                } else {
                    inner.meta.remove(id);
                }
            }
        }
        self.local.detach_owner(owner);
    }

    /// Every session this app can see, oldest first.
    #[must_use]
    pub fn list(&self) -> Vec<SessionId> {
        let mut ids = self.local.list();
        if let Some(client) = self.connected()
            && let Ok(sessions) = client.list()
        {
            ids.extend(sessions.iter().filter_map(|s| s.session.parse::<SessionId>().ok()));
        }
        ids
    }

    /// A session's scrollback ring.
    ///
    /// # Errors
    /// Unknown session or a broken daemon connection.
    pub fn snapshot(&self, id: &SessionId) -> Result<Vec<u8>, AppError> {
        if self.is_daemon_session(id) {
            let client = self.connected().ok_or_else(lost)?;
            return client.snapshot(*id).map_err(daemon_error);
        }
        Ok(self.local.snapshot(id)?)
    }

    /// The key a session's history is saved under (its pane id when known).
    #[must_use]
    pub fn history_key(&self, id: &SessionId) -> String {
        if let Some(meta) = lock(&self.inner).meta.get(id) {
            return meta.pane_id.clone().unwrap_or_else(|| id.as_string());
        }
        self.local.history_key(id).unwrap_or_else(|_| id.as_string())
    }

    /// A running, unattached daemon session started for `pane_id` in an earlier run of the app (restore re-attaches
    /// it instead of starting a new shell).
    #[must_use]
    pub fn live_session_for_pane(&self, pane_id: &str) -> Option<SessionId> {
        let client = self.daemon()?;
        let info = client
            .list()
            .ok()?
            .into_iter()
            .rev()
            .find(|s| s.pane_id.as_deref() == Some(pane_id) && !s.exited && !s.attached)?;
        info.session.parse().ok()
    }

    /// Root process ids of a task's sessions (Windows port detection).
    #[must_use]
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn task_process_roots(&self, task_id: &str, checkout: &Path) -> Vec<u32> {
        let mut roots = self.local.task_process_roots(task_id, checkout);
        if let Some(client) = self.connected()
            && let Ok(sessions) = client.list()
        {
            roots.extend(
                sessions
                    .iter()
                    .filter(|s| !s.exited && belongs(s, task_id, checkout) && s.pid != 0)
                    .map(|s| s.pid),
            );
        }
        roots.sort_unstable();
        roots.dedup();
        roots
    }

    /// Ends a task's sessions and waits up to `timeout` for them to exit (a shell's cwd keeps a folder busy on
    /// Windows, so this runs before its worktree is removed).
    pub fn kill_task_sessions(&self, task_id: &str, checkout: &Path, timeout: Duration) -> usize {
        let mut killed = self.local.kill_task_sessions(task_id, checkout, timeout);
        let Some(client) = self.connected() else {
            return killed;
        };
        let Ok(sessions) = client.list() else { return killed };
        let targets: Vec<String> = sessions
            .iter()
            .filter(|s| !s.exited && belongs(s, task_id, checkout))
            .map(|s| s.session.clone())
            .collect();
        for session in &targets {
            if let Ok(id) = session.parse::<SessionId>()
                && client.kill(id).is_ok()
            {
                killed += 1;
                lock(&self.inner).meta.remove(&id);
            }
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let still = client.list().map_or(0, |now| {
                now.iter().filter(|s| !s.exited && targets.contains(&s.session)).count()
            });
            if still == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        killed
    }
}

fn lost() -> AppError {
    AppError::new("pty.daemon", "The session daemon connection was lost.")
}

/// A daemon session belongs to a task when tagged with it, or (untagged) when it started in the task's checkout.
fn belongs(session: &tesserad::SessionInfo, task_id: &str, checkout: &Path) -> bool {
    if let Some(id) = &session.task_id {
        return id == task_id;
    }
    let checkout = std::fs::canonicalize(checkout).unwrap_or_else(|_| checkout.to_path_buf());
    let cwd = Path::new(&session.cwd);
    if cfg!(windows) {
        cwd.to_string_lossy().to_lowercase() == checkout.to_string_lossy().to_lowercase()
    } else {
        cwd == checkout
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(task: Option<&str>, cwd: &str) -> tesserad::SessionInfo {
        tesserad::SessionInfo {
            session: SessionId::new().as_string(),
            pane_id: None,
            task_id: task.map(str::to_owned),
            cwd: cwd.into(),
            cols: 80,
            rows: 24,
            pid: 1,
            exited: false,
            attached: false,
        }
    }

    #[test]
    fn a_tagged_session_belongs_only_to_its_task_and_an_untagged_one_to_its_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = std::fs::canonicalize(dir.path()).unwrap();
        let text = checkout.to_string_lossy().into_owned();
        assert!(belongs(&info(Some("t1"), "/elsewhere"), "t1", &checkout));
        assert!(!belongs(&info(Some("t2"), &text), "t1", &checkout));
        assert!(belongs(&info(None, &text), "t1", &checkout));
        assert!(!belongs(&info(None, "/elsewhere"), "t1", &checkout));
    }

    #[test]
    fn without_a_daemon_everything_runs_in_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Sessions {
            local: PtyHost::new(),
            endpoint: Endpoint::new(dir.path()),
            executable: None,
            inner: Mutex::new(Inner {
                daemon: Daemon::Off("test".into()),
                meta: HashMap::new(),
            }),
            ready: Condvar::new(),
        };
        assert!(!sessions.uses_daemon());
        assert!(sessions.live_session_for_pane("p1").is_none());
        let mut spec = SpawnSpec::new(dir.path());
        spec.program = Some(if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into());
        spec.subscriber_owner = Some("main".into());
        let id = sessions
            .spawn(spec, Arc::new(|_| {}), Arc::new(|_| {}))
            .expect("local spawn");
        assert!(sessions.list().contains(&id));
        assert!(!sessions.kill(&id, "other").unwrap(), "another window cannot kill it");
        assert!(sessions.kill(&id, "main").unwrap());
    }

    /// The workspace's `tesserad` (built by `cargo test --workspace` and `pnpm dev`); the test is skipped without it.
    fn built_daemon() -> Option<PathBuf> {
        let target = std::env::var_os("CARGO_TARGET_DIR").map_or_else(
            || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../target"),
            PathBuf::from,
        );
        let exe = target
            .join("debug")
            .join(if cfg!(windows) { "tesserad.exe" } else { "tesserad" });
        exe.is_file().then_some(exe)
    }

    fn with_daemon(dir: &Path, exe: &Path) -> Arc<Sessions> {
        let sessions = Arc::new(Sessions {
            local: PtyHost::new(),
            endpoint: Endpoint::new(dir),
            executable: Some(exe.to_path_buf()),
            inner: Mutex::new(Inner {
                daemon: Daemon::Pending,
                meta: HashMap::new(),
            }),
            ready: Condvar::new(),
        });
        sessions.connect();
        sessions
    }

    fn wait_for(output: &Arc<Mutex<Vec<u8>>>, needle: &str) {
        let end = Instant::now() + Duration::from_secs(if cfg!(windows) { 45 } else { 15 });
        while Instant::now() < end {
            if String::from_utf8_lossy(&output.lock().unwrap()).contains(needle) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!(
            "{needle:?} never appeared: {:?}",
            String::from_utf8_lossy(&output.lock().unwrap())
        );
    }

    fn collector() -> (Arc<Mutex<Vec<u8>>>, EventSink) {
        let output = Arc::new(Mutex::new(Vec::new()));
        let sink_output = Arc::clone(&output);
        let sink: EventSink = Arc::new(move |event| {
            if let tessera_pty::PtyEvent::Data(bytes) = event {
                sink_output.lock().unwrap().extend_from_slice(&bytes);
            }
        });
        (output, sink)
    }

    #[test]
    fn a_daemon_session_outlives_the_app_and_its_pane_reattaches() {
        let Some(exe) = built_daemon() else {
            eprintln!("skipped: build tesserad first (cargo build -p tesserad)");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let (shell, first, second) = if cfg!(windows) {
            ("cmd.exe", "echo ab^cd\r", "echo ef^gh\r")
        } else {
            ("/bin/sh", "printf '%s%s\\n' ab cd\r", "printf '%s%s\\n' ef gh\r")
        };

        let app = with_daemon(dir.path(), &exe);
        assert!(app.uses_daemon(), "the daemon did not start");
        let mut spec = SpawnSpec::new(dir.path());
        spec.program = Some(shell.into());
        spec.pane_id = Some("p1".into());
        spec.subscriber_owner = Some("main".into());
        let (output, sink) = collector();
        let id = app.spawn(spec, sink, Arc::new(|_| {})).expect("spawn in the daemon");
        app.write(&id, first.as_bytes()).unwrap();
        wait_for(&output, "abcd");
        app.window_closed("main", true); // the last window closes: the app quits
        drop(app);

        let restarted = with_daemon(dir.path(), &exe);
        let end = Instant::now() + Duration::from_secs(10);
        let live = loop {
            if let Some(live) = restarted.live_session_for_pane("p1") {
                break live;
            }
            assert!(Instant::now() < end, "the pane's session was not offered for re-attach");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(live, id);
        let (replay, sink) = collector();
        restarted.attach(&id, "main".into(), sink).expect("re-attach");
        wait_for(&replay, "abcd");
        restarted.write(&id, second.as_bytes()).unwrap();
        wait_for(&replay, "efgh");
        assert!(restarted.kill(&id, "main").unwrap());
        restarted.connected().unwrap().shutdown(false).unwrap();
    }
}
