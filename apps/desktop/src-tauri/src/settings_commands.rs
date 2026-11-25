//! Typed settings commands and events. Disk work runs on the blocking pool.
//! Schema logical events `config.changed` / `config.error` use `:` on the wire:
//! Tauri rejects dots in event names.

use crate::{
    error::AppError,
    settings_types::{Config, SettingsPatch},
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri_specta::Event;
use tessera_store::{ConfigState, ConfigWatcher, config::ConfigDiagnostic};

/// Effective configuration changed, or recovered after an invalid edit.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(transparent)]
#[tauri_specta(event_name = "config:changed")]
pub struct ConfigChanged(pub Config);

/// Invalid configuration or a nonfatal unknown-key diagnostic.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "config:error")]
pub struct ConfigErrorEvent {
    /// Config file path.
    pub path: String,
    /// One-based source line, if known.
    pub line: Option<u32>,
    /// Dotted setting name, if known.
    pub key: Option<String>,
    /// Stable diagnostic code; config.unknown_key is nonfatal.
    pub code: String,
    /// Explanation suitable for display.
    pub message: String,
    /// Suggested spelling for unknown keys, when close enough.
    pub suggestion: Option<String>,
}

impl ConfigErrorEvent {
    fn new(path: &Path, error: &ConfigDiagnostic) -> Self {
        Self {
            path: path.to_string_lossy().into_owned(),
            line: error.line.map(|line| u32::try_from(line).unwrap_or(u32::MAX)),
            key: error.key.clone(),
            code: error.code.clone(),
            message: error.message.clone(),
            suggestion: error.suggestion.clone(),
        }
    }
}

/// Settings state shared by commands and the watcher.
pub struct Settings {
    path: PathBuf,
    state: Arc<Mutex<ConfigState>>,
    // Kept outside the state lock so dropping the watcher can always join its thread.
    _watcher: ConfigWatcher,
}

impl Settings {
    /// Loads settings and registers the live reload watcher for the app lifetime.
    pub fn start(path: &Path, app: tauri::AppHandle) -> Result<Self, tessera_store::ConfigError> {
        let mut initial = ConfigState::default();
        initial.reload_path(path);
        if let Some(error) = &initial.last_error {
            tracing::warn!(key = ?error.key, line = ?error.line, message = %error.message, "invalid config; using defaults");
        }
        let state = Arc::new(Mutex::new(initial));
        let event_path = path.to_path_buf();
        let watcher = ConfigWatcher::start(path, Arc::clone(&state), move |state| emit(&app, &event_path, state))?;
        Ok(Self {
            path: path.into(),
            state,
            _watcher: watcher,
        })
    }
}

impl Settings {
    /// The `config.toml` path (sync reads and writes the file; the watcher applies a synced change).
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Shared config state for command-side reloads (import apply).
    pub(crate) fn state_arc(&self) -> Arc<Mutex<ConfigState>> {
        Arc::clone(&self.state)
    }

    /// Saved blur and opacity preferences for native window creation.
    pub fn window_appearance(&self) -> (bool, f64) {
        self.state.lock().map_or_else(
            |_| {
                let appearance = tessera_store::Config::default().appearance;
                (appearance.background_blur, appearance.window_opacity)
            },
            |state| {
                (
                    state.current.appearance.background_blur,
                    state.current.appearance.window_opacity,
                )
            },
        )
    }

    /// The `[quick-terminal]` section (defaults when the lock is poisoned).
    pub fn quick_terminal(&self) -> crate::quick_terminal::Options {
        let read = |q: &tessera_store::QuickTerminalConfig| crate::quick_terminal::Options {
            enabled: q.enabled,
            hotkey: q.hotkey.clone(),
            height: q.height,
            hide_on_blur: q.hide_on_blur,
        };
        self.state.lock().map_or_else(
            |_| read(&tessera_store::Config::default().quick_terminal),
            |state| read(&state.current.quick_terminal),
        )
    }

    /// Whether shells and agents outlive the app (`terminal.keep-sessions-running`). Off is the default and the
    /// answer for a poisoned lock.
    pub fn keep_sessions_running(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.current.terminal.keep_sessions_running)
    }

    /// Whether shell integration is on (`terminal.shell-integration`). A poisoned lock counts as on, the default.
    pub fn shell_integration(&self) -> bool {
        self.state
            .lock()
            .map_or(true, |state| state.current.terminal.shell_integration)
    }
}

