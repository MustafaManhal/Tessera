//! `tesserad`, the session daemon (TRD 4.10, M8): a background process that owns every terminal session, so shells
//! and agents keep running when the app quits or updates, and a restarted app re-attaches them with their scrollback.
//!
//! - [`protocol`]: the length-prefixed frame format and the JSON control messages;
//! - [`endpoint`]: the socket or named pipe for a data folder, and the token file that guards it;
//! - [`server`]: the daemon (used by the `tesserad` binary);
//! - [`client`]: the app's side, including starting the daemon on demand.

pub mod client;
pub mod endpoint;
pub mod protocol;
pub mod server;

pub use client::{Client, ClientError, connect_or_start, start_detached};
pub use endpoint::Endpoint;
pub use protocol::{PROTOCOL_VERSION, SessionInfo, SpawnRequest};
pub use server::{Options, StartError};
