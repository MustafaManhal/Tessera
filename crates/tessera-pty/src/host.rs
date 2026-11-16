//! The PTY host: one session per terminal pane, with coalesced output, credit-based flow control and a
//! Rust-side scrollback ring.
//!
//! Design (TRD §4.1):
//! - one blocking reader thread per session reads at most 64 KiB per call and stops when the UI credit is exhausted;
//! - a coalescer thread turns those reads into one `Data` event every 8 ms or 256 KiB;
//! - a waiter thread reports the exit code after the final data has been flushed;
//! - every thread body is wrapped in `catch_unwind`, so one broken session cannot take down the app.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtyPair, PtySize, native_pty_system};
use tracing::{debug, error, warn};

use crate::coalesce::Coalescer;
use crate::error::PtyError;
use crate::id::SessionId;
use crate::ring::ScrollbackRing;
use crate::shell::{self, Platform};

/// Bytes read from the PTY in one blocking read.
pub const READ_BUFFER: usize = 64 * 1024;
/// Maximum delay before buffered output is sent to the UI.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
/// Maximum batch size sent to the UI.
pub const FLUSH_BYTES: usize = 256 * 1024;
/// Credit granted to the UI before it must acknowledge output.
pub const CREDIT_BYTES: usize = 2 * 1024 * 1024;
/// Scrollback kept in Rust for restore and the API.
pub const SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;
/// ConPTY loses resizes when they arrive too quickly; coalesce them for this long.
pub const RESIZE_DEBOUNCE: Duration = Duration::from_millis(50);
/// How long the waiter waits for the final coalesced batch before reporting the exit code.
const FINAL_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// An event produced by a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// Output bytes, already coalesced.
    Data(Vec<u8>),
    /// The child exited. Sent after the last [`PtyEvent::Data`].
    Exit {
        /// The process exit code, or 1 when the process was killed by a signal.
        code: u32,
    },
}

/// A callback that receives a session's events.
pub type EventSink = Arc<dyn Fn(PtyEvent) + Send + Sync>;

/// Optional startup phase observer. Receives names only, never environment or terminal content.
pub type SpawnObserver = Arc<dyn Fn(&str) + Send + Sync>;

/// Everything needed to start a terminal session.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    /// Program to run. `None` runs the platform's default shell as a login shell.
    pub program: Option<String>,
    /// Program arguments; ignored for the default shell.
    pub args: Vec<String>,
    /// Working directory. Must exist and be a directory.
    pub cwd: std::path::PathBuf,
    /// Extra environment variables, applied after the login environment.
    pub env: BTreeMap<String, String>,
    /// Initial terminal width in cells.
    pub cols: u16,
    /// Initial terminal height in cells.
    pub rows: u16,
    /// Optional task id, exported as `TESSERA_TASK_ID`.
    pub task_id: Option<String>,
    /// Owner of the initial output subscriber, used to detach a closed window.
    pub subscriber_owner: Option<String>,
    /// Optional existing session id (used by tests and the future daemon).
    pub session_id: Option<SessionId>,
    /// The UI pane this session runs in. Saved history is keyed by it, because a restored layout knows its panes, not
    /// the sessions of the previous run (see [`PtyHost::history_key`]).
    pub pane_id: Option<String>,
}

impl SpawnSpec {
    /// A spec for the default shell in `cwd`, 80×24.
    #[must_use]
    pub fn new(cwd: impl Into<std::path::PathBuf>) -> Self {
        Self {
            program: None,
            args: Vec::new(),
            cwd: cwd.into(),
            env: BTreeMap::new(),
            cols: 80,
            rows: 24,
            task_id: None,
            session_id: None,
            subscriber_owner: None,
            pane_id: None,
        }
    }
}

/// Spawns and drives PTY sessions.
///
/// The host is cheap to clone; every clone shares the same session table. The
/// last clone owns the children and kills them when it is dropped.
#[derive(Clone)]
pub struct PtyHost {
    inner: Arc<HostInner>,
}

struct HostInner {
    sessions: Mutex<HashMap<SessionId, Arc<Session>>>,
    login_environment: Mutex<Arc<crate::login_env::LoginEnvironment>>,
    prepared_pty: Mutex<Option<PtyPair>>,
    prepared_program: Mutex<Option<(String, String, std::path::PathBuf)>>,
}

impl Drop for HostInner {
    fn drop(&mut self) {
        let sessions = lock(&self.sessions);
        for session in sessions.values() {
            let mut killer = lock(&session.killer);
            if let Err(error) = killer.kill() {
                debug!(id = %session.id, %error, "could not kill a session while shutting down");
            }
        }
    }
}

