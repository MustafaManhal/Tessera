//! Optional sync (M11.2, FR-70…FR-72, S-21). Everything works signed out (FR-72).
//!
//! Sign-in is GitHub's device flow; the GitHub token is exchanged once for a sync session and dropped. The session
//! token and the document key (derived from the recovery key, which is shown once and never stored) live in the OS
//! keychain. Documents: `settings` (config.toml), `agent-profiles` (without environment values, which may be secret
//! and stay on each device) and `projects` (names and remote URLs; shown to other devices, never created on them).
//! Per-document sync state (version and merge base) and the chosen documents live in the database `kv` table.

use crate::error::AppError;
use crate::settings_commands::Settings;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use std::time::Duration;
use tauri::Manager;
use tauri_specta::Event;
use tessera_sync::crypto::{self, SyncKey};
use tessera_sync::github::{self, DevicePoll};
use tessera_sync::merge::Kind;
use tessera_sync::{DocState, HttpTransport, SyncError, Transport};

/// The deployed sync Worker (`services/sync`); `TESSERA_SYNC_URL` overrides it for tests and self-hosting.
pub const DEFAULT_SERVER: &str = "https://tessera-sync.calli-worker.workers.dev";
const KEYCHAIN: &str = "Tessera Sync";
/// Every document Tessera can sync, in display order.
pub const DOCS: [&str; 3] = ["settings", "agent-profiles", "projects"];
/// How often a signed-in app syncs in the background.
pub const INTERVAL: Duration = Duration::from_secs(15 * 60);

fn server() -> String {
    std::env::var("TESSERA_SYNC_URL").unwrap_or_else(|_| DEFAULT_SERVER.to_owned())
}

fn sync_error(error: SyncError) -> AppError {
    let code = match &error {
        SyncError::Unauthorized => "sync.signed_out",
        SyncError::Crypto(_) => "sync.recovery_key",
        SyncError::Network(_) => "sync.network",
        SyncError::Busy(_) => "sync.busy",
        SyncError::Protocol(_) => "sync.protocol",
    };
    AppError::new(code, error.to_string())
}

fn keychain(account: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN, account)
        .map_err(|e| AppError::new("sync.keychain", format!("The keychain is not available: {e}")))
}

fn secret(account: &str) -> Result<Option<String>, AppError> {
    match keychain(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::new(
            "sync.keychain",
            format!("The keychain could not be read: {e}"),
        )),
    }
}

fn set_secret(account: &str, value: &str) -> Result<(), AppError> {
    keychain(account)?
        .set_password(value)
        .map_err(|e| AppError::new("sync.keychain", format!("The keychain could not be written: {e}")))
}

fn forget_secret(account: &str) -> Result<(), AppError> {
    match keychain(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::new(
            "sync.keychain",
            format!("The keychain could not be cleared: {e}"),
        )),
    }
}

fn kv_get(app: &tauri::AppHandle, key: &str) -> Result<Option<String>, AppError> {
    Ok(app
        .state::<AppState>()
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .kv_get(key)?)
}

fn kv_set(app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), AppError> {
    Ok(app
        .state::<AppState>()
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .kv_set(key, value)?)
}

/// What S-21 shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SyncStatus {
    /// A session exists.
    pub signed_in: bool,
    /// The document key is on this device (the recovery key was created or entered here).
    pub has_key: bool,
    /// Account id on the sync server.
    pub user_id: Option<String>,
    /// Documents that sync.
    pub docs: Vec<String>,
    /// Every document that can sync.
    pub available: Vec<String>,
    /// Last successful sync, milliseconds.
    #[specta(type = Option<specta_typescript::Number>)]
    pub last_sync_at: Option<i64>,
    /// The last sync's error, if it failed.
    pub last_error: Option<String>,
    /// Server address.
    pub server: String,
}

