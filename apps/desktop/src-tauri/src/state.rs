//! The state shared by every Tauri command.

use std::sync::{Arc, Mutex};
use tessera_pty::PtyHost;
use tessera_store::{DataDirs, Store};

/// The database and the folders it lives in.
///
/// `Store` wraps one SQLite connection, which is `Send` but not `Sync`. A
/// standard `Mutex` serialises the short, synchronous commands that use it and
/// gives us one place to turn a poisoned lock into a typed `AppError`. A Tokio
/// mutex would be wrong here: commands do not await while holding the guard,
/// and SQLite calls block.
pub struct AppState {
    /// The open database, behind the mutex described above.
    pub store: Mutex<Store>,
    /// The resolved data, config and log folders.
    pub dirs: DataDirs,
    /// The in-process PTY host: the login environment and the fallback when no session daemon runs. Session calls
    /// go through [`AppState::sessions`].
    pub pty: PtyHost,
    /// Where sessions live: the session daemon when it runs, else `pty` (M8).
    pub sessions: Arc<crate::sessions::Sessions>,
}