impl Default for PtyHost {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyHost {
    /// Creates an empty host.
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(HostInner {
                sessions: Mutex::new(HashMap::new()),
                login_environment: Mutex::new(Arc::new(crate::login_env::LoginEnvironment::default())),
                prepared_pty: Mutex::new(None),
                prepared_program: Mutex::new(None),
            }),
        }
    }

    /// Snapshot of the same login environment used for PTY launches. Never waits on the probe.
    pub fn login_environment_snapshot(&self) -> BTreeMap<String, String> {
        let base = std::env::vars().collect();
        let login = lock(&self.inner.login_environment).snapshot();
        shell::merge_environment(&base, &login, &BTreeMap::new())
    }

    /// Prepares the default executable off the first-spawn critical path. Also opens an unused PTY on macOS.
    /// Spawns never wait for this method: they take a ready pair or open their own.
    pub fn prewarm_default_session(&self) -> Result<(), PtyError> {
        let base = std::env::vars().collect();
        let platform = Platform::current();
        let program = shell::default_shell(&base, platform);
        let login = lock(&self.inner.login_environment).snapshot();
        let env = shell::merge_environment(&base, &login, &BTreeMap::new());
        if let Some(resolved) = shell::find_program(&program, &env, platform) {
            *lock(&self.inner.prepared_program) =
                Some((program, env.get("PATH").cloned().unwrap_or_default(), resolved));
        }
        // portable-pty requests cursor inheritance on ConPTY. Open it at the requested
        // size during spawn so no pre-spawn resize can race the cursor exchange.
        if platform == Platform::Windows {
            debug!("deferring ConPTY creation to session spawn");
            return Ok(());
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| PtyError::SpawnFailed {
                program: "prewarm".into(),
                message: format!("{error:#}"),
            })?;
        *lock(&self.inner.prepared_pty) = Some(pair);
        Ok(())
    }

    fn resolved_program(
        &self,
        program: &str,
        env: &BTreeMap<String, String>,
        platform: Platform,
    ) -> Option<std::path::PathBuf> {
        if let Some((name, path, resolved)) = &*lock(&self.inner.prepared_program)
            && name == program
            && Some(path.as_str()) == env.get("PATH").map(String::as_str)
            && resolved.is_file()
        {
            return Some(resolved.clone());
        }
        shell::find_program(program, env, platform)
    }

    /// Loads a fresh (at most 24 hours old) cache and refreshes it off the first spawn path.
    /// Call once during application setup with an app-owned data directory.
    pub fn start_login_environment(&self, data_root: &std::path::Path) {
        self.start_login_environment_observed(data_root, Arc::new(|_| {}));
    }

    /// Starts the cached background probe, reporting timing phases without environment values.
    pub fn start_login_environment_observed(&self, data_root: &std::path::Path, mark: Arc<dyn Fn(&str) + Send + Sync>) {
        let base = std::env::vars().collect();
        let shell = shell::default_shell(&base, Platform::current());
        let probe_mark = Arc::clone(&mark);
        let hit = lock(&self.inner.login_environment).start_with(
            Some(data_root.join("login-environment.cache")),
            shell,
            move |shell| {
                probe_mark("login_probe_begin");
                let env = shell::login_environment(shell);
                probe_mark("login_probe_ready");
                env
            },
            shell::path_helper_environment,
        );
        mark(if hit { "login_cache_hit" } else { "login_cache_miss" });
    }

    #[cfg(test)]
    pub(crate) fn set_login_environment_for_test(&self, provider: Arc<crate::login_env::LoginEnvironment>) {
        *lock(&self.inner.login_environment) = provider;
    }

    /// Starts a session and returns its id.
    ///
    /// # Errors
    ///
    /// [`PtyError::CwdMissing`] when `cwd` is not a directory,
    /// [`PtyError::ProgramNotFound`] when the program is not on `PATH`, and
    /// [`PtyError::SpawnFailed`] when the OS refuses the pseudo terminal or the spawn.
    pub fn spawn(&self, spec: SpawnSpec) -> Result<SessionId, PtyError> {
        self.spawn_with_sink(spec, None)
    }

    /// Starts a session and subscribes `sink` before any output can arrive.
    pub fn spawn_with_sink(&self, spec: SpawnSpec, sink: Option<EventSink>) -> Result<SessionId, PtyError> {
        self.spawn_inner(spec, sink, None)
    }

    /// Starts a session with optional phase timestamps supplied to a cheap callback.
    /// The callback receives phase names only, never environment values or terminal bytes.
    pub fn spawn_observed(
        &self,
        spec: SpawnSpec,
        sink: Option<EventSink>,
        observer: SpawnObserver,
    ) -> Result<SessionId, PtyError> {
        self.spawn_inner(spec, sink, Some(observer))
    }

    fn spawn_inner(
        &self,
        spec: SpawnSpec,
        sink: Option<EventSink>,
        observer: Option<SpawnObserver>,
    ) -> Result<SessionId, PtyError> {
        let mark = |phase: &str| {
            if let Some(observer) = &observer {
                observer(phase);
            }
        };
        let started = Instant::now();
        mark("host_spawn_begin");
        if !spec.cwd.is_dir() {
            return Err(PtyError::CwdMissing { path: spec.cwd });
        }

        let platform = Platform::current();
        let base: BTreeMap<String, String> = std::env::vars().collect();
        let login_shell = shell::default_shell(&base, platform);
        let login_provider = Arc::clone(&lock(&self.inner.login_environment));
        login_provider.start(None, login_shell);
        let login = login_provider.snapshot();
        let mut env = shell::merge_environment(&base, &login, &spec.env);
        mark("environment_ready");
        let id = spec.session_id.unwrap_or_default();
        env.extend(shell::tessera_environment(&id, spec.task_id.as_deref(), crate::VERSION));

        let default_shell = shell::default_shell(&base, platform);
        let program_name = spec.program.as_deref().unwrap_or(&default_shell).to_string();
        let mut builder = if let Some(program) = &spec.program {
            let resolved = self
                .resolved_program(program, &env, platform)
                .ok_or_else(|| PtyError::ProgramNotFound {
                    program: program.clone(),
                })?;
            let mut builder = CommandBuilder::new(resolved);
            for arg in &spec.args {
                builder.arg(arg);
            }
            builder
        } else {
            env.insert("SHELL".to_string(), default_shell.clone());
            #[cfg(unix)]
            {
                // `new_default_prog` runs the shell as a login shell (argv0 `-zsh`), which is what macOS needs.
                CommandBuilder::new_default_prog()
            }
            #[cfg(windows)]
            {
                // portable-pty's default program is always ComSpec; Tessera's order is pwsh → powershell → cmd.
                let resolved =
                    shell::find_program(&default_shell, &env, platform).ok_or_else(|| PtyError::ProgramNotFound {
                        program: default_shell.clone(),
                    })?;
                CommandBuilder::new(resolved)
            }
        };
        builder.cwd(&spec.cwd);
        builder.env_clear();
        for (key, value) in &env {
            builder.env(key, value);
        }

        let size = PtySize {
            cols: spec.cols.max(1),
            rows: spec.rows.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let prepared = lock(&self.inner.prepared_pty).take();
        let ready = prepared.filter(|pair| pair.master.resize(size).is_ok());
        let pair = if let Some(pair) = ready {
            mark("pty_prepared");
            pair
        } else {
            native_pty_system()
                .openpty(size)
                .map_err(|error| PtyError::SpawnFailed {
                    program: program_name.clone(),
                    message: format!("{error:#}"),
                })?
        };
        mark("pty_opened");
        let child = pair
            .slave
            .spawn_command(builder)
            .map_err(|error| PtyError::SpawnFailed {
                program: program_name.clone(),
                message: format!("{error:#}"),
            })?;
        mark("shell_started");
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(|error| PtyError::SpawnFailed {
            program: program_name.clone(),
            message: format!("{error:#}"),
        })?;
        let writer = pair.master.take_writer().map_err(|error| PtyError::SpawnFailed {
            program: program_name.clone(),
            message: format!("{error:#}"),
        })?;
        let killer = child.clone_killer();

        #[cfg(windows)]
        let (resize_tx, resize_rx) = mpsc::channel();

        let session = Arc::new(Session {
            id,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            process_id: Arc::new(AtomicU32::new(child.process_id().unwrap_or_default())),
            task_id: spec.task_id,
            pane_id: spec.pane_id,
            launch_cwd: std::fs::canonicalize(&spec.cwd).unwrap_or_else(|_| spec.cwd.clone()),
            flow: Arc::new(FlowControl::new(CREDIT_BYTES)),
            delivery: Arc::new(Mutex::new(Delivery {
                sinks: sink.into_iter().collect(),
                owner: spec.subscriber_owner,
                exited: false,
            })),
            scrollback: Mutex::new(ScrollbackRing::new(SCROLLBACK_BYTES)),
            size: Mutex::new(size),
            input_pending: Arc::new(AtomicBool::new(false)),
            metrics: std::env::var_os("TESSERA_PTY_BENCH").map(|_| Arc::new(Mutex::new(PipelineMetrics::default()))),
            #[cfg(windows)]
            resize_tx,
        });

        {
            let mut sessions = lock(&self.inner.sessions);
            if sessions.contains_key(&id) {
                return Err(PtyError::SpawnFailed {
                    program: program_name,
                    message: format!("session {id} already exists"),
                });
            }
            sessions.insert(id, Arc::clone(&session));
        }

        let (flushed_tx, flushed_rx) = mpsc::channel();
        start_pipeline(&session, reader, flushed_tx, observer.clone(), started);
        start_waiter(&session, child, flushed_rx);

        #[cfg(windows)]
        start_resize_thread(&session, resize_rx);

        mark("host_spawn_complete");
        debug!(id = %id, program = %program_name, cwd = %spec.cwd.display(), "started a PTY session");
        Ok(id)
    }

    /// Sends bytes to the child, usually keystrokes.
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] when the id is gone, [`PtyError::Io`] when the write fails.
    pub fn write(&self, id: &SessionId, bytes: &[u8]) -> Result<(), PtyError> {
        let session = self.session(id)?;
        session.input_pending.store(true, Ordering::Release);
        let mut writer = lock(&session.writer);
        std::io::Write::write_all(&mut *writer, bytes)?;
        std::io::Write::flush(&mut *writer)?;
        Ok(())
    }

    /// Resizes the terminal. Windows schedules the change after a short quiet period (ConPTY quirk).
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] for an unknown id, or a spawn error when the OS refuses the size.
    pub fn resize(
        &self,
        id: &SessionId,
        cols: u16,
        rows: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) -> Result<(), PtyError> {
        let session = self.session(id)?;
        let size = PtySize {
            cols: cols.max(1),
            rows: rows.max(1),
            pixel_width,
            pixel_height,
        };
        *lock(&session.size) = size;

        #[cfg(windows)]
        {
            let _ = session.resize_tx.send(size);
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let master = lock(&session.master);
            master.resize(size).map_err(|error| PtyError::SpawnFailed {
                program: "resize".to_string(),
                message: format!("{error:#}"),
            })
        }
    }

    /// Acknowledges `bytes` written to xterm.js, returning the credit.
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] for an unknown id.
    pub fn ack(&self, id: &SessionId, bytes: usize) -> Result<(), PtyError> {
        let session = self.session(id)?;
        session.flow.ack_delivered(bytes);
        if let Some(metrics) = &session.metrics {
            let mut metrics = lock(metrics);
            metrics.acks += 1;
            if let Some(sent) = metrics.last_emit {
                metrics.ack_ns += sent.elapsed().as_nanos();
            }
        }
        Ok(())
    }

    /// Kills the child. Calling it twice, or after a natural exit, is fine.
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] for an unknown id.
    pub fn kill(&self, id: &SessionId) -> Result<(), PtyError> {
        let session = self.session(id)?;
        let mut killer = lock(&session.killer);
        if let Err(error) = killer.kill() {
            debug!(id = %id, %error, "the session was already gone");
        }
        Ok(())
    }

    /// Subscribes another sink to the session's output.
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] for an unknown id.
    pub fn subscribe(&self, id: &SessionId, sink: EventSink) -> Result<(), PtyError> {
        lock(&self.session(id)?.delivery).sinks.push(sink);
        Ok(())
    }

    /// Replaces the current output subscriber of a live session and replays its scrollback before live output.
    /// Sinks run in delivery order and must not reenter subscription operations.
    ///
    /// # Errors
    /// Returns [`PtyError::UnknownSession`] if the session is missing or has exited.
    pub fn attach(&self, id: &SessionId, owner: String, sink: EventSink) -> Result<(), PtyError> {
        let session = self.session(id)?;
        let mut delivery = lock(&session.delivery);
        if delivery.exited {
            return Err(PtyError::UnknownSession { id: *id });
        }
        let snapshot = self.snapshot(id)?;
        session.flow.replace_subscriber(snapshot.len());
        delivery.sinks = vec![Arc::clone(&sink)];
        delivery.owner = Some(owner);
        for chunk in snapshot.chunks(FLUSH_BYTES) {
            sink(PtyEvent::Data(chunk.to_vec()));
        }
        Ok(())
    }

    /// Detaches `owner` from one session without ending it; returns false when `owner` was not subscribed.
    ///
    /// # Errors
    /// [`PtyError::UnknownSession`] for an unknown id.
    pub fn detach(&self, id: &SessionId, owner: &str) -> Result<bool, PtyError> {
        let session = self.session(id)?;
        let mut delivery = lock(&session.delivery);
        if delivery.owner.as_deref() != Some(owner) {
            return Ok(false);
        }
        delivery.sinks.clear();
        delivery.owner = None;
        session.flow.replace_subscriber(0);
        Ok(true)
    }

    /// Detaches subscribers owned by a closed window without terminating their processes.
    pub fn detach_owner(&self, owner: &str) {
        let sessions = lock(&self.inner.sessions).values().cloned().collect::<Vec<_>>();
        for session in sessions {
            let mut delivery = lock(&session.delivery);
            if delivery.owner.as_deref() == Some(owner) {
                delivery.sinks.clear();
                delivery.owner = None;
                session.flow.replace_subscriber(0);
            }
        }
    }

    /// Applies an operation only if this owner still owns the subscriber.
    /// The operation must not change subscriptions.
    ///
    /// # Errors
    /// Returns [`PtyError::UnknownSession`] for an unknown id or the error returned by the operation.
    pub fn with_subscriber_owner(
        &self,
        id: &SessionId,
        owner: &str,
        operation: impl FnOnce() -> Result<(), PtyError>,
    ) -> Result<bool, PtyError> {
        let session = self.session(id)?;
        let delivery = lock(&session.delivery);
        if delivery.owner.as_deref() != Some(owner) {
            return Ok(false);
        }
        operation()?;
        Ok(true)
    }

    /// The last [`SCROLLBACK_BYTES`] of output.
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] for an unknown id.
    pub fn snapshot(&self, id: &SessionId) -> Result<Vec<u8>, PtyError> {
        Ok(lock(&self.session(id)?.scrollback).snapshot())
    }

    /// The key a session's history is saved under: its pane id when the UI gave one, else the session id.
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] for an unknown id.
    pub fn history_key(&self, id: &SessionId) -> Result<String, PtyError> {
        Ok(self.session(id)?.pane_id.clone().unwrap_or_else(|| id.as_string()))
    }

    /// The current terminal size.
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] for an unknown id.
    pub fn size(&self, id: &SessionId) -> Result<(u16, u16), PtyError> {
        let size = *lock(&self.session(id)?.size);
        Ok((size.cols, size.rows))
    }

    /// Bytes sent to the UI but not acknowledged yet. Used by the flow-control test and diagnostics.
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] for an unknown id.
    pub fn in_flight(&self, id: &SessionId) -> Result<usize, PtyError> {
        Ok(self.session(id)?.flow.in_flight())
    }

    /// Benchmark counters, enabled only when `TESSERA_PTY_BENCH` is set before spawn.
    pub fn metrics(&self, id: &SessionId) -> Result<Option<PipelineMetrics>, PtyError> {
        Ok(self.session(id)?.metrics.as_ref().map(|metrics| lock(metrics).clone()))
    }

    /// What a session is: ids, launch folder, size, process id, and whether it exited or has a subscriber. The
    /// session daemon lists these so a restarted UI can re-attach its panes.
    ///
    /// # Errors
    ///
    /// [`PtyError::UnknownSession`] for an unknown id.
    pub fn describe(&self, id: &SessionId) -> Result<SessionDescription, PtyError> {
        let session = self.session(id)?;
        let size = *lock(&session.size);
        let delivery = lock(&session.delivery);
        Ok(SessionDescription {
            id: *id,
            pane_id: session.pane_id.clone(),
            task_id: session.task_id.clone(),
            cwd: session.launch_cwd.clone(),
            cols: size.cols,
            rows: size.rows,
            pid: session.process_id.load(Ordering::Acquire),
            exited: delivery.exited,
            attached: !delivery.sinks.is_empty(),
        })
    }

    /// Drops sessions whose process exited and that nobody is subscribed to; returns how many were dropped.
    /// Without this a long-running host (the session daemon) keeps every exited session's scrollback forever.
    pub fn forget_exited(&self) -> usize {
        let mut sessions = lock(&self.inner.sessions);
        let before = sessions.len();
        sessions.retain(|_, session| {
            let delivery = lock(&session.delivery);
            !(delivery.exited && delivery.sinks.is_empty())
        });
        before - sessions.len()
    }

    /// All live sessions, oldest first.
    #[must_use]
    pub fn list(&self) -> Vec<SessionId> {
        let sessions = lock(&self.inner.sessions);
        let mut ids: Vec<SessionId> = sessions.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    /// Live root PIDs for a task. Older clients that omit the task id must start in its exact checkout.
    /// Explicitly tagged sessions are only attributed to their recorded task.
    #[must_use]
    pub fn task_process_roots(&self, task_id: &str, checkout: &std::path::Path) -> Vec<u32> {
        let checkout = std::fs::canonicalize(checkout).unwrap_or_else(|_| checkout.to_path_buf());
        let sessions = lock(&self.inner.sessions);
        let mut roots = sessions
            .values()
            .filter_map(|session| {
                let matches = session.belongs_to_task(task_id, &checkout);
                let pid = session.process_id.load(Ordering::Acquire);
                (matches && pid != 0).then_some(pid)
            })
            .collect::<Vec<_>>();
        roots.sort_unstable();
        roots.dedup();
        roots
    }

    /// Kills every session attributed to `task_id` (see [`Self::task_process_roots`]) and waits up to `timeout` for
    /// them to exit; returns how many were killed. A shell keeps its folder busy on Windows, so a task's worktree
    /// cannot be removed while its shells run.
    pub fn kill_task_sessions(&self, task_id: &str, checkout: &std::path::Path, timeout: Duration) -> usize {
        let checkout = std::fs::canonicalize(checkout).unwrap_or_else(|_| checkout.to_path_buf());
        let targets: Vec<Arc<Session>> = lock(&self.inner.sessions)
            .values()
            .filter(|session| session.belongs_to_task(task_id, &checkout))
            .cloned()
            .collect();
        let killed = targets.iter().filter(|session| self.kill(&session.id).is_ok()).count();
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline && targets.iter().any(|session| !lock(&session.delivery).exited) {
            thread::sleep(Duration::from_millis(50));
        }
        killed
    }

    fn session(&self, id: &SessionId) -> Result<Arc<Session>, PtyError> {
        lock(&self.inner.sessions)
            .get(id)
            .cloned()
            .ok_or(PtyError::UnknownSession { id: *id })
    }
}