/// The device-flow code to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SyncDeviceCode {
    /// Kept by the UI to poll.
    pub device_code: String,
    /// Shown to the user.
    pub user_code: String,
    /// Where to type it.
    pub verification_uri: String,
    /// Seconds until it expires.
    pub expires_in: u32,
    /// Seconds between polls.
    pub interval: u32,
}

/// One poll's result for the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SyncSignInPoll {
    /// `pending`, `slow_down`, `signed_in` or `failed`.
    pub state: String,
    /// Seconds to wait before the next poll.
    pub interval: u32,
    /// Why it failed.
    pub message: Option<String>,
    /// Signed in: whether the account already has synced data (then the recovery key must be entered, not created).
    pub has_remote_data: bool,
}

/// What one sync did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SyncReport {
    /// Documents uploaded.
    pub uploaded: Vec<String>,
    /// Documents applied on this device.
    pub applied: Vec<String>,
    /// Finished at, milliseconds.
    #[specta(type = specta_typescript::Number)]
    pub at: i64,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn chosen_docs(app: &tauri::AppHandle) -> Result<Vec<String>, AppError> {
    Ok(match kv_get(app, "sync.docs")? {
        Some(text) => serde_json::from_str(&text).unwrap_or_default(),
        None => DOCS.iter().map(|d| (*d).to_owned()).collect(),
    })
}

/// The sync state for S-21.
#[tauri::command]
#[specta::specta]
pub fn sync_status(app: tauri::AppHandle) -> Result<SyncStatus, AppError> {
    let user_id = kv_get(&app, "sync.user_id")?;
    Ok(SyncStatus {
        signed_in: user_id.is_some() && secret("session")?.is_some(),
        has_key: secret("key")?.is_some(),
        user_id,
        docs: chosen_docs(&app)?,
        available: DOCS.iter().map(|d| (*d).to_owned()).collect(),
        last_sync_at: kv_get(&app, "sync.last_at")?.and_then(|v| v.parse().ok()),
        last_error: kv_get(&app, "sync.last_error")?.filter(|e| !e.is_empty()),
        server: server(),
    })
}

/// Starts GitHub sign-in: the code for the user to enter at the verification address.
#[tauri::command]
#[specta::specta]
pub async fn sync_sign_in_start() -> Result<SyncDeviceCode, AppError> {
    let start = github::device_start().await.map_err(sync_error)?;
    Ok(SyncDeviceCode {
        device_code: start.device_code,
        user_code: start.user_code,
        verification_uri: start.verification_uri,
        expires_in: u32::try_from(start.expires_in).unwrap_or(900),
        interval: u32::try_from(start.interval.max(5)).unwrap_or(5),
    })
}

/// Polls GitHub once; when the user has approved, signs in to the sync server and stores the session.
#[tauri::command]
#[specta::specta]
pub async fn sync_sign_in_poll(app: tauri::AppHandle, device_code: String) -> Result<SyncSignInPoll, AppError> {
    let poll = |state: &str, interval: u64, message: Option<String>| SyncSignInPoll {
        state: state.into(),
        interval: u32::try_from(interval).unwrap_or(5),
        message,
        has_remote_data: false,
    };
    match github::device_poll(&device_code).await.map_err(sync_error)? {
        DevicePoll::Pending => Ok(poll("pending", 5, None)),
        DevicePoll::SlowDown(interval) => Ok(poll("slow_down", interval, None)),
        DevicePoll::Failed(message) => Ok(poll("failed", 5, Some(message))),
        DevicePoll::Token(token) => {
            let session = tessera_sync::sign_in(&server(), &token).await.map_err(sync_error)?;
            set_secret("session", &session.session_token)?;
            // A different account than last time: the old key and merge bases do not apply.
            if kv_get(&app, "sync.user_id")?.as_deref() != Some(session.user_id.as_str()) {
                forget_secret("key")?;
                reset_doc_states(&app)?;
            }
            kv_set(&app, "sync.user_id", &session.user_id)?;
            let transport = HttpTransport::new(&server(), &session.session_token);
            let has_remote_data = !transport.list().await.map_err(sync_error)?.is_empty();
            Ok(SyncSignInPoll {
                has_remote_data,
                ..poll("signed_in", 0, None)
            })
        }
    }
}

