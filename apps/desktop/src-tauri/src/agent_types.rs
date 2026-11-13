//! Stable M6.1 IPC types shared with the catalog UI.
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub install_url: String,
    pub docs_url: String,
    pub prompt_mode: String,
    pub supports_resume: bool,
    pub hooks: String,
    pub hooks_state: String,
    pub has_skip_permissions: bool,
    pub source: String,
    pub definition_error: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub detected_at: Option<i64>,
}
/// Environment values are plain text, not encrypted credential storage. No secrets.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentProfile {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub model: Option<String>,
    pub extra_args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub skip_permissions: bool,
    pub is_default: bool,
    #[specta(type = specta_typescript::Number)]
    pub created_at: i64,
    #[specta(type = specta_typescript::Number)]
    pub updated_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentProfileInput {
    pub id: Option<String>,
    pub agent_id: String,
    pub name: String,
    pub model: Option<String>,
    pub extra_args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub skip_permissions: bool,
    pub is_default: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CommandPreview {
    pub program: String,
    pub args: Vec<String>,
    pub env_keys: Vec<String>,
    pub prompt_mode: String,
    pub skip_permissions: bool,
}
impl TryFrom<tessera_store::agents::AgentProfile> for AgentProfile {
    type Error = AppError;
    fn try_from(p: tessera_store::agents::AgentProfile) -> Result<Self, Self::Error> {
        Ok(Self {
            id: p.id,
            agent_id: p.agent_id,
            name: p.name,
            model: p.model,
            extra_args: serde_json::from_str(&p.extra_args).map_err(invalid_json)?,
            env: serde_json::from_str(&p.env).map_err(invalid_json)?,
            skip_permissions: p.skip_permissions,
            is_default: p.is_default,
            created_at: p.created_at,
            updated_at: p.updated_at,
        })
    }
}
fn invalid_json(e: serde_json::Error) -> AppError {
    AppError::new(
        "agent.profile_invalid",
        format!("The stored profile has invalid JSON: {e}."),
    )
}
impl AgentProfile {
    pub fn launch_profile(&self) -> tessera_agents::LaunchProfile {
        tessera_agents::LaunchProfile {
            model: self.model.clone(),
            extra_args: self.extra_args.clone(),
            env: self.env.clone(),
            skip_permissions: self.skip_permissions,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentStartInput {
    pub task_id: Option<String>,
    pub profile_id: String,
    pub prompt: Option<String>,
    pub cwd: Option<String>,
}
/// Frontend-owned PTY spawn and prompt delivery plan. Environment contains plain options, not secrets.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentLaunch {
    pub agent_session_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub icon: String,
    pub profile_id: String,
    pub profile_name: String,
    pub task_id: Option<String>,
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub stdin: Option<String>,
    pub type_after_ready: Option<String>,
    pub ready_pattern: Option<String>,
    pub skip_permissions: bool,
}
/// SQLite constrains session status to these values; expose the same union in TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionStatus {
    Starting,
    Working,
    NeedsInput,
    Idle,
    Error,
    Exited,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AgentSession {
    pub id: String,
    pub task_id: Option<String>,
    /// Empty until the frontend attaches the spawned PTY.
    pub pane_session_id: String,
    pub pane_id: Option<String>,
    pub agent_id: String,
    pub profile_id: String,
    #[specta(type = AgentSessionStatus)]
    pub status: String,
    pub status_source: String,
    #[specta(type = specta_typescript::Number)]
    pub status_at: i64,
    /// The latest hook message, OSC text or matched screen line behind the status.
    pub status_message: Option<String>,
    pub exit_code: Option<i32>,
    pub prompt: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub started_at: i64,
    #[specta(type = Option<specta_typescript::Number>)]
    pub ended_at: Option<i64>,
    pub external_session_id: Option<String>,
}
impl From<tessera_store::agent_sessions::AgentSession> for AgentSession {
    fn from(row: tessera_store::agent_sessions::AgentSession) -> Self {
        Self {
            id: row.id,
            task_id: row.task_id,
            pane_session_id: row.pane_session_id,
            pane_id: row.pane_id,
            agent_id: row.agent_id,
            profile_id: row.profile_id,
            status: row.status,
            status_source: row.status_source,
            status_at: row.status_at,
            status_message: row.status_message,
            exit_code: row.exit_code,
            prompt: row.prompt,
            started_at: row.started_at,
            ended_at: row.ended_at,
            external_session_id: row.external_session_id,
        }
    }
}