/// A snapshot of one session's identity and state (see [`PtyHost::describe`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDescription {
    /// Session id.
    pub id: SessionId,
    /// UI pane the session was started for, if any.
    pub pane_id: Option<String>,
    /// Task the session belongs to, if any.
    pub task_id: Option<String>,
    /// Folder the process started in (canonical when possible).
    pub cwd: std::path::PathBuf,
    /// Terminal width in cells.
    pub cols: u16,
    /// Terminal height in cells.
    pub rows: u16,
    /// Root process id (0 when unknown).
    pub pid: u32,
    /// The process exited.
    pub exited: bool,
    /// Someone is subscribed to its output.
    pub attached: bool,
}

struct Session {
    id: SessionId,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    process_id: Arc<AtomicU32>,
    task_id: Option<String>,
    pane_id: Option<String>,
    launch_cwd: std::path::PathBuf,
    flow: Arc<FlowControl>,
    delivery: Arc<Mutex<Delivery>>,
    scrollback: Mutex<ScrollbackRing>,
    size: Mutex<PtySize>,
    input_pending: Arc<AtomicBool>,
    metrics: Option<Arc<Mutex<PipelineMetrics>>>,
    #[cfg(windows)]
    resize_tx: mpsc::Sender<PtySize>,
}

impl Session {
    /// A session tagged with a task id belongs only to that task; an untagged one belongs to the task whose checkout
    /// it started in (case-insensitive on Windows). `checkout` must already be canonical.
    fn belongs_to_task(&self, task_id: &str, checkout: &std::path::Path) -> bool {
        match self.task_id.as_deref() {
            Some(id) => id == task_id,
            None if cfg!(windows) => {
                self.launch_cwd.to_string_lossy().to_lowercase() == checkout.to_string_lossy().to_lowercase()
            }
            None => self.launch_cwd == checkout,
        }
    }
}

