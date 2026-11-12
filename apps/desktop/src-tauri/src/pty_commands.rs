//! Terminal commands (TRD §4.1, schema §4.1). Thin wrappers over `tessera-pty`.
//!
//! Output travels as **binary frames** on a `Channel<InvokeResponseBody>`, never as JSON: a frame is one tag byte
//! followed by its payload. Keystrokes arrive as the raw request body of `pty_write`, with the session id in the
//! `x-session-id` header. The frame layout is the contract with `packages/term` (`frames.ts`):
//!
//! | tag | meaning | payload |
//! | --- | --- | --- |
//! | `0` | output data | the bytes |
//! | `1` | process exit | exit code as `u32` little endian |

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, IpcResponse, Request};
use tauri::{Manager, State};
use tessera_pty::{PtyError, PtyEvent, SessionId, SpawnSpec};

use crate::error::AppError;
use crate::settings_commands::Settings;
use crate::state::AppState;

/// Frame tag: output data.
pub const FRAME_DATA: u8 = 0;
/// Frame tag: the process exited.
pub const FRAME_EXIT: u8 = 1;

/// One binary frame on the terminal channel (layout above).
///
/// It is sent as a raw `ArrayBuffer`, not JSON. The generated TypeScript type says `number[]` because specta cannot
/// express `ArrayBuffer`; `packages/term` decodes the real `ArrayBuffer` in `frames.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Type)]
#[specta(transparent)]
pub struct PtyFrame(Vec<u8>);

impl IpcResponse for PtyFrame {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(InvokeResponseBody::Raw(self.0))
    }
}

/// Everything the UI says about a new terminal session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SpawnInput {
    /// Working directory; must exist.
    pub cwd: String,
    /// Program to run; `None` runs the default shell.
    pub program: Option<String>,
    /// Program arguments.
    pub args: Option<Vec<String>>,
    /// Extra environment variables.
    pub env: Option<BTreeMap<String, String>>,
    /// Width in cells.
    pub cols: u16,
    /// Height in cells.
    pub rows: u16,
    /// The task this terminal belongs to, if any.
    pub task_id: Option<String>,
    /// The layout pane this terminal runs in; its history is saved under this id for restore after restart.
    #[serde(default)]
    pub pane_id: Option<String>,
}

/// Encodes one event as a binary frame. Pure, so the layout is unit-tested.
#[must_use]
pub fn encode_frame(event: &PtyEvent) -> Vec<u8> {
    match event {
        PtyEvent::Data(bytes) => {
            let mut frame = Vec::with_capacity(bytes.len() + 1);
            frame.push(FRAME_DATA);
            frame.extend_from_slice(bytes);
            frame
        }
        PtyEvent::Exit { code } => {
            let mut frame = Vec::with_capacity(5);
            frame.push(FRAME_EXIT);
            frame.extend_from_slice(&code.to_le_bytes());
            frame
        }
    }
}

impl From<PtyError> for AppError {
    fn from(error: PtyError) -> Self {
        let code = match &error {
            PtyError::CwdMissing { .. } => "pty.cwd_missing",
            PtyError::ProgramNotFound { .. } => "pty.program_not_found",
            PtyError::SpawnFailed { .. } => "pty.spawn_failed",
            PtyError::UnknownSession { .. } => "pty.unknown_session",
            PtyError::Io(_) => "pty.io",
        };
        Self::new(code, error.to_string())
    }
}

fn parse_id(id: &str) -> Result<SessionId, AppError> {
    id.parse::<SessionId>()
        .map_err(|_| AppError::new("pty.unknown_session", format!("unknown session {id}")))
}

/// Starts a terminal session and streams its output to `on_event`. Returns the session id.
#[tauri::command]
#[specta::specta]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    spec: SpawnInput,
    on_event: Channel<PtyFrame>,
) -> Result<String, AppError> {
    // Off the main thread: the first spawn may wait briefly for the session daemon connection.
    tauri::async_runtime::spawn_blocking(move || spawn_blocking(&app, &window, spec, on_event))
        .await
        .map_err(|error| AppError::new("pty.worker_failed", error.to_string()))?
}

