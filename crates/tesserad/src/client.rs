//! The app side: connects to `tesserad`, starts it when nothing answers, and routes each session's output to the
//! sink registered for it. A sink is registered before the request that produces output (the client picks the
//! session id for a spawn), so no early output is lost.

use crate::endpoint::Endpoint;
use crate::protocol::{
    Frame, PROTOCOL_VERSION, Reply, Request, SessionInfo, Shared, SpawnRequest, read_frame, write_frame,
};
use interprocess::local_socket::{Stream, prelude::*};
use std::collections::HashMap;
use std::io::{self, BufReader, BufWriter};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::time::{Duration, Instant};
use tessera_pty::{EventSink, PtyEvent, SessionId};

/// How long a request waits for its reply.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long [`connect_or_start`] waits for a freshly started daemon.
pub const START_TIMEOUT: Duration = Duration::from_secs(5);

/// Client errors.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// Nothing answers on the endpoint, or the token file is missing.
    #[error("the session daemon is not running: {0}")]
    NotRunning(io::Error),
    /// The daemon refused the handshake.
    #[error("the session daemon refused the connection: {0}")]
    Refused(String),
    /// The connection broke.
    #[error("the session daemon connection closed")]
    Disconnected,
    /// No reply in time.
    #[error("the session daemon did not answer in time")]
    Timeout,
    /// The daemon answered with an error.
    #[error("{message}")]
    Failed {
        /// Stable code.
        code: String,
        /// Human sentence.
        message: String,
    },
    /// Other I/O.
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// What a waiting request receives: a JSON reply or a binary blob.
enum Answer {
    Reply(Reply),
    Blob(Vec<u8>),
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Answer>>>>;
type Sinks = Arc<Mutex<HashMap<SessionId, EventSink>>>;

/// A connection to the session daemon. Cheap to share behind an `Arc`.
pub struct Client {
    writer: Mutex<BufWriter<Shared>>,
    pending: Pending,
    sinks: Sinks,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    version: String,
    pid: u32,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Client {
    /// Connects and completes the handshake.
    ///
    /// # Errors
    /// [`ClientError::NotRunning`] when nothing answers, [`ClientError::Refused`] on a bad token or protocol.
    pub fn connect(endpoint: &Endpoint, client: &str) -> Result<Self, ClientError> {
        let token = endpoint.read_token().map_err(ClientError::NotRunning)?;
        let stream = Stream::connect(endpoint.name()?).map_err(ClientError::NotRunning)?;
        let shared = Shared(Arc::new(stream));
        let (receive, send) = (shared.clone(), shared);
        let mut writer = BufWriter::new(send);
        let mut reader = BufReader::new(receive);
        write_frame(
            &mut writer,
            &Frame::control(&Request::Hello {
                protocol: PROTOCOL_VERSION,
                token,
                client: client.to_owned(),
            })?,
        )?;
        let (version, pid) = match read_frame(&mut reader)? {
            Some(Frame::Control(json)) => match serde_json::from_slice::<Reply>(&json).map_err(io::Error::other)? {
                Reply::Welcome { version, pid, .. } => (version, pid),
                Reply::Refused { reason } => return Err(ClientError::Refused(reason)),
                _ => return Err(ClientError::Refused("unexpected handshake reply".into())),
            },
            _ => return Err(ClientError::Disconnected),
        };
        let pending: Pending = Arc::default();
        let sinks: Sinks = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        let (reader_pending, reader_sinks, reader_closed) =
            (Arc::clone(&pending), Arc::clone(&sinks), Arc::clone(&closed));
        std::thread::Builder::new()
            .name("tesserad-client-reader".into())
            .spawn(move || route(reader, &reader_pending, &reader_sinks, &reader_closed))?;
        Ok(Self {
            writer: Mutex::new(writer),
            pending,
            sinks,
            next_id: AtomicU64::new(1),
            closed,
            version,
            pid,
        })
    }

    /// The daemon's build version.
    #[must_use]
    pub fn daemon_version(&self) -> &str {
        &self.version
    }

    /// The daemon's process id.
    #[must_use]
    pub fn daemon_pid(&self) -> u32 {
        self.pid
    }

    /// False once the connection broke.
    #[must_use]
    pub fn is_connected(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
    }

    fn send(&self, frame: &Frame) -> Result<(), ClientError> {
        if !self.is_connected() {
            return Err(ClientError::Disconnected);
        }
        write_frame(&mut *lock(&self.writer), frame).map_err(|_| ClientError::Disconnected)
    }

    fn request(&self, build: impl FnOnce(u64) -> Request) -> Result<Reply, ClientError> {
        match self.ask(build)? {
            Answer::Reply(reply) => Ok(reply),
            Answer::Blob(_) => Err(ClientError::Disconnected),
        }
    }

    fn ask(&self, build: impl FnOnce(u64) -> Request) -> Result<Answer, ClientError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        lock(&self.pending).insert(id, tx);
        if let Err(error) = self.send(&Frame::control(&build(id))?) {
            lock(&self.pending).remove(&id);
            return Err(error);
        }
        let reply = rx.recv_timeout(REQUEST_TIMEOUT).map_err(|error| {
            lock(&self.pending).remove(&id);
            match error {
                mpsc::RecvTimeoutError::Timeout => ClientError::Timeout,
                mpsc::RecvTimeoutError::Disconnected => ClientError::Disconnected,
            }
        })?;
        match reply {
            Answer::Reply(Reply::Failed { code, message, .. }) => Err(ClientError::Failed { code, message }),
            other => Ok(other),
        }
    }