struct Delivery {
    sinks: Vec<EventSink>,
    owner: Option<String>,
    exited: bool,
}

/// Credit plus the wait/notify plumbing the reader thread blocks on.
struct FlowControl {
    limit: usize,
    state: Mutex<FlowState>,
    ready: Condvar,
}

struct FlowState {
    available: usize,
    // Delivered live bytes are charged against credit. Replayed history is not.
    delivered: usize,
    replay_remaining: usize,
    closed: bool,
}

impl FlowControl {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            state: Mutex::new(FlowState {
                available: limit,
                delivered: 0,
                replay_remaining: 0,
                closed: false,
            }),
            ready: Condvar::new(),
        }
    }

    /// Blocks until some credit is available and takes at most `max` bytes.
    ///
    /// Once the session is closed the reader may drain without credit, so the
    /// last bytes of output are never lost.
    fn take(&self, max: usize) -> usize {
        let mut state = lock(&self.state);
        loop {
            if state.closed {
                return max;
            }
            if state.available > 0 {
                let taken = max.min(state.available);
                state.available -= taken;
                return taken;
            }
            state = self.ready.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn ack(&self, bytes: usize) {
        let mut state = lock(&self.state);
        state.available = state.available.saturating_add(bytes).min(self.limit);
        self.ready.notify_all();
    }

    fn delivered(&self, bytes: usize) {
        lock(&self.state).delivered += bytes;
    }

    fn ack_delivered(&self, bytes: usize) {
        let mut state = lock(&self.state);
        let replay = bytes.min(state.replay_remaining);
        state.replay_remaining -= replay;
        let live = (bytes - replay).min(state.delivered);
        state.delivered -= live;
        state.available = state.available.saturating_add(live).min(self.limit);
        self.ready.notify_all();
    }

    fn replace_subscriber(&self, replay_bytes: usize) {
        let mut state = lock(&self.state);
        state.available = state.available.saturating_add(state.delivered).min(self.limit);
        state.delivered = 0;
        state.replay_remaining = replay_bytes;
        self.ready.notify_all();
    }

    fn close(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        self.ready.notify_all();
    }

    fn in_flight(&self) -> usize {
        let state = lock(&self.state);
        self.limit - state.available
    }
}

/// Optional per-session diagnostics. Nanosecond totals are wall time across worker threads.
#[derive(Debug, Default, Clone)]
pub struct PipelineMetrics {
    /// Read calls, including EOF.
    pub reads: u64,
    /// Bytes read from the kernel.
    pub bytes: usize,
    /// Time in blocking read calls.
    pub read_ns: u128,
    /// Time acquiring or waiting for credit.
    pub credit_ns: u128,
    /// Time updating scrollback.
    pub ring_ns: u128,
    /// Data events emitted.
    pub flushes: u64,
    /// Time executing sinks.
    pub sink_ns: u128,
    /// UI acknowledgement calls.
    pub acks: u64,
    /// Total time from latest emit to acknowledgement (immediate-ack benchmark).
    pub ack_ns: u128,
    last_emit: Option<Instant>,
}

fn emit_batch(session: &Session, batch: Vec<u8>) {
    let metrics = session.metrics.as_ref();
    let delivery = lock(&session.delivery);
    let ring_start = metrics.map(|_| Instant::now());
    lock(&session.scrollback).push(&batch);
    if let (Some(metrics), Some(start)) = (metrics, ring_start) {
        lock(metrics).ring_ns += start.elapsed().as_nanos();
    }
    if delivery.sinks.is_empty() || delivery.exited {
        session.flow.ack(batch.len());
        return;
    }
    session.flow.delivered(batch.len());
    let start = metrics.map(|metrics| {
        let start = Instant::now();
        let mut metrics = lock(metrics);
        metrics.flushes += 1;
        metrics.last_emit = Some(start);
        start
    });
    emit(&delivery.sinks, PtyEvent::Data(batch));
    if let Some(metrics) = metrics {
        lock(metrics).sink_ns += start.map_or(0, |start| start.elapsed().as_nanos());
    }
}

/// Raw read marks distinguish shell startup from coalescer/IPC delivery in opt-in benchmarks.
struct ReadMarks {
    observer: SpawnObserver,
    first: bool,
    prompt: bool,
    tail: Vec<u8>,
}
impl ReadMarks {
    fn new(observer: SpawnObserver) -> Self {
        Self {
            observer,
            first: false,
            prompt: false,
            tail: Vec::new(),
        }
    }
    fn observe(&mut self, bytes: &[u8]) {
        if bytes.is_empty() || self.prompt {
            return;
        }
        if !self.first {
            self.first = true;
            (self.observer)("first_byte");
        }
        self.tail.extend_from_slice(bytes);
        if self.tail.windows(8).any(|part| part == b"\x1b]133;B\x07")
            || self.tail.windows(9).any(|part| part == b"\x1b]133;B\x1b\\")
        {
            self.prompt = true;
            (self.observer)("prompt_read");
        }
        let excess = self.tail.len().saturating_sub(16);
        self.tail.drain(..excess);
    }
}

/// Starts the reader and coalescer threads. `flushed` fires after the last batch reached the sinks.
fn start_pipeline(
    session: &Arc<Session>,
    mut reader: Box<dyn std::io::Read + Send>,
    flushed: mpsc::Sender<()>,
    observer: Option<SpawnObserver>,
    started: Instant,
) {
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    let flow = Arc::clone(&session.flow);
    let id = session.id;
    let killer = Arc::clone(session);
    let reader_metrics = session.metrics.clone();
    #[cfg(windows)]
    let cursor_session = Arc::clone(session);

    let reader_result = thread::Builder::new()
        .name(format!("tessera-pty-reader-{id}"))
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let mut buffer = vec![0_u8; READ_BUFFER];
                let mut marks = observer.map(ReadMarks::new);
                let mut bytes_read = 0usize;
                let mut reads = 0usize;
                #[cfg(windows)]
                let mut cursor = crate::cursor_query::InitialCursorQuery::default();
                debug!(%id, credit_bytes = CREDIT_BYTES, "PTY reader started");
                loop {
                    let credit_start = reader_metrics.as_ref().map(|_| Instant::now());
                    let allowed = flow.take(buffer.len());
                    let read_start = reader_metrics.as_ref().map(|_| Instant::now());
                    let result = reader.read(&mut buffer[..allowed]);
                    if let Some(metrics) = &reader_metrics {
                        let mut metrics = lock(metrics);
                        metrics.reads += 1;
                        metrics.credit_ns += credit_start.map_or(0, |start| {
                            read_start.map_or(0, |end| end.duration_since(start).as_nanos())
                        });
                        metrics.read_ns += read_start.map_or(0, |start| start.elapsed().as_nanos());
                        if let Ok(bytes) = result {
                            metrics.bytes += bytes;
                        }
                    }
                    match result {
                        Ok(0) => {
                            flow.ack(allowed);
                            #[cfg(windows)]
                            {
                                let remainder = cursor.finish();
                                if !remainder.is_empty() {
                                    let _ = sender.send(remainder);
                                }
                            }
                            break;
                        }
                        Ok(read) => {
                            bytes_read += read;
                            reads += 1;
                            if reads == 1 {
                                debug!(%id, bytes_read, first_read_ms = started.elapsed().as_secs_f64() * 1000.0, "PTY first read");
                            } else if reads.is_multiple_of(128) {
                                debug!(%id, bytes_read, reads, "PTY reader progress");
                            }
                            if let Some(marks) = &mut marks {
                                marks.observe(&buffer[..read]);
                            }
                            if read < allowed {
                                // A short read must not burn the unused reservation.
                                flow.ack(allowed - read);
                            }
                            let chunk = buffer[..read].to_vec();
                            #[cfg(windows)]
                            let chunk = {
                                let (output, replied) = cursor.feed(chunk, |reply| {
                                    crate::cursor_query::write_reply(&mut **lock(&cursor_session.writer), reply)
                                });
                                match replied {
                                    Ok(bytes) if bytes > 0 => {
                                        flow.ack(bytes);
                                        debug!(%id, bytes_read, "answered initial ConPTY cursor query");
                                    }
                                    Err(error) => debug!(%id, %error, "could not answer initial ConPTY cursor query"),
                                    Ok(_) => {}
                                }
                                output
                            };
                            if !chunk.is_empty() && sender.send(chunk).is_err() {
                                debug!(%id, bytes_read, "PTY coalescer receiver closed");
                                break;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                            flow.ack(allowed);
                            continue;
                        }
                        Err(error) => {
                            flow.ack(allowed);
                            debug!(%id, bytes_read, %error, "PTY read stopped");
                            break;
                        }
                    }
                }
                debug!(%id, bytes_read, reads, "PTY reader finished");
            }));
            if outcome.is_err() {
                error!(id = %id, "PTY reader panicked; killing the session");
                let mut killer = lock(&killer.killer);
                let _ = killer.kill();
            }
        });
    if let Err(error) = reader_result {
        error!(id = %session.id, %error, "could not start the PTY reader thread");
    }

    let output = Arc::clone(session);
    let input_pending = Arc::clone(&session.input_pending);
    let coalescer_result = thread::Builder::new()
        .name(format!("tessera-pty-coalescer-{}", session.id))
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let mut coalescer = Coalescer::new(FLUSH_INTERVAL, FLUSH_BYTES);
                loop {
                    let timeout = coalescer
                        .next_flush()
                        .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                        .unwrap_or(Duration::from_millis(100));
                    match receiver.recv_timeout(timeout) {
                        Ok(chunk) => {
                            let now = Instant::now();
                            let interactive = input_pending.swap(false, Ordering::AcqRel);
                            if let Some(batch) = coalescer.push_after_input(&chunk, now, interactive) {
                                emit_batch(&output, batch);
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            if let Some(batch) = coalescer.flush_if_due(Instant::now()) {
                                emit_batch(&output, batch);
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            if let Some(batch) = coalescer.flush(Instant::now()) {
                                emit_batch(&output, batch);
                            }
                            break;
                        }
                    }
                }
            }));
            if outcome.is_err() {
                error!("PTY coalescer panicked");
            }
            let _ = flushed.send(());
        });
    if let Err(error) = coalescer_result {
        error!(id = %session.id, %error, "could not start the coalescer thread");
    }
}

