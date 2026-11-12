//! The S-16 inbox commands: list, mark read, clear, and the record path the front end uses for attention events.
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tessera_store::notifications::Notification;
use tessera_store::repositories::now_seconds;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub id: String,
    pub source: String,
    pub task_id: Option<String>,
    pub pane_session_id: Option<String>,
    pub title: String,
    pub body: String,
    pub is_read: bool,
    #[specta(type = specta_typescript::Number)]
    pub at: i64,
}

impl From<Notification> for NotificationRecord {
    fn from(value: Notification) -> Self {
        Self {
            id: value.id,
            source: value.source,
            task_id: value.task_id,
            pane_session_id: value.pane_session_id,
            title: value.title,
            body: value.body,
            is_read: value.is_read,
            at: value.at,
        }
    }
}

fn store<'a>(state: &'a State<'a, AppState>) -> Result<std::sync::MutexGuard<'a, tessera_store::Store>, AppError> {
    state.store.lock().map_err(|_| AppError::lock_failed())
}

/// Newest first (unread ahead at equal times is handled by `is_read` ordering in the repo).
#[tauri::command]
#[specta::specta]
pub fn notifications_list(state: State<'_, AppState>, limit: u32) -> Result<Vec<NotificationRecord>, AppError> {
    Ok(store(&state)?
        .notifications()
        .list(limit.min(500) as usize)?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// `ids` marks those rows read; `null` marks everything.
#[tauri::command]
#[specta::specta]
pub fn notifications_mark_read(state: State<'_, AppState>, ids: Option<Vec<String>>) -> Result<u32, AppError> {
    Ok(store(&state)?.notifications().mark_read(ids.as_deref())? as u32)
}

#[tauri::command]
#[specta::specta]
pub fn notifications_clear(state: State<'_, AppState>) -> Result<u32, AppError> {
    Ok(store(&state)?.notifications().clear()? as u32)
}

/// What the front end sends when an attention event fires (agent needs input, a command finished, ...).
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordNotification {
    pub source: String,
    pub task_id: Option<String>,
    pub pane_session_id: Option<String>,
    pub title: String,
    pub body: String,
}

#[tauri::command]
#[specta::specta]
pub fn notifications_record(
    state: State<'_, AppState>,
    record: RecordNotification,
) -> Result<NotificationRecord, AppError> {
    let row = store(&state)?.notifications().record(
        &record.source,
        record.task_id.as_deref(),
        record.pane_session_id.as_deref(),
        &record.title,
        &record.body,
        now_seconds(),
    )?;
    Ok(row.into())
}
