//! Updates (M12.2, FR-73): check the stable or beta channel, download a signed update in the background, restart.
//! The signature is checked by tauri-plugin-updater against the public key in `tauri.conf.json`; an update with a bad
//! signature is refused and nothing is installed. Settings (channel, automatic updates) live in `kv`. Debug builds
//! read `TESSERA_UPDATE_ENDPOINT` and `TESSERA_UPDATE_PUBKEY` so tests can point at a mock server and a throwaway key.
//!
//! With automatic updates on, a found update is downloaded at once and the window is told it is ready
//! (`update:ready`); it then asks the user to restart. On macOS the new app bundle replaces the old one right after
//! the download (the running app keeps going until the restart). On Windows the installer exits the app as soon as it
//! runs, so the downloaded installer is kept in memory and only run when the user restarts.
use crate::{error::AppError, project_commands::with_store};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_specta::Event;

const STABLE: &str = "https://github.com/MustafaManhal/Tessera/releases/latest/download/latest.json";
const BETA: &str = "https://github.com/MustafaManhal/Tessera/releases/download/beta/latest.json";
const AUTO_EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
    /// Downloaded (and on macOS installed); a restart finishes it.
    ready: Mutex<Option<Ready>>,
    downloading: AtomicBool,
}

struct Ready {
    info: UpdateAvailable,
    /// Windows: the downloaded installer, run when the user restarts. Unused on macOS (installed already).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    update: Update,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    bytes: Vec<u8>,
}

/// Clears the busy flag when a download ends, however it ends.
struct Downloading<'a>(&'a AtomicBool);

impl Drop for Downloading<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct UpdateSettings {
    /// `stable` or `beta`.
    pub channel: String,
    pub auto_check: bool,
    #[specta(type = Option<specta_typescript::Number>)]
    pub last_checked: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "update:available")]
pub struct UpdateAvailable {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// An update was downloaded and a restart finishes it (the window asks the user to restart).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "update:ready")]
pub struct UpdateReady {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "update:progress")]
pub struct UpdateProgress {
    #[specta(type = specta_typescript::Number)]
    pub downloaded: u64,
    #[specta(type = Option<specta_typescript::Number>)]
    pub total: Option<u64>,
    pub done: bool,
}

pub fn endpoint_for(channel: &str) -> &'static str {
    if channel == "beta" { BETA } else { STABLE }
}

fn failed(message: impl Into<String>) -> AppError {
    AppError::new("update.failed", message)
}

fn debug_env(name: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    } else {
        None
    }
}

fn now() -> i64 {
    tessera_store::repositories::now_seconds()
}

fn read_settings(store: &tessera_store::Store) -> UpdateSettings {
    UpdateSettings {
        channel: store
            .kv_get("update.channel")
            .ok()
            .flatten()
            .filter(|c| c == "beta")
            .unwrap_or_else(|| "stable".into()),
        auto_check: store.kv_get("update.auto").ok().flatten().as_deref() != Some("off"),
        last_checked: store
            .kv_get("update.last_checked")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok()),
    }
}

fn available(update: &Update) -> UpdateAvailable {
    UpdateAvailable {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().filter(|b| !b.trim().is_empty()),
        date: update.date.map(|d| d.to_string()),
    }
}

async fn check(app: &tauri::AppHandle, channel: &str) -> Result<Option<UpdateAvailable>, AppError> {
    let endpoint = debug_env("TESSERA_UPDATE_ENDPOINT").unwrap_or_else(|| endpoint_for(channel).to_owned());
    let url = endpoint
        .parse()
        .map_err(|e| failed(format!("The update address is not valid: {e}")))?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| failed(e.to_string()))?
        .timeout(Duration::from_secs(20));
    if let Some(key) = debug_env("TESSERA_UPDATE_PUBKEY") {
        builder = builder.pubkey(key);
    }
    let updater = builder.build().map_err(|e| failed(e.to_string()))?;
    let found = updater
        .check()
        .await
        .map_err(|e| failed(format!("Could not check for updates: {e}")))?;
    let state = app.state::<UpdateState>();
    let mut pending = state.pending.lock().map_err(|_| AppError::lock_failed())?;
    *pending = found.clone();
    Ok(found.as_ref().map(available))
}

