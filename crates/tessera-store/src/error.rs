//! Errors for the store and the config loader.

use std::io;
use std::path::PathBuf;

/// Something went wrong while opening or using the local SQLite database.
///
/// Callers at the app edge map these to the stable IPC codes documented on the
/// desktop `AppError` (for example `store.open_failed`).
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// Restore input exceeded a storage limit.
    #[error("restore data exceeds the size limit")]
    RestoreTooLarge,
    /// Layout or geometry is not valid JSON.
    #[error("restore data is not valid JSON")]
    RestoreInvalidJson,
    /// Compressed terminal history could not be encoded or decoded.
    #[error("scrollback compression failed: {0}")]
    Scrollback(#[source] io::Error),
    /// A data or log folder could not be created.
    #[error("could not create the data folder {path}: {source}")]
    CreateDir {
        /// The folder that could not be created.
        path: PathBuf,
        /// The underlying filesystem error.
        #[source]
        source: io::Error,
    },

    /// SQLite refused to open the database file (missing permissions, a full disk…).
    #[error("could not open the database {path}: {source}")]
    Open {
        /// The database file.
        path: PathBuf,
        /// The underlying SQLite error.
        #[source]
        source: rusqlite::Error,
    },

    /// A SQL statement or pragma failed.
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    /// An embedded migration failed (bad SQL, a version newer than this build…).
    #[error("database migration failed: {0}")]
    Migration(#[from] rusqlite_migration::Error),

    /// The backup copy of the database could not be written.
    #[error("could not back up the database to {path}: {source}")]
    Backup {
        /// The intended backup file.
        path: PathBuf,
        /// The underlying SQLite error.
        #[source]
        source: rusqlite::Error,
    },

    /// The backup folder could not be read or an old backup could not be removed.
    #[error("could not tidy the database backups: {0}")]
    BackupFiles(#[source] io::Error),
}

/// Why `config.toml` could not be loaded.
///
/// An invalid file never stops the app from starting: the desktop setup keeps
/// the error, logs it, and uses [`Config::default`](crate::Config) instead.
/// Every variant carries the 1-based line where the problem was found, and a
/// key when one could be identified.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// A settings write or watch operation failed.
    #[error("configuration I/O failed for {path}: {source}")]
    Write {
        /// Affected path.
        path: PathBuf,
        /// Filesystem error.
        #[source]
        source: io::Error,
    },
    /// The filesystem watcher could not start or reported a failure.
    #[error("configuration watcher failed: {0}")]
    Watch(#[from] notify::Error),
    /// A lossless update is not supported for this document shape.
    #[error("cannot patch `{key}` at line {line}: {message}")]
    Patch {
        /// Setting being updated.
        key: String,
        /// One-based source line.
        line: usize,
        /// Reason no file was changed.
        message: String,
    },
    /// The file exists but cannot be read.
    #[error("could not read {path}: {source}")]
    Read {
        /// The config file.
        path: PathBuf,
        /// The underlying filesystem error.
        #[source]
        source: io::Error,
    },

    /// The TOML itself is malformed.
    #[error("config.toml is not valid TOML at line {line}: {message}")]
    Syntax {
        /// Setting being parsed, when identifiable.
        key: Option<String>,
        /// 1-based line of the parse error.
        line: usize,
        /// The parser's one-line explanation.
        message: String,
    },

    /// A known key has the wrong type or an unsupported value.
    #[error("invalid value for `{key}` at line {line}: {message}")]
    Invalid {
        /// The dotted key, for example `terminal.font_size`.
        key: String,
        /// 1-based line where the key was written.
        line: usize,
        /// What was expected.
        message: String,
    },
}

impl ConfigError {
    /// Stable machine-readable error code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Read { .. } => "config.read_failed",
            Self::Write { .. } => "config.write_failed",
            Self::Watch(_) => "config.watch_failed",
            Self::Syntax { .. } => "config.syntax",
            Self::Invalid { .. } => "config.invalid",
            Self::Patch { .. } => "config.patch_unsupported",
        }
    }

    /// The 1-based line the error points at.
    pub fn line(&self) -> Option<usize> {
        match self {
            Self::Syntax { line, .. } | Self::Invalid { line, .. } | Self::Patch { line, .. } => Some(*line),
            Self::Read { .. } | Self::Write { .. } | Self::Watch(_) => None,
        }
    }

    /// The key the error points at, when it has one.
    pub fn key(&self) -> Option<&str> {
        match self {
            Self::Invalid { key, .. } | Self::Patch { key, .. } => Some(key),
            Self::Syntax { key, .. } => key.as_deref(),
            Self::Read { .. } | Self::Write { .. } | Self::Watch(_) => None,
        }
    }
}

impl StoreError {
    /// Stable IPC code; never includes stored contents.
    pub fn code(&self) -> &'static str {
        match self {
            Self::CreateDir { .. } | Self::Open { .. } => "store.open_failed",
            Self::Database(_) => "store.query_failed",
            Self::Migration(_) => "store.migrate_failed",
            Self::Backup { .. } | Self::BackupFiles(_) => "store.backup_failed",
            Self::RestoreTooLarge => "restore.too_large",
            Self::RestoreInvalidJson => "restore.invalid_json",
            Self::Scrollback(_) => "restore.compression_failed",
        }
    }
}
