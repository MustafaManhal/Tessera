//! GitHub connection commands (FR-54): device flow start/poll, `gh auth token` import, status, disconnect.
//! The token lives only in the OS keychain (service `tessera/github`, account = login); the integrations row
//! keeps login/id/scopes/keychain_ref. Debug builds can point the API at a mock via TESSERA_GITHUB_API and use
//! the in-memory keychain via TESSERA_GITHUB_KEYCHAIN=memory.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Mutex;
use tauri::State;
use tessera_forge::ForgeError;
use tessera_forge::github as gh;
use tessera_store::integrations::Integration;

use crate::state::AppState;

const KEYCHAIN_SERVICE: &str = "tessera/github";
const API_BASE: &str = "https://api.github.com";

fn api_base() -> String {
    std::env::var("TESSERA_GITHUB_API").unwrap_or_else(|_| API_BASE.to_owned())
}

fn device_base() -> String {
    std::env::var("TESSERA_GITHUB_DEVICE").unwrap_or_else(|_| "https://github.com".to_owned())
}

/// Keychain behind a trait so tests never touch the real one.
trait Keychain: Send + Sync {
    fn set(&self, account: &str, token: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct OsKeychain;
impl Keychain for OsKeychain {
    fn set(&self, account: &str, token: &str) -> Result<(), String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .and_then(|e| e.set_password(token))
            .map_err(|e| e.to_string())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        match keyring::Entry::new(KEYCHAIN_SERVICE, account).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[derive(Default)]
struct MemoryKeychain {
    map: Mutex<std::collections::HashMap<String, String>>,
}
impl Keychain for MemoryKeychain {
    fn set(&self, account: &str, token: &str) -> Result<(), String> {
        self.map
            .lock()
            .map_err(|_| String::from("lock"))?
            .insert(account.into(), token.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.map.lock().map_err(|_| String::from("lock"))?.remove(account);
        Ok(())
    }
}

fn keychain() -> Box<dyn Keychain> {
    if cfg!(debug_assertions) && std::env::var("TESSERA_GITHUB_KEYCHAIN").as_deref() == Ok("memory") {
        return Box::new(MemoryKeychain::default());
    }
    Box::new(OsKeychain)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectStart {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    #[specta(type = specta_typescript::Number)]
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubIntegration {
    pub login: String,
    #[specta(type = specta_typescript::Number)]
    pub id: u64,
    pub scopes: String,
    #[specta(type = specta_typescript::Number)]
    pub connected_at: i64,
}

impl From<Integration> for GithubIntegration {
    fn from(row: Integration) -> Self {
        Self {
            login: row.account_login,
            id: row.account_id.parse().unwrap_or(0),
            scopes: row.scopes,
            connected_at: row.connected_at,
        }
    }
}

fn store<'a>(state: &'a State<'a, AppState>) -> Result<std::sync::MutexGuard<'a, tessera_store::Store>, AppError> {
    state.store.lock().map_err(|_| AppError::lock_failed())
}

fn map_err(e: ForgeError) -> AppError {
    match e {
        ForgeError::RateLimited { until } => {
            AppError::new("github.rate_limited", format!("rate limited until {until}"))
        }
        ForgeError::GhMissing => AppError::new("github.gh_missing", "gh is not installed or has no login"),
        ForgeError::Denied => AppError::new("github.denied", "GitHub denied the sign-in"),
        ForgeError::Expired => AppError::new("github.expired", "the sign-in code expired"),
        ForgeError::NotConnected => AppError::new("github.not_connected", "not connected to GitHub"),
        other => AppError::new("github.error", other.to_string()),
    }
}

/// Persists a fresh connection: fetch the user, store the token in the keychain, upsert the integrations row.
async fn connect_with_token(
    state: &State<'_, AppState>,
    token: String,
    scopes: &str,
) -> Result<GithubIntegration, AppError> {
    let user = gh::me(&api_base(), &token).await.map_err(map_err)?;
    let kc = keychain();
    kc.set(&user.login, &token)
        .map_err(|e| AppError::new("github.keychain", e))?;
    let row = store(state)?
        .integration_upsert("github", &user.login, &user.id.to_string(), scopes, &user.login)
        .map_err(|e| AppError::new("github.store", e.to_string()))?;
    Ok(row.into())
}

#[tauri::command]
#[specta::specta]
pub async fn github_connect_start() -> Result<GithubConnectStart, AppError> {
    let start = gh::device_start(&device_base()).await.map_err(map_err)?;
    Ok(GithubConnectStart {
        user_code: start.user_code,
        verification_uri: start.verification_uri,
        device_code: start.device_code,
        interval: start.interval,
    })
}

/// One poll. `None` = still pending; slow_down comes back as an error-free `SlowDown` via interval bump handled
/// caller-side (the UI retries with the new interval).
#[tauri::command]
#[specta::specta]
pub async fn github_connect_poll(
    state: State<'_, AppState>,
    device_code: String,
) -> Result<Option<GithubIntegration>, AppError> {
    match gh::device_poll(&device_base(), &device_code).await.map_err(map_err)? {
        gh::DevicePoll::Pending | gh::DevicePoll::SlowDown(_) => Ok(None),
        gh::DevicePoll::Token(token) => connect_with_token(&state, token, SCOPES_FOR_ROW).await.map(Some),
        gh::DevicePoll::Failed(reason) if reason == "expired" => Err(map_err(ForgeError::Expired)),
        gh::DevicePoll::Failed(reason) if reason == "denied" => Err(map_err(ForgeError::Denied)),
        gh::DevicePoll::Failed(other) => Err(AppError::new("github.error", other)),
    }
}

const SCOPES_FOR_ROW: &str = "repo read:org";

#[tauri::command]
#[specta::specta]
pub async fn github_import_gh(state: State<'_, AppState>) -> Result<GithubIntegration, AppError> {
    let token = gh::gh_token().ok_or_else(|| map_err(ForgeError::GhMissing))?;
    connect_with_token(&state, token, "repo read:org (via gh)").await
}

#[tauri::command]
#[specta::specta]
pub fn github_status(state: State<'_, AppState>) -> Result<Option<GithubIntegration>, AppError> {
    Ok(store(&state)?
        .integration_get("github")
        .map_err(|e| AppError::new("github.store", e.to_string()))?
        .map(Into::into))
}

#[tauri::command]
#[specta::specta]
pub fn github_disconnect(state: State<'_, AppState>) -> Result<(), AppError> {
    let row = store(&state)?
        .integration_get("github")
        .map_err(|e| AppError::new("github.store", e.to_string()))?;
    if let Some(row) = row {
        // Best effort: a missing keychain entry is fine.
        let _ = keychain().delete(&row.keychain_ref);
        store(&state)?
            .integration_delete("github")
            .map_err(|e| AppError::new("github.store", e.to_string()))?;
    }
    Ok(())
}
