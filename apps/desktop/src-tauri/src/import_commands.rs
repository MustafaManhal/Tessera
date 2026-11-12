//! First-run onboarding and settings importers (M12.1, FR-66/FR-69, S-14). Detection and parsing live
//! in `tessera_store::importers`; applying goes through `write_config_patch` so `config.toml` stays the
//! source of truth. The `onboarding_done` kv flag gates the wizard.

use crate::error::AppError;
use crate::settings_commands::{Settings, emit as emit_config};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tessera_store::importers::{self, ImportResult};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ImportSource {
    /// ghostty | iterm2 | windowsterminal
    pub id: String,
    pub name: String,
    /// Absolute path of the detected config, when present.
    pub path: Option<String>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum ImportValue {
    Str(String),
    Num(f64),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ImportItem {
    pub key: String,
    pub value: ImportValue,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ImportMiss {
    pub item: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ImportPreview {
    pub applied: Vec<ImportItem>,
    pub failed: Vec<ImportMiss>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OnboardingState {
    pub done: bool,
}

fn sources() -> Vec<(String, String, Option<PathBuf>)> {
    vec![
        ("ghostty".into(), "Ghostty".into(), importers::ghostty_config_path()),
        ("iterm2".into(), "iTerm2".into(), importers::iterm2_plist_path()),
        (
            "windowsterminal".into(),
            "Windows Terminal".into(),
            importers::windows_terminal_settings_path(),
        ),
    ]
}

fn source(id: &str) -> Result<(String, PathBuf), AppError> {
    sources()
        .into_iter()
        .find(|(sid, _, path)| sid == id && path.is_some())
        .map(|(_, name, path)| (name, path.unwrap()))
        .ok_or_else(|| {
            AppError::new(
                "import.unavailable",
                format!("no {id} configuration found on this machine"),
            )
        })
}

fn parse_source(id: &str, path: &std::path::Path) -> Result<ImportResult, AppError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| AppError::new("import.read_failed", format!("could not read {}: {e}", path.display())))?;
    Ok(match id {
        "ghostty" => importers::parse_ghostty(&text),
        "iterm2" => importers::parse_iterm2(&text),
        _ => importers::parse_windows_terminal(&text),
    })
}

fn to_preview(result: ImportResult) -> ImportPreview {
    ImportPreview {
        applied: result
            .applied
            .into_iter()
            .map(|i| ImportItem {
                key: i.key,
                value: match i.value {
                    toml::Value::String(s) => ImportValue::Str(s),
                    toml::Value::Float(f) => ImportValue::Num(f),
                    toml::Value::Integer(n) => ImportValue::Num(n as f64),
                    other => ImportValue::Str(other.to_string()),
                },
                label: i.label,
            })
            .collect(),
        failed: result
            .failed
            .into_iter()
            .map(|f| ImportMiss {
                item: f.item,
                reason: f.reason,
            })
            .collect(),
    }
}

/// Dotted keys (`font.family`) become a nested TOML table for `write_config_patch`.
fn dotted_table(items: &[tessera_store::importers::ImportedItem]) -> toml::Table {
    let mut root = toml::Table::new();
    for item in items {
        let mut node = &mut root;
        let parts: Vec<&str> = item.key.split('.').collect();
        for part in &parts[..parts.len() - 1] {
            node = node
                .entry(part.to_string())
                .or_insert_with(|| toml::Value::Table(toml::Table::new()))
                .as_table_mut()
                .expect("dotted keys only create tables");
        }
        if let Some(last) = parts.last() {
            node.insert(last.to_string(), item.value.clone());
        }
    }
    root
}

/// Detected importer configs on this machine; `available` gates the onboarding buttons.
#[tauri::command]
#[specta::specta]
pub fn import_sources() -> Vec<ImportSource> {
    sources()
        .into_iter()
        .map(|(id, name, path)| ImportSource {
            available: path.is_some(),
            path: path.map(|p| p.to_string_lossy().into_owned()),
            id,
            name,
        })
        .collect()
}

/// Parses a detected config and returns what would be applied plus per-item misses. Reads only.
#[tauri::command]
#[specta::specta]
pub async fn import_preview(source_id: String) -> Result<ImportPreview, AppError> {
    let (name, path) = source(&source_id)?;
    let _ = name;
    tauri::async_runtime::spawn_blocking(move || parse_source(&source_id, &path).map(to_preview))
        .await
        .map_err(|e| AppError::new("import.failed", e.to_string()))?
}

/// Re-parses and applies the importable items through the normal config patch path.
#[tauri::command]
#[specta::specta]
pub async fn import_apply(
    source_id: String,
    settings: tauri::State<'_, Settings>,
    app: tauri::AppHandle,
) -> Result<ImportPreview, AppError> {
    let (_, path) = source(&source_id)?;
    let config_path = settings.path().to_path_buf();
    let shared = settings.state_arc();
    tauri::async_runtime::spawn_blocking(move || {
        let result = parse_source(&source_id, &path)?;
        let patch = dotted_table(&result.applied);
        if !patch.is_empty() {
            tessera_store::config_patch::write_config_patch(&config_path, &patch)?;
        }
        let mut state = shared
            .lock()
            .map_err(|_| AppError::new("config.lock_failed", "configuration lock poisoned"))?;
        state.reload_path(&config_path);
        emit_config(&app, &config_path, &state);
        Ok::<_, AppError>(to_preview(result))
    })
    .await
    .map_err(|e| AppError::new("import.failed", e.to_string()))?
}

/// Whether first-run onboarding already ran (`onboarding_done` kv flag).
#[tauri::command]
#[specta::specta]
pub fn onboarding_state(state: tauri::State<'_, AppState>) -> Result<OnboardingState, AppError> {
    let store = state
        .store
        .lock()
        .map_err(|_| AppError::new("store.lock_failed", "store lock poisoned"))?;
    Ok(OnboardingState {
        done: store
            .kv_get("onboarding_done")
            .map_err(|e| AppError::new("store.error", e.to_string()))?
            .is_some(),
    })
}

/// Marks onboarding finished (Skip and Finish land here).
#[tauri::command]
#[specta::specta]
pub fn onboarding_complete(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let store = state
        .store
        .lock()
        .map_err(|_| AppError::new("store.lock_failed", "store lock poisoned"))?;
    store
        .kv_set("onboarding_done", "1")
        .map_err(|e| AppError::new("store.error", e.to_string()))
}

/// Clears the flag so the wizard opens again (Settings → General → "Run setup again").
#[tauri::command]
#[specta::specta]
pub fn onboarding_reset(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let store = state
        .store
        .lock()
        .map_err(|_| AppError::new("store.lock_failed", "store lock poisoned"))?;
    store
        .kv_delete("onboarding_done")
        .map_err(|e| AppError::new("store.error", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotted_keys_build_nested_tables() {
        let items = vec![
            tessera_store::importers::ImportedItem {
                key: "font.family".into(),
                value: toml::Value::String("Mono".into()),
                label: String::new(),
            },
            tessera_store::importers::ImportedItem {
                key: "font.size".into(),
                value: toml::Value::Float(14.0),
                label: String::new(),
            },
        ];
        let table = dotted_table(&items);
        let font = table.get("font").and_then(|v| v.as_table()).expect("font table");
        assert_eq!(font.get("family").and_then(|v| v.as_str()), Some("Mono"));
        assert_eq!(font.get("size").and_then(|v| v.as_float()), Some(14.0));
    }
}
