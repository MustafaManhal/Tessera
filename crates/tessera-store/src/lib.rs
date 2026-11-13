//! SQLite store, migrations, config.toml, keychain (TRD 5).
//!
//! M0.4 adds the local data layout (paths), the SQLite database with embedded
//! migrations and pre-migration backups, and the `config.toml` loader with a
//! JSON Schema export. The desktop crate owns where the data folder lives and
//! writes the schema file; this crate stays free of any Tauri dependency.

pub mod config;
mod config_document;
pub mod config_model;
pub mod config_patch;
pub mod config_watch;
pub mod db;
pub mod error;
pub mod paths;

pub use config::{
    AppearanceConfig, Config, QuickTerminalConfig, TerminalConfig, Theme, UpdateChannel, UpdatesConfig,
    config_json_schema, load_config,
};
pub use config_watch::{ConfigState, ConfigWatcher};
pub use db::Store;
pub use error::{ConfigError, StoreError};
pub use paths::{DataDirs, data_dir_name};

/// The crate version, read from `CARGO_PKG_VERSION`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_a_non_empty_string() {
        assert!(!VERSION.is_empty());
    }
}

pub mod repositories;

pub mod projects;

pub mod tasks;

pub mod task_ports;

/// Durable window layouts and compressed terminal history.
pub mod restore;

/// Agent catalog persistence.
pub mod agents;

/// Agent session lifecycle and timeline persistence.
pub mod agent_sessions;

/// The user's `~/.ssh/config`, read only.
pub mod ssh_config;

/// SSH hosts added by hand and stored host settings.
pub mod ssh_hosts;

pub mod integrations;
/// The notifications inbox (S-16).
pub mod notifications;
pub mod prompts;

pub mod automations;
pub mod importers;
pub mod redact;
pub mod review_comments;

pub mod mcp;