    /// A session's scrollback ring (the last 2 MiB of output).
    ///
    /// # Errors
    /// `pty.unknown_session`, or connection errors.
    pub fn snapshot(&self, session: SessionId) -> Result<Vec<u8>, ClientError> {
        match self.ask(|id| Request::Snapshot {
            id,
            session: session.as_string(),
        })? {
            Answer::Blob(bytes) => Ok(bytes),
            Answer::Reply(_) => Err(ClientError::Disconnected),
        }
    }

    /// Starts a session; its output and exit go to `sink`.
    ///
    /// # Errors
    /// Spawn failures from the daemon (`pty.spawn_failed`) or connection errors.
    pub fn spawn(&self, mut spec: SpawnRequest, sink: EventSink) -> Result<SessionId, ClientError> {
        let session = SessionId::new();
        spec.session = Some(session.as_string());
        lock(&self.sinks).insert(session, sink);
        match self.request(|id| Request::Spawn { id, spec }) {
            Ok(_) => Ok(session),
            Err(error) => {
                lock(&self.sinks).remove(&session);
                Err(error)
            }
        }
    }

    /// Subscribes to a running session: the scrollback replays first, then live output.
    ///
    /// # Errors
    /// `pty.unknown_session` when it is gone or exited.
    pub fn attach(&self, session: SessionId, sink: EventSink) -> Result<(), ClientError> {
        lock(&self.sinks).insert(session, sink);
        let result = self.request(|id| Request::Attach {
            id,
            session: session.as_string(),
        });
        if result.is_err() {
            lock(&self.sinks).remove(&session);
        }
        result.map(|_| ())
    }

    /// Stops receiving a session's output; the session keeps running.
    ///
    /// # Errors
    /// Connection errors.
    pub fn detach(&self, session: SessionId) -> Result<(), ClientError> {
        lock(&self.sinks).remove(&session);
        self.send(&Frame::control(&Request::Detach {
            session: session.as_string(),
        })?)
    }

    /// Sends input bytes.
    ///
    /// # Errors
    /// Connection errors.
    pub fn write(&self, session: SessionId, bytes: &[u8]) -> Result<(), ClientError> {
        self.send(&Frame::Input(session, bytes.to_vec()))
    }

    /// Resizes a session.
    ///
    /// # Errors
    /// Connection errors.
    pub fn resize(
        &self,
        session: SessionId,
        cols: u16,
        rows: u16,
        px_width: u16,
        px_height: u16,
    ) -> Result<(), ClientError> {
        self.send(&Frame::control(&Request::Resize {
            session: session.as_string(),
            cols,
            rows,
            px_width,
            px_height,
        })?)
    }

    /// Acknowledges rendered output (flow control).
    ///
    /// # Errors
    /// Connection errors.
    pub fn ack(&self, session: SessionId, bytes: usize) -> Result<(), ClientError> {
        self.send(&Frame::control(&Request::Ack {
            session: session.as_string(),
            bytes,
        })?)
    }

    /// Ends a session's process.
    ///
    /// # Errors
    /// Connection errors.
    pub fn kill(&self, session: SessionId) -> Result<(), ClientError> {
        self.send(&Frame::control(&Request::Kill {
            session: session.as_string(),
        })?)
    }

    /// Lists the daemon's sessions, oldest first.
    ///
    /// # Errors
    /// Connection errors.
    pub fn list(&self) -> Result<Vec<SessionInfo>, ClientError> {
        match self.request(|id| Request::List { id })? {
            Reply::Sessions { sessions, .. } => Ok(sessions),
            _ => Err(ClientError::Disconnected),
        }
    }