/// Waits for the child, then lets the reader drain before sending `Exit`.
fn start_waiter(session: &Arc<Session>, mut child: Box<dyn Child + Send + Sync>, flushed: mpsc::Receiver<()>) {
    let delivery = Arc::clone(&session.delivery);
    let delivery_for_panic = Arc::clone(&session.delivery);
    let pid = Arc::clone(&session.process_id);
    let pid_for_panic = Arc::clone(&pid);
    let flow = Arc::clone(&session.flow);
    let id = session.id;
    let result = thread::Builder::new()
        .name(format!("tessera-pty-waiter-{id}"))
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let status = child.wait();
                pid.store(0, Ordering::Release);
                flow.close();
                let _ = flushed.recv_timeout(FINAL_FLUSH_TIMEOUT);
                let code = match status {
                    Ok(status) => status.exit_code(),
                    Err(error) => {
                        warn!(id = %id, %error, "could not wait for the PTY child");
                        1
                    }
                };
                emit_exit(&delivery, code);
            }));
            if outcome.is_err() {
                pid_for_panic.store(0, Ordering::Release);
                error!(id = %id, "PTY waiter panicked");
                emit_exit(&delivery_for_panic, 1);
            }
        });
    if let Err(error) = result {
        error!(id = %session.id, %error, "could not start the PTY waiter thread");
    }
}

