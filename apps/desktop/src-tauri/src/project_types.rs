//! Typed project and task wire models. Timestamps use Unix seconds (Task 09).
use serde::{Deserialize, Serialize};
use specta::Type;

/// Allowed file transfer operations.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CopyMode {
    /// Copy file contents.
    Copy,
    /// Link the source, falling back to copy when Windows denies symlinks.
    Symlink,
}
/// Setup approval status, matching the UI contract.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SetupStatus {
    /// No script configured.
    None,
    /// Exact script and shell approved.
    Approved,
    /// Approval is required.
    NeedsApproval,
}
impl From<tessera_store::projects::SetupState> for SetupStatus {
    fn from(state: tessera_store::projects::SetupState) -> Self {
        match state {
            tessera_store::projects::SetupState::None => Self::None,
            tessera_store::projects::SetupState::Approved => Self::Approved,
            tessera_store::projects::SetupState::NeedsApproval => Self::NeedsApproval,
        }
    }
}
/// Persisted task lifecycle state.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    /// Waiting to be prepared.
    Backlog,
    /// Worktree/setup preparation.
    SettingUp,
    /// Ready for work.
    Active,
    /// Retained but inactive.
    Archived,
    /// Worktree/branch deletion completed.
    Deleted,
    /// Preparation failed; inspect last_message.
    Error,
}

/// Wire model for CopyFile.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CopyFile {
    /// Path.
    pub path: String,
    /// Mode.
    pub mode: CopyMode,
}

/// Wire model for Project.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Project {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Path.
    pub path: String,
    /// Remote url.
    pub remote_url: Option<String>,
    /// Default branch.
    pub default_branch: String,
    /// Worktree dir.
    pub worktree_dir: Option<String>,
    /// Setup script.
    pub setup_script: Option<String>,
    /// Setup shell.
    pub setup_shell: Option<String>,
    /// Setup approved hash.
    pub setup_approved_hash: Option<String>,
    /// Setup state.
    pub setup_state: SetupStatus,
    /// Copy files.
    pub copy_files: Vec<CopyFile>,
    /// Port base.
    pub port_base: Option<u16>,
    /// Default profile id.
    pub default_profile_id: Option<String>,
    /// Is muted.
    pub is_muted: bool,
    /// Sort.
    pub sort: i32,
    /// Created at.
    pub created_at: f64,
    /// Updated at.
    pub updated_at: f64,
}

/// Wire model for ProjectInput.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProjectInput {
    /// Path.
    pub path: Option<String>,
    /// Clone url.
    pub clone_url: Option<String>,
    /// Clone dir.
    pub clone_dir: Option<String>,
    /// Name.
    pub name: Option<String>,
}

/// Wire model for ProjectPatch.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProjectPatch {
    /// Name.
    pub name: Option<String>,
    /// Default branch.
    pub default_branch: Option<String>,
    /// Worktree dir.
    #[serde(default, deserialize_with = "nullable_patch")]
    #[specta(type = Option<Option<String>>)]
    pub worktree_dir: Option<Option<String>>,
    /// Setup script.
    #[serde(default, deserialize_with = "nullable_patch")]
    #[specta(type = Option<Option<String>>)]
    pub setup_script: Option<Option<String>>,
    /// Setup shell.
    #[serde(default, deserialize_with = "nullable_patch")]
    #[specta(type = Option<Option<String>>)]
    pub setup_shell: Option<Option<String>>,
    /// Copy files.
    pub copy_files: Option<Vec<CopyFile>>,
    /// Port base.
    #[serde(default, deserialize_with = "nullable_patch")]
    #[specta(type = Option<Option<u16>>)]
    pub port_base: Option<Option<u16>>,
    /// Is muted.
    pub is_muted: Option<bool>,
    /// Sort.
    pub sort: Option<i32>,
}

/// Wire model for ProjectRemoval.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProjectRemoval {
    /// Tasks with worktrees.
    pub tasks_with_worktrees: u32,
}

/// Wire model for RunScript.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RunScript {
    /// Id.
    pub id: String,
    /// Project id.
    pub project_id: String,
    /// Name.
    pub name: String,
    /// Command.
    pub command: String,
    /// Auto start.
    pub auto_start: bool,
    /// Sort.
    pub sort: i32,
}

/// Wire model for RunScriptInput.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RunScriptInput {
    /// Name.
    pub name: String,
    /// Command.
    pub command: String,
    /// Auto start.
    pub auto_start: bool,
    /// Sort.
    pub sort: Option<i32>,
}

/// Wire model for RunScriptPatch.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RunScriptPatch {
    /// Name.
    pub name: Option<String>,
    /// Command.
    pub command: Option<String>,
    /// Auto start.
    pub auto_start: Option<bool>,
    /// Sort.
    pub sort: Option<i32>,
}

/// Wire model for AgentRequest.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentRequest {
    /// Profile id.
    pub profile_id: String,
}

/// Wire model for TaskCreateInput.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TaskCreateInput {
    /// Project id.
    pub project_id: String,
    /// Name.
    pub name: Option<String>,
    /// Prompt.
    pub prompt: Option<String>,
    /// Base branch.
    pub base_branch: String,
    /// Agents.
    pub agents: Vec<AgentRequest>,
    /// Use main checkout.
    pub use_main_checkout: bool,
    /// Run setup.
    pub run_setup: bool,
}

/// Wire model for SetupInfo.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SetupInfo {
    /// State.
    pub state: SetupStatus,
    /// Script.
    pub script: Option<String>,
    /// Shell.
    pub shell: Option<String>,
    /// Hash.
    pub hash: Option<String>,
}