fn spawn_blocking(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    spec: SpawnInput,
    on_event: Channel<PtyFrame>,
) -> Result<String, AppError> {
    let state = app.state::<AppState>();
    let settings = app.state::<Settings>();
    let benchmark = app.state::<Arc<crate::benchmark::Benchmark>>();
    benchmark.record("pty_spawn");
    let cwd = spec.cwd.clone();
    let shell = spec
        .program
        .clone()
        .unwrap_or_else(|| tessera_pty::default_shell(&std::env::vars().collect(), tessera_pty::Platform::current()));
    let mut spawn = SpawnSpec::new(PathBuf::from(spec.cwd));
    spawn.program = spec.program;
    spawn.args = spec.args.unwrap_or_default();
    spawn.env = spec.env.unwrap_or_default();
    spawn.cols = spec.cols;
    spawn.rows = spec.rows;
    spawn.task_id = spec.task_id;
    spawn.pane_id = spec.pane_id;
    spawn.subscriber_owner = Some(window.label().to_owned());
    let id = SessionId::new();
    spawn.session_id = Some(id);
    benchmark.record("shell_scripts_begin");
    apply_shell_integration(&mut spawn, &state.dirs.root, settings.shell_integration());
    benchmark.record("shell_scripts_ready");

    let sink = terminal_sink(id, on_event, benchmark.observer());
    let bench = Arc::clone(&benchmark);
    let id = state
        .sessions
        .spawn(spawn, sink, Arc::new(move |phase| bench.record(phase)))?;
    let metadata = tessera_store::restore::PaneSession {
        id: id.as_string(),
        window_id: window.label().to_owned(),
        cwd,
        shell,
        cols: spec.cols,
        rows: spec.rows,
    };
    if let Ok(store) = state.store.lock()
        && let Err(error) = store.pane_session_save(&metadata)
    {
        tracing::warn!(code = error.code(), "could not save session metadata");
    }
    Ok(id.as_string())
}

/// Reattaches a live terminal to this window. The first data frames replay scrollback, followed by live output.
#[tauri::command]
#[specta::specta]
pub async fn pty_attach(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    on_event: Channel<PtyFrame>,
) -> Result<(), AppError> {
    let id = parse_id(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .sessions
            .attach(&id, window.label().to_owned(), terminal_sink(id, on_event, None))
    })
    .await
    .map_err(|error| AppError::new("pty.worker_failed", error.to_string()))?
}

/// A running session started for `pane_id` in an earlier run that survived in the session daemon; a restored pane
/// re-attaches it (its scrollback replays) instead of starting a new shell.
#[tauri::command]
#[specta::specta]
pub async fn pty_live_session(app: tauri::AppHandle, pane_id: String) -> Result<Option<String>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .sessions
            .live_session_for_pane(&pane_id)
            .map(|id| id.as_string())
    })
    .await
    .map_err(|error| AppError::new("pty.worker_failed", error.to_string()))
}

#[derive(Default)]
struct ChannelOutput {
    frames_sent: u64,
    send_errors: u64,
    bytes_sent: usize,
}

impl ChannelOutput {
    fn send(
        &mut self,
        id: SessionId,
        started: Instant,
        event: PtyEvent,
        send: impl FnOnce(PtyFrame) -> tauri::Result<()>,
    ) {
        let bytes = match &event {
            PtyEvent::Data(bytes) => bytes.len(),
            PtyEvent::Exit { .. } => 0,
        };
        match send(PtyFrame(encode_frame(&event))) {
            Ok(()) => {
                self.frames_sent += 1;
                self.bytes_sent += bytes;
                if self.frames_sent == 1
                    || self.frames_sent.is_multiple_of(128)
                    || matches!(event, PtyEvent::Exit { .. })
                {
                    tracing::debug!(
                        %id, frames_sent = self.frames_sent, bytes_sent = self.bytes_sent,
                        send_errors = self.send_errors, elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
                        "PTY channel delivery"
                    );
                }
            }
            Err(error) => {
                self.send_errors += 1;
                tracing::debug!(
                    %id, %error, frames_sent = self.frames_sent, bytes_sent = self.bytes_sent,
                    send_errors = self.send_errors, "PTY channel send failed"
                );
            }
        }
    }
}

fn terminal_sink(
    id: SessionId,
    channel: Channel<PtyFrame>,
    observer: Option<crate::benchmark::OutputObserver>,
) -> tessera_pty::EventSink {
    let counters = Mutex::new(ChannelOutput::default());
    let started = Instant::now();
    Arc::new(move |event| {
        if let Some(observer) = &observer {
            observer.observe(&event);
        }
        counters
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .send(id, started, event, |frame| channel.send(frame));
    })
}