async fn check_and_record(app: &tauri::AppHandle) -> Result<Option<UpdateAvailable>, AppError> {
    let channel = with_store(app.clone(), |store| Ok(read_settings(store).channel)).await?;
    let result = check(app, &channel).await;
    if result.is_ok() {
        with_store(app.clone(), |store| {
            Ok(store.kv_set("update.last_checked", &now().to_string())?)
        })
        .await?;
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn update_settings(app: tauri::AppHandle) -> Result<UpdateSettings, AppError> {
    with_store(app, |store| Ok(read_settings(store))).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_settings_set(
    app: tauri::AppHandle,
    channel: String,
    auto_check: bool,
) -> Result<UpdateSettings, AppError> {
    if channel != "stable" && channel != "beta" {
        return Err(failed("The channel is stable or beta."));
    }
    // A pending update belongs to the old channel.
    if let Ok(mut pending) = app.state::<UpdateState>().pending.lock() {
        *pending = None;
    }
    with_store(app, move |store| {
        store.kv_set("update.channel", &channel)?;
        store.kv_set("update.auto", if auto_check { "on" } else { "off" })?;
        Ok(read_settings(store))
    })
    .await
}

/// Checks now. `None` means the app is up to date.
#[tauri::command]
#[specta::specta]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateAvailable>, AppError> {
    check_and_record(&app).await
}

/// The update found by the last check, if any (the chip reads this when the window opens).
#[tauri::command]
#[specta::specta]
pub fn update_pending(app: tauri::AppHandle) -> Result<Option<UpdateAvailable>, AppError> {
    let state = app.state::<UpdateState>();
    let pending = state.pending.lock().map_err(|_| AppError::lock_failed())?;
    Ok(pending.as_ref().map(available))
}

/// The update that is downloaded and waits for a restart, if any (the window reads this when it opens).
#[tauri::command]
#[specta::specta]
pub fn update_ready(app: tauri::AppHandle) -> Result<Option<UpdateAvailable>, AppError> {
    let state = app.state::<UpdateState>();
    let ready = state.ready.lock().map_err(|_| AppError::lock_failed())?;
    Ok(ready.as_ref().map(|ready| ready.info.clone()))
}

/// Downloads the pending update (signature checked first) and gets it ready for a restart: on macOS it is installed
/// at once, on Windows the installer waits in memory. Tells the window (`update:ready`). The app restarts only when
/// the user asks (`app_relaunch`), so work is not lost.
#[tauri::command]
#[specta::specta]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), AppError> {
    let state = app.state::<UpdateState>();
    if state.ready.lock().map_err(|_| AppError::lock_failed())?.is_some() {
        return Ok(());
    }
    let update = state
        .pending
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .clone()
        .ok_or_else(|| failed("There is no update to install. Check for updates first."))?;
    if state.downloading.swap(true, Ordering::AcqRel) {
        return Err(failed("The update is already downloading."));
    }
    let _busy = Downloading(&state.downloading);
    tracing::info!(version = %update.version, "downloading the update");
    let progress = app.clone();
    let done = app.clone();
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = UpdateProgress {
                    downloaded,
                    total,
                    done: false,
                }
                .emit(&progress);
            },
            move || {
                let _ = UpdateProgress {
                    downloaded: 0,
                    total: None,
                    done: true,
                }
                .emit(&done);
            },
        )
        .await
        .map_err(|e| failed(format!("The update could not be downloaded: {e}")))?;
    // macOS and Linux replace the app in place now; Windows runs the installer on restart (it exits the app).
    #[cfg(not(target_os = "windows"))]
    update
        .install(&bytes)
        .map_err(|e| failed(format!("The update could not be installed: {e}")))?;
    let info = available(&update);
    tracing::info!(version = %info.version, "the update is ready; a restart finishes it");
    *state.ready.lock().map_err(|_| AppError::lock_failed())? = Some(Ready {
        info: info.clone(),
        update,
        bytes,
    });
    if let Ok(mut pending) = state.pending.lock() {
        *pending = None;
    }
    let _ = UpdateReady {
        version: info.version,
        current_version: info.current_version,
        notes: info.notes,
        date: info.date,
    }
    .emit(&app);
    Ok(())
}

/// Restarts the app. A downloaded update is finished first: on Windows its installer runs (it exits the app, installs
/// quietly and starts Tessera again); on macOS the new version is already in place.
#[tauri::command]
#[specta::specta]
pub fn app_relaunch(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let ready = app
            .state::<UpdateState>()
            .ready
            .lock()
            .ok()
            .and_then(|mut ready| ready.take());
        if let Some(ready) = ready {
            tracing::info!(version = %ready.info.version, "running the update installer");
            crate::prepare_exit(&app);
            // Exits the process when the installer starts; it only returns on failure.
            if let Err(error) = ready.update.install(&ready.bytes) {
                tracing::warn!(%error, "the update installer did not start");
            }
        }
    }
    app.restart();
}

/// Checks at start (after 30 s) and every 6 hours while automatic updates are on; a found update is downloaded in the
/// background and the window is told when it is ready.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    let started = std::thread::Builder::new()
        .name("tessera-updates".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(30));
            loop {
                let auto = {
                    let state = app.state::<crate::state::AppState>();
                    state
                        .store
                        .lock()
                        .map(|s| read_settings(&s).auto_check)
                        .unwrap_or(false)
                };
                let ready = app
                    .state::<UpdateState>()
                    .ready
                    .lock()
                    .map(|ready| ready.is_some())
                    .unwrap_or(false);
                // A downloaded update waits for the restart; checking again would only find it again.
                if auto && !ready {
                    match tauri::async_runtime::block_on(check_and_record(&app)) {
                        Ok(Some(found)) => {
                            tracing::info!(version = %found.version, "an update is available");
                            let _ = found.emit(&app);
                            match tauri::async_runtime::block_on(update_install(app.clone())) {
                                Ok(()) => {}
                                Err(error) => tracing::warn!(message = %error.message, "update download failed"),
                            }
                        }
                        Ok(None) => tracing::info!("no update available"),
                        Err(error) => {
                            tracing::warn!(code = error.code, message = %error.message, "update check failed")
                        }
                    }
                }
                std::thread::sleep(AUTO_EVERY);
            }
        });
    if let Err(error) = started {
        tracing::warn!(%error, "could not start the update checker");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_have_their_own_manifest() {
        assert!(endpoint_for("stable").ends_with("/latest/download/latest.json"));
        assert!(endpoint_for("beta").contains("/download/beta/"));
        assert_eq!(endpoint_for("anything else"), endpoint_for("stable"));
    }
}