/// Wire model for TaskCreateResult.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TaskCreateResult {
    /// Group id.
    pub group_id: Option<String>,
    /// Tasks.
    pub tasks: Vec<Task>,
    /// Setup.
    pub setup: SetupInfo,
}

/// Wire model for Task.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Task {
    /// Id.
    pub id: String,
    /// Project id.
    pub project_id: String,
    /// Group id.
    pub group_id: Option<String>,
    /// Name.
    pub name: String,
    /// Slug.
    pub slug: String,
    /// Branch.
    pub branch: String,
    /// Base branch.
    pub base_branch: String,
    /// Worktree path.
    pub worktree_path: Option<String>,
    /// Uses main checkout.
    pub uses_main_checkout: bool,
    /// State.
    pub state: TaskState,
    /// Prompt.
    pub prompt: Option<String>,
    /// Port start.
    pub port_start: Option<u16>,
    /// Port count.
    pub port_count: u16,
    /// Last message.
    pub last_message: Option<String>,
    /// Created at.
    pub created_at: f64,
    /// Updated at.
    pub updated_at: f64,
    /// Archived at.
    pub archived_at: Option<f64>,
}

fn nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}
/// List row with cached best-effort git metadata.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TaskSummary {
    /// The task's public fields, flattened for the UI.
    #[serde(flatten)]
    pub task: Task,
    /// Commits ahead of the base branch.
    pub ahead: Option<u32>,
    /// Commits behind the base branch.
    pub behind: Option<u32>,
    /// Changed file count.
    pub changed_files: Option<u32>,
    /// Listening ports when requested separately.
    pub ports: Vec<u16>,
}
impl From<tessera_store::repositories::Task> for Task {
    fn from(t: tessera_store::repositories::Task) -> Self {
        Self {
            id: t.id,
            project_id: t.project_id.unwrap_or_default(),
            group_id: t.group_id,
            name: t.name,
            slug: t.slug,
            branch: t.branch,
            base_branch: t.base_branch,
            worktree_path: t.worktree_path,
            uses_main_checkout: t.uses_main_checkout == Some(1),
            state: match t.state.as_deref().unwrap_or("backlog") {
                "backlog" => TaskState::Backlog,
                "setting_up" => TaskState::SettingUp,
                "active" => TaskState::Active,
                "archived" => TaskState::Archived,
                "deleted" => TaskState::Deleted,
                _ => TaskState::Error,
            },
            prompt: t.prompt,
            port_start: t.port_start.and_then(|n| u16::try_from(n).ok()),
            port_count: t.port_count.and_then(|n| u16::try_from(n).ok()).unwrap_or(10),
            last_message: t.last_message,
            created_at: t.created_at.unwrap_or(0) as f64,
            updated_at: t.updated_at.unwrap_or(0) as f64,
            archived_at: t.archived_at.map(|n| n as f64),
        }
    }
}
impl From<tessera_store::repositories::RunScript> for RunScript {
    fn from(s: tessera_store::repositories::RunScript) -> Self {
        Self {
            id: s.id,
            project_id: s.project_id.unwrap_or_default(),
            name: s.name.unwrap_or_default(),
            command: s.command.unwrap_or_default(),
            auto_start: s.auto_start == Some(1),
            sort: s.sort.and_then(|n| i32::try_from(n).ok()).unwrap_or(0),
        }
    }
}
impl TryFrom<tessera_store::repositories::Project> for Project {
    type Error = crate::error::AppError;
    fn try_from(p: tessera_store::repositories::Project) -> Result<Self, Self::Error> {
        let setup_state = tessera_store::projects::setup_state(&p).into();
        let copy_files = p
            .copy_files
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| {
                crate::error::AppError::new("project.invalid_copy_file", format!("invalid stored copy files: {e}"))
            })?
            .unwrap_or_default();
        Ok(Self {
            id: p.id,
            name: p.name,
            path: p.path,
            remote_url: p.remote_url,
            default_branch: p.default_branch,
            worktree_dir: p.worktree_dir,
            setup_script: p.setup_script,
            setup_shell: p.setup_shell,
            setup_approved_hash: p.setup_approved_hash,
            setup_state,
            copy_files,
            port_base: p.port_base.and_then(|n| u16::try_from(n).ok()),
            default_profile_id: p.default_profile_id,
            is_muted: p.is_muted == Some(1),
            sort: p.sort.and_then(|n| i32::try_from(n).ok()).unwrap_or(0),
            created_at: p.created_at.unwrap_or(0) as f64,
            updated_at: p.updated_at.unwrap_or(0) as f64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patch_distinguishes_omitted_null_and_value() {
        let omitted: ProjectPatch = serde_json::from_str("{}").expect("empty");
        let cleared: ProjectPatch = serde_json::from_str(r#"{"setup_script":null,"port_base":null}"#).expect("null");
        let set: ProjectPatch = serde_json::from_str(r#"{"setup_script":"echo hi","port_base":10000}"#).expect("value");
        assert_eq!(omitted.setup_script, None);
        assert_eq!(cleared.setup_script, Some(None));
        assert_eq!(cleared.port_base, Some(None));
        assert_eq!(set.setup_script, Some(Some("echo hi".into())));
        assert_eq!(set.port_base, Some(Some(10000)));
        assert!(serde_json::from_str::<ProjectPatch>(r#"{"port_base":70000}"#).is_err());
    }
}
