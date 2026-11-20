//! The daemon side: owns a [`PtyHost`], serves clients over the local socket, quits when idle.
//!
//! One thread per connection reads frames; a second writes them from a channel, so a PTY reader thread never blocks
//! on a slow client (flow control bounds what is queued: each session pauses after 2 MiB not yet acknowledged). When a
//! client goes away its subscriptions are dropped but every session keeps running, with its scrollback ring, until
//! a later client attaches or kills it.

use crate::endpoint::{Endpoint, tokens_match};
use crate::protocol::{
    Frame, PROTOCOL_VERSION, Reply, Request, SessionInfo, Shared, SpawnRequest, read_frame, write_frame,
};
use interprocess::local_socket::{ListenerOptions, Stream, prelude::*};
use std::io::{self, BufReader, BufWriter};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use tessera_pty::{EventSink, PtyEvent, PtyHost, SessionId, SpawnSpec};

/// Daemon settings.
#[derive(Debug, Clone)]
pub struct Options {
    /// Quit after this long with no client and no running session (TRD: 10 minutes).
    pub idle: Duration,
    /// Version reported in [`Reply::Welcome`].
    pub version: String,
    /// Resolve the login shell environment for spawned sessions (off in tests that pass their own env).
    pub login_environment: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            idle: Duration::from_secs(600),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            login_environment: true,
        }
    }
}

struct Daemon {
    host: PtyHost,
    token: String,
    options: Options,
    clients: AtomicUsize,
    next_client: AtomicU64,
    quit: AtomicBool,
    socket_file: Option<PathBuf>,
}

/// Errors that stop the daemon from starting.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// Another daemon already answers on this endpoint.
    #[error("a session daemon is already running at {0}")]
    AlreadyRunning(String),
    /// Socket or token file errors.
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Listens on `endpoint` and serves clients until idle or told to shut down. Writes a fresh token first.
///
/// # Errors
/// [`StartError::AlreadyRunning`] when a live daemon owns the endpoint; I/O errors from the socket or token file.
pub fn run(endpoint: &Endpoint, options: Options) -> Result<(), StartError> {
    let listener = bind(endpoint)?;
    let token = endpoint.create_token()?;
    let host = PtyHost::new();
    if options.login_environment {
        host.start_login_environment(endpoint.data_dir());
        // Same first-spawn speed-up the app had: prepare the default shell off the request path.
        let warm = host.clone();
        std::thread::Builder::new()
            .name("tesserad-prewarm".into())
            .spawn(move || {
                if let Err(error) = warm.prewarm_default_session() {
                    tracing::debug!(%error, "session prewarm unavailable");
                }
            })?;
    }
    let daemon = Arc::new(Daemon {
        host,
        token,
        options,
        clients: AtomicUsize::new(0),
        next_client: AtomicU64::new(1),
        quit: AtomicBool::new(false),
        socket_file: (!cfg!(windows)).then(|| endpoint.socket_path()),
    });
    tracing::info!(endpoint = %endpoint.display(), pid = std::process::id(), "session daemon listening");
    let watchdog = Arc::clone(&daemon);
    std::thread::Builder::new()
        .name("tesserad-watchdog".into())
        .spawn(move || watch(&watchdog))?;
    for connection in listener.incoming() {
        match connection {
            Ok(stream) => {
                let daemon = Arc::clone(&daemon);
                if let Err(error) = std::thread::Builder::new()
                    .name("tesserad-client".into())
                    .spawn(move || serve(&daemon, stream))
                {
                    tracing::warn!(%error, "could not start a client thread");
                }
            }
            Err(error) => tracing::warn!(%error, "incoming connection failed"),
        }
    }
    Ok(())
}