fn reset_doc_states(app: &tauri::AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    for doc in DOCS {
        store.kv_delete(&format!("sync.doc.{doc}"))?;
    }
    Ok(())
}

fn session(app: &tauri::AppHandle) -> Result<(String, String), AppError> {
    let user = kv_get(app, "sync.user_id")?;
    let token = secret("session")?;
    match (user, token) {
        (Some(user), Some(token)) => Ok((user, token)),
        _ => Err(AppError::new("sync.signed_out", "Sign in to sync first.")),
    }
}

fn store_key(key: &SyncKey) -> Result<(), AppError> {
    set_secret("key", &key.0.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn load_key() -> Result<SyncKey, AppError> {
    let hex = secret("key")?.ok_or_else(|| AppError::new("sync.no_key", "Enter your recovery key first."))?;
    let mut key = [0u8; 32];
    if hex.len() != 64 {
        return Err(AppError::new("sync.no_key", "Enter your recovery key again."));
    }
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| AppError::new("sync.no_key", "Enter your recovery key again."))?;
    }
    Ok(SyncKey(key))
}

/// For an account without synced data: a new recovery key, shown once. Its document key is stored on this device.
#[tauri::command]
#[specta::specta]
pub async fn sync_recovery_create(app: tauri::AppHandle) -> Result<String, AppError> {
    let (user, token) = session(&app)?;
    if !HttpTransport::new(&server(), &token)
        .list()
        .await
        .map_err(sync_error)?
        .is_empty()
    {
        return Err(AppError::new(
            "sync.has_data",
            "This account already has synced data: enter the recovery key you saved.",
        ));
    }
    let recovery = crypto::new_recovery_key().map_err(|e| sync_error(e.into()))?;
    let key = tauri::async_runtime::spawn_blocking({
        let recovery = recovery.clone();
        move || crypto::derive_key(&recovery, &user)
    })
    .await
    .map_err(|e| AppError::new("sync.worker_failed", e.to_string()))?
    .map_err(|e| sync_error(e.into()))?;
    store_key(&key)?;
    Ok(recovery)
}

/// Enters the recovery key on this device; checked against a synced document before it is kept.
#[tauri::command]
#[specta::specta]
pub async fn sync_recovery_enter(app: tauri::AppHandle, recovery_key: String) -> Result<(), AppError> {
    let (user, token) = session(&app)?;
    let key = tauri::async_runtime::spawn_blocking(move || crypto::derive_key(&recovery_key, &user))
        .await
        .map_err(|e| AppError::new("sync.worker_failed", e.to_string()))?
        .map_err(|e| sync_error(e.into()))?;
    let transport = HttpTransport::new(&server(), &token);
    if let Some(first) = transport.list().await.map_err(sync_error)?.first()
        && let Some(blob) = transport.get(&first.doc).await.map_err(sync_error)?
    {
        crypto::open(&key, &first.doc, &blob.sealed).map_err(|e| sync_error(e.into()))?;
    }
    store_key(&key)
}

/// Chooses the documents that sync.
#[tauri::command]
#[specta::specta]
pub fn sync_set_docs(app: tauri::AppHandle, docs: Vec<String>) -> Result<(), AppError> {
    let docs: Vec<String> = docs.into_iter().filter(|d| DOCS.contains(&d.as_str())).collect();
    kv_set(
        &app,
        "sync.docs",
        &serde_json::to_string(&docs).unwrap_or_else(|_| "[]".into()),
    )
}

