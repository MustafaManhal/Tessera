//! Wire protocol between the app and `tesserad` (TRD 4.1, 4.10): length-prefixed frames over a local socket.
//!
//! Frame: `u32` little-endian length of the rest, then one kind byte, then the payload.
//! - kind 0, control: UTF-8 JSON, a [`Request`] from the client or a [`Reply`] from the daemon;
//! - kind 1, output: 16-byte session id (ULID, big-endian) followed by terminal output bytes (daemon to client);
//! - kind 2, input: 16-byte session id followed by bytes for the terminal (client to daemon);
//! - kind 3, blob: 8-byte little-endian request id followed by bytes (the answer to [`Request::Snapshot`]).
//!
//! Keystrokes and output never go through JSON. The first client frame must be [`Request::Hello`] with the token
//! from the token file; anything else closes the connection.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use tessera_pty::SessionId;

/// Bumped when a frame or message changes incompatibly. The app refuses a daemon with another version.
pub const PROTOCOL_VERSION: u32 = 1;
/// Upper bound for one frame; larger lengths are treated as a corrupt stream.
pub const MAX_FRAME: usize = 8 * 1024 * 1024;

const KIND_CONTROL: u8 = 0;
const KIND_OUTPUT: u8 = 1;
const KIND_INPUT: u8 = 2;
const KIND_BLOB: u8 = 3;

/// A local socket stream shared by a reading and a writing thread (`&Stream` is both `Read` and `Write`).
#[derive(Clone)]
pub(crate) struct Shared(pub(crate) std::sync::Arc<interprocess::local_socket::Stream>);

impl Read for Shared {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&*self.0).read(buf)
    }
}

impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&*self.0).write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        (&*self.0).flush()
    }
}

/// One frame on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// JSON control message.
    Control(Vec<u8>),
    /// Terminal output for a session.
    Output(SessionId, Vec<u8>),
    /// Input for a session.
    Input(SessionId, Vec<u8>),
    /// Binary answer to a request (a snapshot), tagged with the request id.
    Blob(u64, Vec<u8>),
}

impl Frame {
    /// A control frame holding `message` as JSON.
    ///
    /// # Errors
    /// Serialization errors (never expected for these types).
    pub fn control(message: &impl Serialize) -> io::Result<Self> {
        serde_json::to_vec(message).map(Self::Control).map_err(io::Error::other)
    }
}

/// Writes one frame and flushes it.
///
/// # Errors
/// I/O errors from the stream.
pub fn write_frame(writer: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let mut prefix = Vec::with_capacity(16);
    let (kind, payload): (u8, &[u8]) = match frame {
        Frame::Control(json) => (KIND_CONTROL, json),
        Frame::Output(id, bytes) => {
            prefix.extend_from_slice(&id.as_ulid().0.to_be_bytes());
            (KIND_OUTPUT, bytes)
        }
        Frame::Input(id, bytes) => {
            prefix.extend_from_slice(&id.as_ulid().0.to_be_bytes());
            (KIND_INPUT, bytes)
        }
        Frame::Blob(request, bytes) => {
            prefix.extend_from_slice(&request.to_le_bytes());
            (KIND_BLOB, bytes)
        }
    };
    let length = 1 + prefix.len() + payload.len();
    if length > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
    }
    let mut buffer = Vec::with_capacity(4 + length);
    buffer.extend_from_slice(&u32::try_from(length).unwrap_or(u32::MAX).to_le_bytes());
    buffer.push(kind);
    buffer.extend_from_slice(&prefix);
    buffer.extend_from_slice(payload);
    writer.write_all(&buffer)?;
    writer.flush()
}

/// Reads one frame; `Ok(None)` when the peer closed the stream cleanly between frames.
///
/// # Errors
/// I/O errors, a truncated frame, an unknown kind or an oversized length (`InvalidData`).
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut length = [0u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad frame length"));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let kind = body[0];
    let session = |body: &[u8]| -> io::Result<(SessionId, Vec<u8>)> {
        if body.len() < 17 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "short data frame"));
        }
        let mut id = [0u8; 16];
        id.copy_from_slice(&body[1..17]);
        Ok((
            SessionId::from_ulid(ulid::Ulid(u128::from_be_bytes(id))),
            body[17..].to_vec(),
        ))
    };
    match kind {
        KIND_CONTROL => Ok(Some(Frame::Control(body[1..].to_vec()))),
        KIND_OUTPUT => session(&body).map(|(id, bytes)| Some(Frame::Output(id, bytes))),
        KIND_INPUT => session(&body).map(|(id, bytes)| Some(Frame::Input(id, bytes))),
        KIND_BLOB if body.len() >= 9 => {
            let mut request = [0u8; 8];
            request.copy_from_slice(&body[1..9]);
            Ok(Some(Frame::Blob(u64::from_le_bytes(request), body[9..].to_vec())))
        }
        KIND_BLOB => Err(io::Error::new(io::ErrorKind::InvalidData, "short blob frame")),
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, "unknown frame kind")),
    }
}

/// What the app asks for a new session (mirrors `tessera_pty::SpawnSpec`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SpawnRequest {
    /// Program; `None` runs the default login shell.
    pub program: Option<String>,
    /// Arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Working directory (must exist).
    pub cwd: String,
    /// Extra environment.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Width in cells.
    pub cols: u16,
    /// Height in cells.
    pub rows: u16,
    /// Task id, exported as `TESSERA_TASK_ID`.
    pub task_id: Option<String>,
    /// UI pane id; history and re-attach use it.
    pub pane_id: Option<String>,
    /// Session id chosen by the client (so it can route output before the reply); the daemon picks one when absent.
    #[serde(default)]
    pub session: Option<String>,
}