fn bind(endpoint: &Endpoint) -> Result<interprocess::local_socket::Listener, StartError> {
    std::fs::create_dir_all(endpoint.data_dir())?;
    let create = || ListenerOptions::new().name(endpoint.name()?).create_sync();
    let listener = match create() {
        Ok(listener) => listener,
        // Unix: the socket file exists. Windows: the pipe was created with FILE_FLAG_FIRST_PIPE_INSTANCE, so a
        // second server gets ERROR_ACCESS_DENIED (PermissionDenied) while the first one lives.
        Err(error)
            if error.kind() == io::ErrorKind::AddrInUse
                || (cfg!(windows) && error.kind() == io::ErrorKind::PermissionDenied) =>
        {
            // A live daemon answers; a stale socket file from a crash does not.
            if Stream::connect(endpoint.name()?).is_ok() {
                return Err(StartError::AlreadyRunning(endpoint.display()));
            }
            if !cfg!(windows) {
                std::fs::remove_file(endpoint.socket_path())?;
            }
            create()?
        }
        Err(error) => return Err(error.into()),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(endpoint.socket_path(), std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(listener)
}

/// Prunes exited sessions nobody watches and quits after the idle period or on a shutdown request.
fn watch(daemon: &Daemon) {
    let tick = (daemon.options.idle / 10).clamp(Duration::from_millis(100), Duration::from_secs(1));
    let mut idle_since: Option<Instant> = None;
    loop {
        std::thread::sleep(tick);
        daemon.host.forget_exited();
        if daemon.quit.load(Ordering::Acquire) {
            exit(daemon);
        }
        let running = daemon
            .host
            .list()
            .iter()
            .any(|id| daemon.host.describe(id).is_ok_and(|d| !d.exited));
        if running || daemon.clients.load(Ordering::Acquire) > 0 {
            idle_since = None;
            continue;
        }
        let since = *idle_since.get_or_insert_with(Instant::now);
        if since.elapsed() >= daemon.options.idle {
            tracing::info!("no clients and no sessions: the session daemon quits");
            exit(daemon);
        }
    }
}

fn exit(daemon: &Daemon) -> ! {
    if let Some(socket) = &daemon.socket_file {
        let _ = std::fs::remove_file(socket);
    }
    std::process::exit(0);
}

fn serve(daemon: &Arc<Daemon>, stream: Stream) {
    let shared = Shared(Arc::new(stream));
    let (receive, send) = (shared.clone(), shared);
    let (tx, rx) = mpsc::channel::<Frame>();
    let writer = std::thread::Builder::new()
        .name("tesserad-writer".into())
        .spawn(move || {
            let mut send = BufWriter::new(send);
            for frame in rx {
                if write_frame(&mut send, &frame).is_err() {
                    break;
                }
            }
        });
    if writer.is_err() {
        return;
    }
    let mut receive = BufReader::new(receive);
    if !handshake(daemon, &mut receive, &tx) {
        return;
    }
    let owner = format!("client-{}", daemon.next_client.fetch_add(1, Ordering::Relaxed));
    daemon.clients.fetch_add(1, Ordering::AcqRel);
    tracing::info!(%owner, "client connected");
    loop {
        match read_frame(&mut receive) {
            Ok(Some(Frame::Input(id, bytes))) => {
                if let Err(error) = daemon.host.write(&id, &bytes) {
                    tracing::debug!(%error, "input for a session that is gone");
                }
            }
            Ok(Some(Frame::Control(json))) => match serde_json::from_slice::<Request>(&json) {
                Ok(Request::Bye) => break,
                Ok(request) => handle(daemon, &owner, &tx, request),
                Err(error) => tracing::warn!(%error, "unreadable request"),
            },
            Ok(Some(Frame::Output(..) | Frame::Blob(..))) => tracing::warn!("a client sent a daemon-only frame"),
            Ok(None) => break,
            Err(error) => {
                tracing::debug!(%error, "client stream ended");
                break;
            }
        }
    }
    daemon.host.detach_owner(&owner);
    daemon.clients.fetch_sub(1, Ordering::AcqRel);
    tracing::info!(%owner, "client disconnected; its sessions keep running");
}

fn handshake(daemon: &Daemon, receive: &mut impl io::Read, tx: &mpsc::Sender<Frame>) -> bool {
    let refuse = |reason: &str| {
        if let Ok(frame) = Frame::control(&Reply::Refused { reason: reason.into() }) {
            let _ = tx.send(frame);
        }
        false
    };
    let Ok(Some(Frame::Control(json))) = read_frame(receive) else {
        return refuse("expected hello");
    };
    let Ok(Request::Hello {
        protocol,
        token,
        client,
    }) = serde_json::from_slice::<Request>(&json)
    else {
        return refuse("expected hello");
    };
    if !tokens_match(&daemon.token, &token) {
        tracing::warn!(%client, "refused a client with a wrong token");
        return refuse("wrong token");
    }
    if protocol != PROTOCOL_VERSION {
        return refuse(&format!(
            "protocol {protocol} is not supported (daemon speaks {PROTOCOL_VERSION})"
        ));
    }
    Frame::control(&Reply::Welcome {
        protocol: PROTOCOL_VERSION,
        version: daemon.options.version.clone(),
        pid: std::process::id(),
    })
    .is_ok_and(|frame| tx.send(frame).is_ok())
}

fn sink(tx: &mpsc::Sender<Frame>, id: SessionId) -> EventSink {
    let tx = tx.clone();
    Arc::new(move |event| {
        let frame = match event {
            PtyEvent::Data(bytes) => Frame::Output(id, bytes),
            PtyEvent::Exit { code } => match Frame::control(&Reply::Exited {
                session: id.as_string(),
                code,
            }) {
                Ok(frame) => frame,
                Err(_) => return,
            },
        };
        let _ = tx.send(frame);
    })
}

fn reply(tx: &mpsc::Sender<Frame>, message: &Reply) {
    if let Ok(frame) = Frame::control(message) {
        let _ = tx.send(frame);
    }
}

fn failed(id: u64, code: &str, message: impl ToString) -> Reply {
    Reply::Failed {
        id,
        code: code.into(),
        message: message.to_string(),
    }
}

fn parse(text: &str) -> Option<SessionId> {
    text.parse().ok()
}

fn spec(request: SpawnRequest, owner: &str, id: SessionId) -> SpawnSpec {
    let mut spec = SpawnSpec::new(request.cwd);
    spec.program = request.program;
    spec.args = request.args;
    spec.env = request.env;
    spec.cols = request.cols.max(1);
    spec.rows = request.rows.max(1);
    spec.task_id = request.task_id;
    spec.pane_id = request.pane_id;
    spec.subscriber_owner = Some(owner.to_owned());
    spec.session_id = Some(id);
    spec
}

fn handle(daemon: &Daemon, owner: &str, tx: &mpsc::Sender<Frame>, request: Request) {
    let host = &daemon.host;
    match request {
        Request::Hello { .. } | Request::Bye => tracing::warn!("a second hello was ignored"),
        Request::Spawn { id, spec: request } => {
            let session = request
                .session
                .as_deref()
                .and_then(parse)
                .filter(|sid| host.describe(sid).is_err())
                .unwrap_or_default();
            match host.spawn_with_sink(spec(request, owner, session), Some(sink(tx, session))) {
                Ok(session) => reply(
                    tx,
                    &Reply::Spawned {
                        id,
                        session: session.as_string(),
                    },
                ),
                Err(error) => reply(tx, &failed(id, "pty.spawn_failed", error)),
            }
        }
        Request::Attach { id, session } => match parse(&session) {
            Some(sid) => match host.attach(&sid, owner.to_owned(), sink(tx, sid)) {
                Ok(()) => reply(tx, &Reply::Attached { id, session }),
                Err(error) => reply(tx, &failed(id, "pty.unknown_session", error)),
            },
            None => reply(tx, &failed(id, "pty.unknown_session", "not a session id")),
        },
        Request::Detach { session } => {
            if let Some(sid) = parse(&session) {
                let _ = host.detach(&sid, owner);
            }
        }
        Request::Resize {
            session,
            cols,
            rows,
            px_width,
            px_height,
        } => {
            if let Some(sid) = parse(&session) {
                let _ = host.resize(&sid, cols, rows, px_width, px_height);
            }
        }
        Request::Ack { session, bytes } => {
            if let Some(sid) = parse(&session) {
                let _ = host.ack(&sid, bytes);
            }
        }
        Request::Kill { session } => {
            if let Some(sid) = parse(&session) {
                let _ = host.kill(&sid);
            }
        }
        Request::Snapshot { id, session } => match parse(&session).map(|sid| host.snapshot(&sid)) {
            Some(Ok(bytes)) => {
                let _ = tx.send(Frame::Blob(id, bytes));
            }
            Some(Err(error)) => reply(tx, &failed(id, "pty.unknown_session", error)),
            None => reply(tx, &failed(id, "pty.unknown_session", "not a session id")),
        },
        Request::List { id } => {
            let sessions = host
                .list()
                .iter()
                .filter_map(|sid| host.describe(sid).ok())
                .map(|d| SessionInfo {
                    session: d.id.as_string(),
                    pane_id: d.pane_id,
                    task_id: d.task_id,
                    cwd: d.cwd.to_string_lossy().into_owned(),
                    cols: d.cols,
                    rows: d.rows,
                    pid: d.pid,
                    exited: d.exited,
                    attached: d.attached,
                })
                .collect();
            reply(tx, &Reply::Sessions { id, sessions });
        }
        Request::Shutdown { id, only_if_idle } => {
            let busy = host
                .list()
                .iter()
                .any(|sid| host.describe(sid).is_ok_and(|d| !d.exited));
            if only_if_idle && busy {
                reply(tx, &failed(id, "daemon.busy", "Sessions are still running."));
            } else {
                for sid in host.list() {
                    let _ = host.kill(&sid);
                }
                reply(tx, &Reply::Done { id });
                daemon.quit.store(true, Ordering::Release);
            }
        }
    }
}
