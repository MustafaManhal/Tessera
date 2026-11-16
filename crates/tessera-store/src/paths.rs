//! Where Tessera keeps its local data (schema §2).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The data folder name for release and dev builds.
///
/// Release builds use `Tessera`; debug builds use `Tessera Dev` so a worker
/// never reads or writes the user's real sessions.
pub const fn data_dir_name(dev: bool) -> &'static str {
    if dev { "Tessera Dev" } else { "Tessera" }
}

/// The paths of the files Tessera owns inside its data folder.
///
/// Built from one root (the caller decides which root: the platform data dir
/// joined with [`data_dir_name`]). Pure: constructing it touches no files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirs {
    /// The data folder itself (`…/Tessera` or `…/Tessera Dev`).
    pub root: PathBuf,
    /// `tessera.db` (plus SQLite's `-wal` and `-shm` files).
    pub db: PathBuf,
    /// `config.toml`, hand-editable by the user.
    pub config: PathBuf,
    /// `logs/`, where the rolling daily log files go.
    pub logs: PathBuf,
}

impl DataDirs {
    /// Builds the four paths for a root folder. Does not create anything.
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            db: root.join("tessera.db"),
            config: root.join("config.toml"),
            logs: root.join("logs"),
            root,
        }
    }

    /// Creates the data folder and the logs folder, leaving existing files alone.
    ///
    /// # Errors
    ///
    /// Returns the underlying [`io::Error`] when a folder cannot be created.
    pub fn create(&self) -> io::Result<()> {
        fs::create_dir_all(&self.root)?;
        fs::create_dir_all(&self.logs)?;
        Ok(())
    }

    /// The config file's parent folder (the data root), for callers that need it.
    pub fn config_dir(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_stable() {
        assert_eq!(data_dir_name(false), "Tessera");
        assert_eq!(data_dir_name(true), "Tessera Dev");
    }

    #[test]
    fn paths_are_built_from_the_root() {
        let dirs = DataDirs::from_root("/tmp/Tessera Test");
        assert_eq!(dirs.root, PathBuf::from("/tmp/Tessera Test"));
        assert_eq!(dirs.db, PathBuf::from("/tmp/Tessera Test/tessera.db"));
        assert_eq!(dirs.config, PathBuf::from("/tmp/Tessera Test/config.toml"));
        assert_eq!(dirs.logs, PathBuf::from("/tmp/Tessera Test/logs"));
    }

    #[test]
    fn create_makes_both_folders_once() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dirs = DataDirs::from_root(temp.path().join("Tessera Dev"));
        dirs.create().expect("first create");
        dirs.create().expect("second create is a no-op");
        assert!(dirs.root.is_dir());
        assert!(dirs.logs.is_dir());
        assert!(!dirs.config.exists(), "create must not write config.toml");
    }
}