/// Signs out: the session and the key leave this device; local data stays (FR-71).
#[tauri::command]
#[specta::specta]
pub async fn sync_sign_out(app: tauri::AppHandle) -> Result<(), AppError> {
    if let Ok((_, token)) = session(&app) {
        // Best effort: the server forgets the session too.
        let _ = reqwest_logout(&token).await;
    }
    forget_secret("session")?;
    forget_secret("key")?;
    Ok(())
}

async fn reqwest_logout(token: &str) -> Result<(), SyncError> {
    tessera_sync::transport::logout(&server(), token).await
}

/// Deletes every synced document and the account on the server, then signs out (FR-71).
#[tauri::command]
#[specta::specta]
pub async fn sync_delete_all(app: tauri::AppHandle) -> Result<(), AppError> {
    let (_, token) = session(&app)?;
    HttpTransport::new(&server(), &token)
        .delete_account()
        .await
        .map_err(sync_error)?;
    forget_secret("session")?;
    forget_secret("key")?;
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        store.kv_delete("sync.user_id")?;
        store.kv_delete("sync.last_at")?;
    }
    reset_doc_states(&app)
}

/// Syncs the chosen documents now.
#[tauri::command]
#[specta::specta]
pub async fn sync_now(app: tauri::AppHandle) -> Result<SyncReport, AppError> {
    let result = run(&app).await;
    match &result {
        Ok(report) => {
            kv_set(&app, "sync.last_at", &report.at.to_string())?;
            kv_set(&app, "sync.last_error", "")?;
        }
        Err(error) => kv_set(&app, "sync.last_error", &error.message)?,
    }
    result
}

async fn run(app: &tauri::AppHandle) -> Result<SyncReport, AppError> {
    let (_, token) = session(app)?;
    let key = load_key()?;
    let transport = HttpTransport::new(&server(), &token);
    let mut report = SyncReport {
        uploaded: Vec::new(),
        applied: Vec::new(),
        at: 0,
    };
    for doc in chosen_docs(app)? {
        let (kind, local, modified) = local_doc(app, &doc)?;
        let state: DocState = kv_get(app, &format!("sync.doc.{doc}"))?
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let outcome = tessera_sync::sync_doc(&transport, &key, &doc, kind, &local, modified, &state)
            .await
            .map_err(sync_error)?;
        if outcome.changed_local {
            apply_doc(app, &doc, &outcome.value)?;
            report.applied.push(doc.clone());
        }
        if outcome.uploaded {
            report.uploaded.push(doc.clone());
        }
        kv_set(
            app,
            &format!("sync.doc.{doc}"),
            &serde_json::to_string(&outcome.state).unwrap_or_default(),
        )?;
    }
    report.at = now();
    Ok(report)
}

/// The local copy of a document, its merge kind and when it last changed.
fn local_doc(app: &tauri::AppHandle, doc: &str) -> Result<(Kind, Value, i64), AppError> {
    let state = app.state::<AppState>();
    match doc {
        "settings" => {
            let path = app.state::<Settings>().path().to_path_buf();
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let modified = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
            Ok((Kind::Whole, Value::String(text), modified))
        }
        "agent-profiles" => {
            let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
            let profiles = store.agent_profiles().list(None)?;
            let modified = profiles.iter().map(|p| p.updated_at).max().unwrap_or(0);
            let items: Vec<Value> = profiles
                .into_iter()
                .map(|p| {
                    json!({
                        "id": p.id, "agent_id": p.agent_id, "name": p.name, "model": p.model,
                        "extra_args": serde_json::from_str::<Value>(&p.extra_args).unwrap_or(json!([])),
                        "skip_permissions": p.skip_permissions, "is_default": p.is_default,
                        "created_at": p.created_at, "updated_at": p.updated_at,
                    })
                })
                .collect();
            Ok((Kind::List, Value::Array(items), modified))
        }
        "projects" => {
            let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
            let local: Vec<Value> = store
                .projects()
                .list()?
                .into_iter()
                .map(|p| {
                    let id = p.remote_url.clone().unwrap_or_else(|| format!("local:{}", p.name));
                    json!({"id": id, "name": p.name, "remote_url": p.remote_url, "default_branch": p.default_branch})
                })
                .collect();
            // Projects of other devices stay in the list (they are never created here).
            let base: Vec<Value> = kv_get(app, "sync.doc.projects")?
                .and_then(|t| serde_json::from_str::<DocState>(&t).ok())
                .and_then(|s| s.base)
                .and_then(|b| b.as_array().cloned())
                .unwrap_or_default();
            let mut merged = local.clone();
            for item in base {
                if !merged.iter().any(|m| m.get("id") == item.get("id"))
                    && item["id"].as_str().is_some_and(|i| !i.starts_with("local:"))
                {
                    merged.push(item);
                }
            }
            Ok((Kind::List, Value::Array(merged), 0))
        }
        other => Err(AppError::new("sync.unknown_doc", format!("{other} cannot sync."))),
    }
}

