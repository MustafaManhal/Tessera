//! PTY sessions for Tessera: spawn, read, write, resize, kill, output coalescing, credit-based flow control,
//! scrollback snapshots and a small event stream (TRD §4.1).
//!
//! The crate has no Tauri dependency, so the whole host is testable with real shells and can be reused by the
//! future background daemon (M8). The desktop crate owns the IPC commands and the `Channel<PtyEvent>`.

mod coalesce;
mod credit;
#[cfg(any(windows, test))]
mod cursor_query;
mod error;
mod host;
mod id;
mod login_env;
mod ring;
mod shell;

pub use coalesce::Coalescer;
pub use credit::CreditCounter;
pub use error::PtyError;
pub use host::{
    CREDIT_BYTES, EventSink, FLUSH_BYTES, FLUSH_INTERVAL, PipelineMetrics, PtyEvent, PtyHost, READ_BUFFER,
    RESIZE_DEBOUNCE, SCROLLBACK_BYTES, SessionDescription, SpawnObserver, SpawnSpec,
};
pub use id::SessionId;
pub use ring::ScrollbackRing;
pub use shell::{
    LOGIN_ENV_TIMEOUT, Platform, default_shell, default_shell_with, find_program, login_environment, merge_environment,
    parse_env_output, tessera_environment,
};

/// The crate version, exported as `TERM_PROGRAM_VERSION`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_a_non_empty_string() {
        assert!(!super::VERSION.is_empty());
    }
}
