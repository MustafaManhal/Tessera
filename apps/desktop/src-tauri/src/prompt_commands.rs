//! The prompt library and the prompt bar's history (FR-40, FR-43).
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tessera_store::prompts::{HISTORY_LIMIT, Prompt, PromptHistoryEntry};
use tessera_store::repositories::now_seconds;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptRecord {
    pub id: String,
    pub name: String,
    pub body: String,
    pub variables: String,
    pub tags: String,
    #[specta(type = specta_typescript::Number)]
    pub uses: i64,
    #[specta(type = specta_typescript::Number)]
    pub created_at: i64,
    #[specta(type = specta_typescript::Number)]
    pub updated_at: i64,
}

impl From<Prompt> for PromptRecord {
    fn from(value: Prompt) -> Self {
        Self {
            id: value.id,
            name: value.name,
            body: value.body,
            variables: value.variables,
            tags: value.tags,
            uses: value.uses,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptHistoryRecord {
    pub id: String,
    pub text: String,
    pub targets: String,
    #[specta(type = specta_typescript::Number)]
    pub at: i64,
}

impl From<PromptHistoryEntry> for PromptHistoryRecord {
    fn from(value: PromptHistoryEntry) -> Self {
        Self {
            id: value.id,
            text: value.text,
            targets: value.targets,
            at: value.at,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptInput {
    pub id: Option<String>,
    pub name: String,
    pub body: String,
    #[serde(default)]
    pub variables: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

fn store<'a>(state: &'a State<'a, AppState>) -> Result<std::sync::MutexGuard<'a, tessera_store::Store>, AppError> {
    state.store.lock().map_err(|_| AppError::lock_failed())
}

#[tauri::command]
#[specta::specta]
pub fn prompts_list(state: State<'_, AppState>, query: Option<String>) -> Result<Vec<PromptRecord>, AppError> {
    Ok(store(&state)?
        .prompts()
        .list(query.as_deref())?
        .into_iter()
        .map(Into::into)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn prompt_save(state: State<'_, AppState>, input: PromptInput) -> Result<PromptRecord, AppError> {
    let now = now_seconds();
    let existing = input
        .id
        .as_deref()
        .and_then(|id| store(&state).ok().and_then(|s| s.prompts().get(id).ok().flatten()));
    let prompt = Prompt {
        id: input.id.clone().unwrap_or_else(tessera_store::repositories::new_id),
        name: input.name,
        body: input.body,
        variables: serde_json::to_string(&input.variables).unwrap_or_else(|_| "[]".into()),
        tags: serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".into()),
        uses: existing.as_ref().map(|p| p.uses).unwrap_or(0),
        created_at: existing.map(|p| p.created_at).unwrap_or(now),
        updated_at: now,
    };
    store(&state)?.prompts().save(&prompt)?;
    Ok(prompt.into())
}

#[tauri::command]
#[specta::specta]
pub fn prompt_delete(state: State<'_, AppState>, id: String) -> Result<bool, AppError> {
    Ok(store(&state)?.prompts().delete(&id)?)
}

#[tauri::command]
#[specta::specta]
pub fn prompt_used(state: State<'_, AppState>, id: String) -> Result<u32, AppError> {
    Ok(store(&state)?.prompts().mark_used(&id, now_seconds())?.unwrap_or(0) as u32)
}

#[tauri::command]
#[specta::specta]
pub fn prompt_history_list(state: State<'_, AppState>, limit: u32) -> Result<Vec<PromptHistoryRecord>, AppError> {
    Ok(store(&state)?
        .prompts()
        .history_list(limit.min(HISTORY_LIMIT as u32) as usize)?
        .into_iter()
        .map(Into::into)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn prompt_history_add(
    state: State<'_, AppState>,
    text: String,
    targets: Vec<String>,
) -> Result<PromptHistoryRecord, AppError> {
    let targets = serde_json::to_string(&targets).unwrap_or_else(|_| "[]".into());
    Ok(store(&state)?
        .prompts()
        .history_add(&text, &targets, now_seconds())?
        .into())
}

/// Records an `agent_events` row (the prompt bar writes `prompt_sent` after delivering).
#[tauri::command]
#[specta::specta]
pub fn agent_event_append(
    state: State<'_, AppState>,
    session_id: String,
    kind: String,
    payload: String,
) -> Result<(), AppError> {
    store(&state)?
        .agent_sessions()
        .append_event(&session_id, &kind, &payload, now_seconds())?;
    Ok(())
}
