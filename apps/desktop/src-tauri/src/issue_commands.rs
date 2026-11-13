//! Issues to tasks (M9.1, FR-54, FR-55): list GitHub issues of a project's repository or Linear issues, connect Linear
//! with an API key, and remember which issue a task came from (`tasks.issue_ref`, used for "Fixes #N" in the pull
//! request body). Tokens and keys live in the OS keychain only (services `tessera/github` and `tessera/linear`).
//! Debug builds read `TESSERA_GITHUB_TOKEN`, `TESSERA_GITHUB_API`, `TESSERA_LINEAR_KEY` and `TESSERA_LINEAR_API`
//! so the mock servers of the tests never need a real account or keychain.
use crate::{error::AppError, project_commands::with_store};
use serde::{Deserialize, Serialize};
use specta::Type;
use tessera_forge::{ForgeError, issues};
use tessera_store::integrations::Integration;

const GITHUB_SERVICE: &str = "tessera/github";
const LINEAR_SERVICE: &str = "tessera/linear";

fn debug_env(name: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    } else {
        None
    }
}
pub(crate) fn github_api() -> String {
    debug_env("TESSERA_GITHUB_API").unwrap_or_else(|| "https://api.github.com".into())
}
fn linear_api() -> String {
    debug_env("TESSERA_LINEAR_API").unwrap_or_else(|| issues::LINEAR_API.into())
}