/// Adds prompt and cwd marks (OSC 133 and OSC 7) to an interactive shell through app-owned scripts. Never edits the
/// user's startup files; any failure logs and starts the shell without integration.
fn apply_shell_integration(spawn: &mut SpawnSpec, data_root: &std::path::Path, enabled: bool) {
    if !enabled {
        return;
    }
    let platform = tessera_pty::Platform::current();
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    env.extend(spawn.env.clone());
    let program = spawn
        .program
        .clone()
        .unwrap_or_else(|| tessera_pty::default_shell(&env, platform));
    // The host starts the default shell as a login shell; keep that when we choose the arguments ourselves.
    let args = if spawn.program.is_none() && !cfg!(windows) {
        vec!["-l".to_string()]
    } else {
        spawn.args.clone()
    };
    let plan = match tessera_shell::prepare_installed_launch(&program, &args, &env, data_root, enabled) {
        Ok(plan) => plan,
        Err(error) => {
            tracing::warn!(%error, "shell integration scripts unavailable; starting without them");
            return;
        }
    };
    if plan.injected {
        spawn.program = Some(program);
        spawn.args = plan.args;
        spawn.env.extend(plan.env);
    }
}

/// The shells found on this machine, for the new-terminal menu.
#[tauri::command]
#[specta::specta]
pub async fn shell_list() -> Result<Vec<ShellEntry>, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        tessera_shell::discover_shells()
            .into_iter()
            .map(|shell| ShellEntry {
                id: shell.id,
                name: shell.name,
                path: shell.path.to_string_lossy().into_owned(),
            })
            .collect()
    })
    .await
    .map_err(|error| AppError::new("shell.detect_failed", error.to_string()))
}

/// One detected shell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ShellEntry {
    /// Stable id (`zsh`, `pwsh`, `wsl:Ubuntu`, ...).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Executable path.
    pub path: String,
}

/// Writes raw keystroke bytes. The body is the bytes; the header `x-session-id` names the session.
#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, request: Request<'_>) -> Result<(), AppError> {
    let id = request
        .headers()
        .get("x-session-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::new("pty.unknown_session", "missing x-session-id header"))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new("pty.io", "pty_write needs a raw body"));
    };
    state.sessions.write(&parse_id(id)?, bytes)?;
    Ok(())
}

/// Resizes a session.
#[tauri::command]
#[specta::specta]
pub fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    px_w: u16,
    px_h: u16,
) -> Result<(), AppError> {
    state.sessions.resize(&parse_id(&session_id)?, cols, rows, px_w, px_h)?;
    state
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .pane_session_resize(&session_id, cols, rows)?;
    Ok(())
}

/// Returns flow-control credit after the UI has written `bytes` to the terminal.
#[tauri::command]
#[specta::specta]
pub fn pty_ack(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    session_id: String,
    bytes: u32,
) -> Result<(), AppError> {
    let id = parse_id(&session_id)?;
    state.sessions.ack(&id, window.label(), bytes as usize)?;
    Ok(())
}

/// Kills a session's process. Killing twice is fine. A user close also forgets the saved history.
#[tauri::command]
#[specta::specta]
pub fn pty_kill(state: State<'_, AppState>, window: tauri::WebviewWindow, session_id: String) -> Result<(), AppError> {
    let id = parse_id(&session_id)?;
    if !state.sessions.kill(&id, window.label())? {
        return Ok(());
    }
    if let Ok(store) = state.store.lock()
        && let Err(error) = store.pane_session_delete(&session_id)
    {
        tracing::warn!(code = error.code(), "could not delete saved terminal history");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_frames_start_with_tag_zero() {
        assert_eq!(encode_frame(&PtyEvent::Data(vec![104, 105])), vec![0, 104, 105]);
    }

    #[test]
    fn exit_frames_carry_the_code_little_endian() {
        assert_eq!(encode_frame(&PtyEvent::Exit { code: 7 }), vec![1, 7, 0, 0, 0]);
        assert_eq!(encode_frame(&PtyEvent::Exit { code: 0x0102_0304 }), vec![1, 4, 3, 2, 1]);
    }

    #[test]
    fn failed_channel_sends_are_counted_separately_from_delivered_frames() {
        let mut output = ChannelOutput::default();
        let id = SessionId::new();
        let started = Instant::now();
        output.send(id, started, PtyEvent::Data(vec![b'a']), |frame| {
            assert_eq!(frame.0, [0, b'a']);
            Err(tauri::Error::Io(std::io::Error::other("closed channel")))
        });
        output.send(id, started, PtyEvent::Data(vec![b'b', b'c']), |_| Ok(()));
        assert_eq!(output.frames_sent, 1);
        assert_eq!(output.send_errors, 1);
        assert_eq!(output.bytes_sent, 2);
    }

    #[test]
    fn pty_errors_map_to_stable_codes() {
        let error = AppError::from(PtyError::CwdMissing { path: "/nope".into() });
        assert_eq!(error.code, "pty.cwd_missing");
    }

    #[test]
    fn a_bad_session_id_is_an_unknown_session() {
        assert_eq!(parse_id("not-a-ulid").unwrap_err().code, "pty.unknown_session");
    }
}