impl From<tessera_store::ConfigError> for AppError {
    fn from(error: tessera_store::ConfigError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

fn to_ipc(config: &tessera_store::Config) -> Result<Config, AppError> {
    serde_json::to_value(config)
        .and_then(serde_json::from_value)
        .map_err(|error| AppError::new("config.serialize_failed", error.to_string()))
}

pub(crate) fn emit(app: &tauri::AppHandle, path: &Path, state: &ConfigState) {
    if let Some(error) = &state.last_error {
        tracing::warn!(line = ?error.line, key = ?error.key, code = %error.code, "configuration reload rejected; keeping last good settings");
        if let Err(error) = ConfigErrorEvent::new(path, error).emit(app) {
            tracing::warn!(%error, "could not emit config:error");
        }
        return;
    }
    tracing::info!("configuration reloaded; emitting config:changed");
    match to_ipc(&state.current) {
        Ok(config) => {
            if let Err(error) = ConfigChanged(config).emit(app) {
                tracing::warn!(%error, "could not emit config:changed");
            }
        }
        Err(error) => tracing::error!(message = %error.message, "could not serialize config:changed"),
    }
    for warning in &state.warnings {
        if let Err(error) = ConfigErrorEvent::new(path, warning).emit(app) {
            tracing::warn!(%error, "could not emit config warning");
        }
    }
}

/// Returns the last valid settings, even while a hand edit is invalid.
#[tauri::command]
#[specta::specta]
pub fn settings_get(settings: tauri::State<'_, Settings>) -> Result<Config, AppError> {
    let state = settings
        .state
        .lock()
        .map_err(|_| AppError::new("config.lock_failed", "configuration lock poisoned"))?;
    to_ipc(&state.current)
}

/// Validates and writes only changed settings, preserving surrounding source formatting.
#[tauri::command]
#[specta::specta]
pub async fn settings_set(
    patch: SettingsPatch,
    settings: tauri::State<'_, Settings>,
    app: tauri::AppHandle,
) -> Result<Config, AppError> {
    let path = settings.path.clone();
    let shared = Arc::clone(&settings.state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = shared
            .lock()
            .map_err(|_| AppError::new("config.lock_failed", "configuration lock poisoned"))?;
        let previous = state.clone();
        tessera_store::config_patch::write_settings_patch(&path, &patch)?;
        state.reload_path(&path);
        if *state != previous {
            emit(&app, &path, &state);
        }
        to_ipc(&state.current)
    })
    .await
    .map_err(|error| AppError::new("config.write_failed", error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_defaults_match_store_and_all_fields_survive() {
        let store = tessera_store::Config::default();
        let ipc = to_ipc(&store).expect("typed config");
        assert_eq!(serde_json::to_value(store).unwrap(), serde_json::to_value(ipc).unwrap());
        assert_eq!(ConfigChanged::NAME, "config:changed");
        assert_eq!(ConfigErrorEvent::NAME, "config:error");
    }

    #[test]
    fn typed_patch_is_partial_rejects_unknown_and_writes_through_store() {
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"font":{"size":16},"terminal":{"shell-integration":false}}"#).unwrap();
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            serde_json::json!({"font":{"size":16.0},"terminal":{"shell-integration":false}})
        );
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"font":{"szie":16}}"#).is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let config = tessera_store::config_patch::write_settings_patch(&path, &patch).unwrap();
        assert_eq!(config.font.size, 16.0);
        assert!(!config.terminal.shell_integration);
        let ipc = to_ipc(&config).unwrap();
        assert_eq!(ipc.font.size, 16.0);
    }

    #[test]
    fn diagnostic_payload_includes_path_line_key_and_suggestion() {
        let parsed = tessera_store::config::parse_config_with_warnings("[font]\nszie=17\n").unwrap();
        let error = ConfigErrorEvent::new(Path::new("config.toml"), &parsed.warnings[0]);
        let json = serde_json::to_value(error).unwrap();
        assert_eq!(json["line"], 2);
        assert_eq!(json["key"], "font.szie");
        assert_eq!(json["suggestion"], "font.size");
        assert_eq!(json["code"], "config.unknown_key");
        assert_eq!(
            AppError::from(tessera_store::ConfigError::Syntax {
                key: None,
                line: 2,
                message: "broken".into()
            })
            .code,
            "config.syntax"
        );
    }
}