fn secret(service: &str, account: &str) -> Option<String> {
    keyring::Entry::new(service, account).ok()?.get_password().ok()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct IssueInfo {
    pub provider: String,
    pub id: String,
    pub key: String,
    #[specta(type = specta_typescript::Number)]
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
    pub labels: Vec<String>,
    pub assignee: Option<String>,
}
impl From<issues::Issue> for IssueInfo {
    fn from(i: issues::Issue) -> Self {
        Self {
            provider: i.provider,
            id: i.id,
            key: i.key,
            number: i.number,
            title: i.title,
            body: i.body,
            url: i.url,
            labels: i.labels,
            assignee: i.assignee,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct LinearAccount {
    pub name: String,
    #[specta(type = specta_typescript::Number)]
    pub connected_at: i64,
}
impl From<Integration> for LinearAccount {
    fn from(row: Integration) -> Self {
        Self {
            name: row.account_login,
            connected_at: row.connected_at,
        }
    }
}

fn map_err(provider: &str, error: ForgeError) -> AppError {
    match error {
        ForgeError::RateLimited { until } => AppError::new(
            format!("{provider}.rate_limited"),
            format!("rate limited until {until}"),
        ),
        ForgeError::NotConnected => AppError::new(
            format!("{provider}.not_connected"),
            if provider == "linear" {
                "Linear did not accept the API key."
            } else {
                "GitHub is not connected."
            },
        ),
        other => AppError::new(format!("{provider}.error"), other.to_string()),
    }
}

pub(crate) fn github_token(app: &tauri::AppHandle) -> Result<String, AppError> {
    if let Some(token) = debug_env("TESSERA_GITHUB_TOKEN") {
        return Ok(token);
    }
    let state = tauri::Manager::state::<crate::state::AppState>(app);
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let row = store
        .integration_get("github")?
        .ok_or_else(|| AppError::new("github.not_connected", "GitHub is not connected."))?;
    drop(store);
    secret(GITHUB_SERVICE, &row.keychain_ref)
        .ok_or_else(|| AppError::new("github.not_connected", "The GitHub token is missing from the keychain."))
}

fn linear_key(app: &tauri::AppHandle) -> Result<String, AppError> {
    if let Some(key) = debug_env("TESSERA_LINEAR_KEY") {
        return Ok(key);
    }
    let state = tauri::Manager::state::<crate::state::AppState>(app);
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let row = store
        .integration_get("linear")?
        .ok_or_else(|| AppError::new("linear.not_connected", "Linear is not connected."))?;
    drop(store);
    secret(LINEAR_SERVICE, &row.keychain_ref).ok_or_else(|| {
        AppError::new(
            "linear.not_connected",
            "The Linear API key is missing from the keychain.",
        )
    })
}

/// Checks the key against Linear, keeps it in the keychain and records the account (name only, never the email).
#[tauri::command]
#[specta::specta]
pub async fn linear_connect(app: tauri::AppHandle, api_key: String) -> Result<LinearAccount, AppError> {
    let key = api_key.trim().to_owned();
    if key.is_empty() {
        return Err(AppError::new("linear.not_connected", "Paste a Linear API key."));
    }
    let (id, name) = issues::linear_viewer(&linear_api(), &key)
        .await
        .map_err(|e| map_err("linear", e))?;
    keyring::Entry::new(LINEAR_SERVICE, &id)
        .and_then(|e| e.set_password(&key))
        .map_err(|e| AppError::new("linear.keychain", e.to_string()))?;
    let row = with_store(app, move |store| {
        Ok(store.integration_upsert("linear", &name, &id, "read", &id)?)
    })
    .await?;
    Ok(row.into())
}

#[tauri::command]
#[specta::specta]
pub async fn linear_status(app: tauri::AppHandle) -> Result<Option<LinearAccount>, AppError> {
    with_store(app, |store| Ok(store.integration_get("linear")?.map(Into::into))).await
}

#[tauri::command]
#[specta::specta]
pub async fn linear_disconnect(app: tauri::AppHandle) -> Result<(), AppError> {
    let row = with_store(app, |store| {
        let row = store.integration_get("linear")?;
        store.integration_delete("linear")?;
        Ok(row)
    })
    .await?;
    if let Some(row) = row {
        // A missing keychain entry is fine.
        let _ = keyring::Entry::new(LINEAR_SERVICE, &row.keychain_ref).and_then(|e| e.delete_credential());
    }
    Ok(())
}

/// Open issues for the new-task picker. `provider` is `github` (the project's `origin` repository) or `linear`.
#[tauri::command]
#[specta::specta]
pub async fn issues_list(
    app: tauri::AppHandle,
    project_id: String,
    provider: String,
    query: Option<String>,
) -> Result<Vec<IssueInfo>, AppError> {
    let found = match provider.as_str() {
        "github" => {
            let path = with_store(app.clone(), move |store| {
                Ok(store
                    .projects()
                    .get(&project_id)?
                    .ok_or_else(|| AppError::new("project.not_found", "The project could not be found."))?
                    .path)
            })
            .await?;
            let remote = tauri::async_runtime::spawn_blocking(move || {
                tessera_git::Repo::open(std::path::Path::new(&path)).map(|repo| repo.remote_url)
            })
            .await
            .map_err(|e| AppError::new("issues.error", e.to_string()))??;
            let (owner, repo) = remote.as_deref().and_then(issues::parse_github_remote).ok_or_else(|| {
                AppError::new(
                    "issues.no_github_remote",
                    "This project's origin is not a GitHub repository.",
                )
            })?;
            let token = github_token(&app)?;
            issues::github_issues(&github_api(), &token, &owner, &repo, query.as_deref())
                .await
                .map_err(|e| map_err("github", e))?
        }
        "linear" => {
            let key = linear_key(&app)?;
            issues::linear_issues(&linear_api(), &key, query.as_deref())
                .await
                .map_err(|e| map_err("linear", e))?
        }
        _ => return Err(AppError::new("issues.error", "Unknown issue provider.")),
    };
    Ok(found.into_iter().map(Into::into).collect())
}

/// Remembers the issue a task was created from.
#[tauri::command]
#[specta::specta]
pub async fn task_set_issue(app: tauri::AppHandle, task_id: String, issue: IssueInfo) -> Result<(), AppError> {
    let reference = serde_json::json!({
        "provider": issue.provider,
        "id": issue.id,
        "number": issue.number,
        "key": issue.key,
        "url": issue.url,
        "title": issue.title,
    })
    .to_string();
    with_store(app, move |store| {
        let mut task = store
            .tasks()
            .get(&task_id)?
            .ok_or_else(|| AppError::new("task.not_found", "The task could not be found."))?;
        task.issue_ref = Some(reference);
        store.tasks().update(&task)?;
        Ok(())
    })
    .await
}
