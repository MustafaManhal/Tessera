//! The one error shape every Tauri command returns (TRD §10).
//!
//! The UI receives `{ code, message }`: `code` is a stable string it can branch
//! on, `message` is the human sentence it shows in a toast. Codes are never
//! translated and never change once shipped.

use serde::{Deserialize, Serialize};
use specta::Type;
use tessera_store::StoreError;

/// A command failure with a stable code and a human message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AppError {
    /// Stable machine-readable code, for example `store.open_failed`.
    pub code: String,
    /// Human-readable sentence, safe to show in a toast.
    pub message: String,
    /// Whether a non-repository folder can be initialized.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_init: Option<bool>,
    /// Commits that would be lost on deletion.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list: Option<Vec<String>>,
    /// Task retained in an error state, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Whether dirty files require deletion confirmation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
}

impl AppError {
    /// Builds an error from a code and a message.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            can_init: None,
            list: None,
            task_id: None,
            dirty: None,
        }
    }

    /// The store lock was poisoned by a panic while another command held it.
    pub fn lock_failed() -> Self {
        Self::new(
            "store.lock_failed",
            "The database is unavailable because a previous operation failed.",
        )
    }
}

impl From<StoreError> for AppError {
    fn from(error: StoreError) -> Self {
        let code = error.code();
        Self::new(code, error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_errors_map_to_stable_codes() {
        let error = AppError::from(StoreError::CreateDir {
            path: "/nope/Tessera Dev".into(),
            source: std::io::Error::other("permission denied"),
        });
        assert_eq!(error.code, "store.open_failed");
        assert!(error.message.contains("/nope/Tessera Dev"));

        let error = AppError::from(StoreError::BackupFiles(std::io::Error::other("disk full")));
        assert_eq!(error.code, "store.backup_failed");
        assert!(error.message.contains("disk full"));
    }

    #[test]
    fn errors_serialise_as_code_and_message() {
        let error = AppError::new("store.open_failed", "Could not open the database.");
        let json = serde_json::to_value(&error).expect("serialise");
        assert_eq!(json["code"], "store.open_failed");
        assert_eq!(json["message"], "Could not open the database.");
    }
}
