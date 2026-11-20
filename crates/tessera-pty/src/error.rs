//! Errors returned by the PTY host.

use std::io;
use std::path::PathBuf;

use crate::SessionId;

/// Something went wrong while spawning or driving a terminal session.
///
/// Every variant has a stable [`code`](PtyError::code) string that the desktop
/// layer passes to the UI unchanged. The message is a short English sentence
/// for logs and error toasts; the UI owns the final wording.
#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    /// The requested working directory is missing, not a directory, or unreadable.
    ///
    /// portable-pty silently falls back to `$HOME` when a working directory does
    /// not exist, so the host checks first and refuses to start the program.
    #[error("the working directory {} does not exist or is not a directory", path.display())]
    CwdMissing {
        /// The directory the caller asked for.
        path: PathBuf,
    },

    /// The program is not an existing file and was not found on `PATH`.
    #[error("the program {program} was not found on PATH")]
    ProgramNotFound {
        /// The program name or path the caller asked for.
        program: String,
    },

    /// The operating system refused to create the pseudo terminal or start the program.
    #[error("could not start {program}: {message}")]
    SpawnFailed {
        /// The program that could not be started.
        program: String,
        /// The platform error, with the full chain when one is available.
        message: String,
    },

    /// The session id is unknown, for example after the host was restarted.
    #[error("unknown session {id}")]
    UnknownSession {
        /// The id that was not in the session table.
        id: SessionId,
    },

    /// Reading or writing the pseudo terminal failed.
    #[error("terminal I/O failed: {0}")]
    Io(#[from] io::Error),
}

impl PtyError {
    /// The stable machine-readable code used by the IPC layer.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::CwdMissing { .. } => "CwdMissing",
            Self::ProgramNotFound { .. } => "ProgramNotFound",
            Self::SpawnFailed { .. } => "SpawnFailed",
            Self::UnknownSession { .. } => "UnknownSession",
            Self::Io(_) => "Io",
        }
    }
}