#[cfg(windows)]
fn start_resize_thread(session: &Arc<Session>, receiver: mpsc::Receiver<PtySize>) {
    let id = session.id;
    let session = Arc::downgrade(session);
    let _ = thread::Builder::new()
        .name(format!("tessera-pty-resize-{id}"))
        .spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut latest = Some(first);
                loop {
                    match receiver.recv_timeout(RESIZE_DEBOUNCE) {
                        Ok(size) => latest = Some(size),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            return;
                        }
                    }
                }
                let Some(session) = session.upgrade() else { return };
                if let Some(size) = latest {
                    apply_resize(&session, size);
                }
            }
        });
}

#[cfg(windows)]
fn apply_resize(session: &Session, size: PtySize) {
    let master = lock(&session.master);
    if let Err(error) = master.resize(size) {
        debug!(id = %session.id, %error, "could not resize the ConPTY");
    }
}

fn emit_exit(delivery: &Mutex<Delivery>, code: u32) {
    let mut delivery = lock(delivery);
    delivery.exited = true;
    emit(&delivery.sinks, PtyEvent::Exit { code });
}

fn emit(sinks: &[EventSink], event: PtyEvent) {
    for sink in sinks {
        sink(event.clone());
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{Receiver, Sender};

    use super::*;

    #[test]
    fn prepared_program_requires_matching_path_name_and_existing_file() {
        let dir = tempfile::tempdir().expect("fixture");
        let executable = dir.path().join("prepared-tool");
        std::fs::write(&executable, b"fixture").expect("write");
        let host = PtyHost::new();
        *lock(&host.inner.prepared_program) = Some(("prepared-tool".into(), "cached-path".into(), executable.clone()));
        let matching = BTreeMap::from([("PATH".into(), "cached-path".into())]);
        assert_eq!(
            host.resolved_program("prepared-tool", &matching, Platform::current()),
            Some(executable.clone())
        );
        assert!(
            host.resolved_program("different-tool", &matching, Platform::current())
                .is_none()
        );
        let changed = BTreeMap::from([("PATH".into(), dir.path().join("missing").to_string_lossy().into_owned())]);
        assert!(
            host.resolved_program("prepared-tool", &changed, Platform::current())
                .is_none()
        );
        std::fs::remove_file(executable).expect("remove fixture");
        assert!(
            host.resolved_program("prepared-tool", &matching, Platform::current())
                .is_none()
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn prewarmed_pair_survives_invalid_request_and_is_resized_on_use() {
        let host = PtyHost::new();
        host.prewarm_default_session().expect("prewarm");
        assert!(lock(&host.inner.prepared_pty).is_some());
        let missing = std::env::temp_dir().join("tessera-prewarm-missing-directory");
        assert!(host.spawn(SpawnSpec::new(missing)).is_err());
        assert!(lock(&host.inner.prepared_pty).is_some());
        let mut spec = SpawnSpec::new(std::env::current_dir().expect("cwd"));
        #[cfg(target_os = "macos")]
        {
            spec.program = Some("/bin/sh".into());
            spec.args = vec!["-c".into(), "printf READY".into()];
        }
        #[cfg(windows)]
        {
            spec.program = Some("cmd".into());
            spec.args = vec!["/c".into(), "echo READY".into()];
        }
        spec.cols = 100;
        spec.rows = 40;
        let (tx, rx) = mpsc::channel();
        let id = host
            .spawn_with_sink(
                spec,
                Some(Arc::new(move |e| {
                    let _ = tx.send(e);
                })),
            )
            .expect("spawn");
        assert!(lock(&host.inner.prepared_pty).is_none());
        assert_eq!(host.size(&id).expect("size"), (100, 40));
        let deadline = Instant::now() + Duration::from_secs(if cfg!(windows) { 30 } else { 10 });
        let mut bytes = Vec::new();
        loop {
            match rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("output deadline")
            {
                PtyEvent::Data(chunk) => {
                    host.ack(&id, chunk.len()).expect("ack");
                    if chunk.windows(4).any(|p| p == b"\x1b[6n") {
                        host.write(&id, b"\x1b[1;1R").expect("cursor");
                    }
                    bytes.extend(chunk);
                }
                PtyEvent::Exit { code } => {
                    assert_eq!(code, 0);
                    break;
                }
            }
        }
        assert!(bytes.windows(5).any(|p| p == b"READY"));
    }

    #[test]
    #[cfg(windows)]
    fn conpty_prewarm_does_not_open_an_unserviced_pair() {
        let host = PtyHost::new();
        host.prewarm_default_session().expect("prewarm executable");
        assert!(lock(&host.inner.prepared_pty).is_none());
    }

    #[test]
    fn raw_prompt_marks_require_a_complete_terminator_and_fire_once() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let mut marks = ReadMarks::new(Arc::new(move |phase| lock(&captured).push(phase.to_string())));
        marks.observe(b"");
        assert!(lock(&events).is_empty());
        marks.observe(b"hello\x1b]133;B");
        assert_eq!(*lock(&events), ["first_byte"]);
        marks.observe(b"\x1b");
        assert_eq!(*lock(&events), ["first_byte"]);
        marks.observe(b"\\");
        marks.observe(b"\x1b]133;B\x07");
        assert_eq!(*lock(&events), ["first_byte", "prompt_read"]);
    }

    #[test]
    fn flow_control_limits_in_flight_bytes() {
        let flow = FlowControl::new(10);
        assert_eq!(flow.take(4), 4);
        assert_eq!(flow.in_flight(), 4);
        assert_eq!(flow.take(100), 6);
        assert_eq!(flow.in_flight(), 10);
        flow.ack(7);
        assert_eq!(flow.in_flight(), 3);
        assert_eq!(flow.take(10), 7);
        assert_eq!(flow.in_flight(), 10);
    }

    #[test]
    fn replacing_subscriber_releases_old_delivery_without_crediting_replay() {
        let flow = FlowControl::new(10);
        assert_eq!(flow.take(8), 8);
        flow.delivered(5);
        flow.replace_subscriber(12);
        assert_eq!(flow.in_flight(), 3, "queued live bytes remain charged");
        flow.delivered(3);
        flow.ack_delivered(12);
        assert_eq!(flow.in_flight(), 3, "replay acks do not release live credit");
        flow.ack_delivered(3);
        assert_eq!(flow.in_flight(), 0);
    }

    #[test]
    fn closing_releases_a_blocked_reader_before_exit_output_is_lost() {
        let flow = FlowControl::new(1);
        assert_eq!(flow.take(1), 1);
        flow.close();
        // A closed session drains without waiting for credit, so the final bytes are not lost.
        assert_eq!(flow.take(64), 64);
    }

    #[test]
    fn the_host_starts_empty() {
        let host = PtyHost::new();
        assert!(host.list().is_empty());
    }

    #[test]
    fn a_missing_working_directory_is_refused_before_spawning() {
        let host = PtyHost::new();
        let missing = std::env::temp_dir().join("tessera-pty-missing-cwd-does-not-exist");
        let error = host.spawn(SpawnSpec::new(missing)).expect_err("must fail");
        assert!(matches!(error, PtyError::CwdMissing { .. }));
        assert_eq!(error.code(), "CwdMissing");
        assert!(host.list().is_empty());
    }

    #[test]
    fn a_sink_receives_a_clone_of_every_event() {
        let mut sinks = Vec::new();
        let (sender, receiver): (Sender<PtyEvent>, Receiver<PtyEvent>) = mpsc::channel();
        let sender = Mutex::new(sender);
        let sink: EventSink = Arc::new(move |event| {
            let _ = sender.lock().expect("lock").send(event);
        });
        sinks.push(sink);
        emit(&sinks, PtyEvent::Data(b"hi".to_vec()));
        emit(&sinks, PtyEvent::Exit { code: 3 });
        assert_eq!(receiver.recv().expect("data"), PtyEvent::Data(b"hi".to_vec()));
        assert_eq!(receiver.recv().expect("exit"), PtyEvent::Exit { code: 3 });
    }
}