/// One session as the daemon reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    /// Session id (ULID text).
    pub session: String,
    /// UI pane id, if the app gave one.
    pub pane_id: Option<String>,
    /// Task id, if any.
    pub task_id: Option<String>,
    /// Launch folder.
    pub cwd: String,
    /// Width in cells.
    pub cols: u16,
    /// Height in cells.
    pub rows: u16,
    /// Root process id.
    pub pid: u32,
    /// The process exited (the session is kept until nobody watches it).
    pub exited: bool,
    /// A client is attached.
    pub attached: bool,
}

/// Client to daemon. `id` fields are chosen by the client and echoed in the reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// First frame: protocol version and the token from the token file.
    Hello {
        /// [`PROTOCOL_VERSION`] of the client.
        protocol: u32,
        /// Contents of the token file.
        token: String,
        /// Free text for logs, for example `tessera 0.1.0`.
        client: String,
    },
    /// Start a session and subscribe this connection to it.
    Spawn {
        /// Request id.
        id: u64,
        /// What to start.
        spec: SpawnRequest,
    },
    /// Subscribe to a running session: its scrollback is replayed first, then live output.
    Attach {
        /// Request id.
        id: u64,
        /// Session id text.
        session: String,
    },
    /// Stop receiving a session's output without ending it.
    Detach {
        /// Session id text.
        session: String,
    },
    /// Resize the terminal.
    Resize {
        /// Session id text.
        session: String,
        /// Columns.
        cols: u16,
        /// Rows.
        rows: u16,
        /// Width in pixels.
        px_width: u16,
        /// Height in pixels.
        px_height: u16,
    },
    /// Flow control: the client rendered this many output bytes.
    Ack {
        /// Session id text.
        session: String,
        /// Rendered bytes.
        bytes: usize,
    },
    /// End a session's process.
    Kill {
        /// Session id text.
        session: String,
    },
    /// List sessions.
    List {
        /// Request id.
        id: u64,
    },
    /// The session's scrollback ring; answered with a blob frame carrying this request id, or [`Reply::Failed`].
    Snapshot {
        /// Request id.
        id: u64,
        /// Session id text.
        session: String,
    },
    /// The client is going away: the daemon detaches it and closes the connection (sessions keep running).
    Bye,
    /// Quit the daemon; with `only_if_idle` only when no session runs (used after an app update).
    Shutdown {
        /// Request id.
        id: u64,
        /// Refuse while sessions run.
        only_if_idle: bool,
    },
}

/// Daemon to client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    /// Handshake accepted.
    Welcome {
        /// Daemon protocol version.
        protocol: u32,
        /// Daemon build version.
        version: String,
        /// Daemon process id.
        pid: u32,
    },
    /// Handshake refused; the connection closes.
    Refused {
        /// Why.
        reason: String,
    },
    /// A session started.
    Spawned {
        /// Request id.
        id: u64,
        /// Session id text.
        session: String,
    },
    /// Attached; the replay follows as output frames.
    Attached {
        /// Request id.
        id: u64,
        /// Session id text.
        session: String,
    },
    /// The session list.
    Sessions {
        /// Request id.
        id: u64,
        /// Sessions, oldest first.
        sessions: Vec<SessionInfo>,
    },
    /// A request without another answer succeeded.
    Done {
        /// Request id.
        id: u64,
    },
    /// A request failed.
    Failed {
        /// Request id.
        id: u64,
        /// Stable code, for example `pty.unknown_session`.
        code: String,
        /// Human sentence.
        message: String,
    },
    /// A subscribed session's process ended.
    Exited {
        /// Session id text.
        session: String,
        /// Exit code.
        code: u32,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let id = SessionId::new();
        let frames = [
            Frame::control(&Request::List { id: 7 }).unwrap(),
            Frame::Output(id, b"hello\x1b[0m".to_vec()),
            Frame::Input(id, Vec::new()),
            Frame::Blob(u64::MAX, b"ring".to_vec()),
        ];
        let mut wire = Vec::new();
        for frame in &frames {
            write_frame(&mut wire, frame).unwrap();
        }
        let mut reader = wire.as_slice();
        for frame in &frames {
            assert_eq!(read_frame(&mut reader).unwrap().as_ref(), Some(frame));
        }
        assert_eq!(read_frame(&mut reader).unwrap(), None);
    }

    #[test]
    fn corrupt_frames_are_rejected_not_trusted() {
        let mut too_long = (u32::try_from(MAX_FRAME).unwrap() + 1).to_le_bytes().to_vec();
        too_long.push(0);
        assert!(read_frame(&mut too_long.as_slice()).is_err());
        let unknown = [1u8, 0, 0, 0, 9];
        assert!(read_frame(&mut unknown.as_slice()).is_err());
        let short = [2u8, 0, 0, 0, 1, 0];
        assert!(read_frame(&mut short.as_slice()).is_err());
        let truncated = [10u8, 0, 0, 0, 0, b'{'];
        assert!(read_frame(&mut truncated.as_slice()).is_err());
    }

    #[test]
    fn requests_use_tagged_json() {
        let json = serde_json::to_string(&Request::Kill { session: "x".into() }).unwrap();
        assert_eq!(json, r#"{"type":"kill","session":"x"}"#);
    }
}