    /// Asks the daemon to quit (ending every session unless `only_if_idle`, which refuses while sessions run).
    ///
    /// # Errors
    /// `daemon.busy`, or connection errors.
    pub fn shutdown(&self, only_if_idle: bool) -> Result<(), ClientError> {
        self.request(|id| Request::Shutdown { id, only_if_idle }).map(|_| ())
    }
}

impl Drop for Client {
    /// Tells the daemon this client is gone, so it detaches the client's sessions (they keep running) and closes the
    /// connection, which also ends the reader thread.
    fn drop(&mut self) {
        if self.is_connected()
            && let Ok(frame) = Frame::control(&Request::Bye)
        {
            let _ = write_frame(&mut *lock(&self.writer), &frame);
        }
    }
}

fn route(mut reader: impl io::Read, pending: &Pending, sinks: &Sinks, closed: &AtomicBool) {
    loop {
        match read_frame(&mut reader) {
            Ok(Some(Frame::Output(session, bytes))) => {
                let sink = lock(sinks).get(&session).cloned();
                if let Some(sink) = sink {
                    sink(PtyEvent::Data(bytes));
                }
            }
            Ok(Some(Frame::Control(json))) => match serde_json::from_slice::<Reply>(&json) {
                Ok(Reply::Exited { session, code }) => {
                    if let Ok(id) = session.parse::<SessionId>() {
                        let sink = lock(sinks).remove(&id);
                        if let Some(sink) = sink {
                            sink(PtyEvent::Exit { code });
                        }
                    }
                }
                Ok(reply) => {
                    let id = match &reply {
                        Reply::Spawned { id, .. }
                        | Reply::Attached { id, .. }
                        | Reply::Sessions { id, .. }
                        | Reply::Done { id }
                        | Reply::Failed { id, .. } => *id,
                        _ => continue,
                    };
                    if let Some(waiter) = lock(pending).remove(&id) {
                        let _ = waiter.send(Answer::Reply(reply));
                    }
                }
                Err(error) => tracing::warn!(%error, "unreadable daemon reply"),
            },
            Ok(Some(Frame::Blob(id, bytes))) => {
                if let Some(waiter) = lock(pending).remove(&id) {
                    let _ = waiter.send(Answer::Blob(bytes));
                }
            }
            Ok(Some(Frame::Input(..))) => {}
            Ok(None) | Err(_) => break,
        }
    }
    closed.store(true, Ordering::Release);
    lock(pending).clear();
    // The daemon went away: its sessions are lost to this client. End every pane cleanly instead of leaving it
    // waiting for output that will never come.
    let orphans: Vec<EventSink> = lock(sinks).drain().map(|(_, sink)| sink).collect();
    for sink in orphans {
        sink(PtyEvent::Exit { code: 1 });
    }
}

/// Connects to the daemon for `endpoint`, starting `daemon_exe` detached when nothing answers.
///
/// # Errors
/// The daemon could not be started or did not answer within [`START_TIMEOUT`].
///
/// A daemon from another build (`version` differs) that has no running session is asked to quit and replaced, so an
/// update takes effect; one that still runs sessions is kept (they are worth more than the update) and replaced the
/// next time it is idle.
pub fn connect_or_start(
    endpoint: &Endpoint,
    daemon_exe: &Path,
    client: &str,
    version: &str,
) -> Result<Client, ClientError> {
    match Client::connect(endpoint, client) {
        Ok(existing) if existing.daemon_version() == version => return Ok(existing),
        Ok(existing) => match existing.shutdown(true) {
            Ok(()) => {
                tracing::info!(
                    old = existing.daemon_version(),
                    new = version,
                    "replacing an idle session daemon"
                );
                drop(existing);
                wait_gone(endpoint);
            }
            Err(ClientError::Failed { code, .. }) if code == "daemon.busy" => {
                tracing::info!(
                    old = existing.daemon_version(),
                    "keeping an older session daemon: sessions still run"
                );
                return Ok(existing);
            }
            Err(error) => return Err(error),
        },
        Err(ClientError::NotRunning(_)) => {}
        Err(error) => return Err(error),
    }
    start_detached(daemon_exe, endpoint.data_dir())?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        match Client::connect(endpoint, client) {
            Ok(client) => return Ok(client),
            Err(ClientError::NotRunning(error)) if Instant::now() >= deadline => {
                return Err(ClientError::NotRunning(error));
            }
            Err(ClientError::NotRunning(_) | ClientError::Refused(_)) if Instant::now() < deadline => {
                // The token file can be a step ahead of the listener, or still the old one: try again.
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(error),
        }
    }
}

/// Waits until nothing answers on the endpoint (a daemon that was told to quit).
fn wait_gone(endpoint: &Endpoint) {
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        match endpoint.name().and_then(Stream::connect) {
            Ok(_) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return,
        }
    }
}

/// Starts the daemon so it outlives the app: its own process group on macOS; detached with a new process group and
/// no console window on Windows (the ConPTY handles then belong to the daemon).
///
/// # Errors
/// The program could not be started.
pub fn start_detached(daemon_exe: &Path, data_dir: &Path) -> io::Result<()> {
    let mut command = std::process::Command::new(daemon_exe);
    command
        .arg("--data")
        .arg(data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = command.spawn()?;
    // Reap it when it quits while the app still runs (no zombie on macOS).
    std::thread::Builder::new()
        .name("tesserad-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        })?;
    Ok(())
}
