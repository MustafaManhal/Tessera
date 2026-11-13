//! Tauri commands. Every command returns `Result<T, AppError>`.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};
use tessera_store::DataDirs;

use crate::error::AppError;
use crate::state::AppState;

/// What the About screen (and later the error report) needs to know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AppInfo {
    /// Product name, `Tessera`.
    pub name: String,
    /// Application version from `tauri.conf.json` / `Cargo.toml`.
    pub version: String,
    /// The data folder in use (`…/Tessera` or `…/Tessera Dev`).
    pub data_dir: String,
    /// The folder holding the rolling log files.
    pub log_dir: String,
    /// True for a debug build (the `Tessera Dev` data folder).
    pub dev_build: bool,
    /// The SQLite schema version (`PRAGMA user_version`).
    pub schema_version: u32,
}

/// Builds [`AppInfo`] from its parts. Pure, so it is tested without a window.
#[must_use]
pub fn app_info_for(dirs: &DataDirs, name: &str, version: &str, dev_build: bool, schema_version: u32) -> AppInfo {
    AppInfo {
        name: name.to_string(),
        version: version.to_string(),
        data_dir: dirs.root.to_string_lossy().into_owned(),
        log_dir: dirs.logs.to_string_lossy().into_owned(),
        dev_build,
        schema_version,
    }
}

/// Returns the application name, version, folders, build kind and schema version.
///
/// # Errors
///
/// Returns [`AppError`] when the shared store lock is poisoned or the schema
/// version cannot be read.
#[tauri::command]
#[specta::specta]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> Result<AppInfo, AppError> {
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let schema_version = store.schema_version()?;
    let package = app.package_info();
    Ok(app_info_for(
        &state.dirs,
        &package.name,
        &package.version.to_string(),
        cfg!(debug_assertions),
        schema_version,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_is_built_from_its_parts() {
        let dirs = DataDirs::from_root("/tmp/Tessera Dev");
        let info = app_info_for(&dirs, "Tessera", "0.1.0", true, 1);
        assert_eq!(info.name, "Tessera");
        assert_eq!(info.version, "0.1.0");
        // Compare as paths: Windows joins with a backslash.
        let root = std::path::Path::new("/tmp/Tessera Dev");
        assert_eq!(std::path::Path::new(&info.data_dir), root);
        assert_eq!(std::path::Path::new(&info.log_dir), root.join("logs"));
        assert!(info.dev_build);
        assert_eq!(info.schema_version, 1);
    }

    #[test]
    fn release_info_has_no_dev_flag() {
        let dirs = DataDirs::from_root("/tmp/Tessera");
        let info = app_info_for(&dirs, "Tessera", "1.2.3", false, 4);
        assert!(!info.dev_build);
        assert_eq!(info.schema_version, 4);
    }
}