fn apply_doc(app: &tauri::AppHandle, doc: &str, value: &Value) -> Result<(), AppError> {
    match doc {
        "settings" => {
            if let Some(text) = value.as_str()
                && !text.trim().is_empty()
            {
                let path = app.state::<Settings>().path().to_path_buf();
                // The settings watcher reloads and applies it (and keeps the last good config if it were invalid).
                let temp = path.with_extension("toml.sync");
                std::fs::write(&temp, text).map_err(|e| AppError::new("sync.apply", e.to_string()))?;
                std::fs::rename(&temp, &path).map_err(|e| AppError::new("sync.apply", e.to_string()))?;
            }
            Ok(())
        }
        "agent-profiles" => {
            let state = app.state::<AppState>();
            let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
            let incoming: Vec<&Value> = value.as_array().map(|a| a.iter().collect()).unwrap_or_default();
            for item in &incoming {
                let row = tessera_store::agents::AgentProfile {
                    id: item["id"].as_str().unwrap_or_default().to_owned(),
                    agent_id: item["agent_id"].as_str().unwrap_or_default().to_owned(),
                    name: item["name"].as_str().unwrap_or("Profile").to_owned(),
                    model: item["model"].as_str().map(str::to_owned),
                    extra_args: item["extra_args"].to_string(),
                    env: "{}".into(),
                    skip_permissions: item["skip_permissions"].as_bool().unwrap_or(false),
                    is_default: item["is_default"].as_bool().unwrap_or(false),
                    created_at: item["created_at"].as_i64().unwrap_or_else(now),
                    updated_at: item["updated_at"].as_i64().unwrap_or_else(now),
                };
                if !row.id.is_empty() && !row.agent_id.is_empty() {
                    store.agent_profiles().import(&row)?;
                }
            }
            for local in store.agent_profiles().list(None)? {
                if !incoming.iter().any(|i| i["id"].as_str() == Some(local.id.as_str())) {
                    store.agent_profiles().delete(&local.id)?;
                }
            }
            drop(store);
            let _ = crate::agent_commands::AgentsChanged.emit(app);
            Ok(())
        }
        // Other devices' projects are listed, never created here.
        _ => Ok(()),
    }
}

/// Syncs in the background while signed in: shortly after start, then every [`INTERVAL`].
pub fn start_background(app: &tauri::AppHandle) {
    let app = app.clone();
    let started = std::thread::Builder::new().name("tessera-sync".into()).spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            if session(&app).is_ok() && load_key().is_ok() {
                let result = tauri::async_runtime::block_on(sync_now(app.clone()));
                if let Err(error) = result {
                    tracing::warn!(code = error.code, "background sync failed");
                }
            }
            std::thread::sleep(INTERVAL);
        }
    });
    if let Err(error) = started {
        tracing::warn!(%error, "could not start background sync");
    }
}
