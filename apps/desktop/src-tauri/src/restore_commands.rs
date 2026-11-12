//! Restore IPC and a bounded best-effort shutdown snapshot.

use crate::{error::AppError, state::AppState};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};
use tauri::ipc::{InvokeResponseBody, IpcResponse};
use tauri::{Manager, State};
use tessera_store::{DataDirs, Store};

/// Terminal bytes from a previous run.
///
/// Sent as a raw `ArrayBuffer`, not JSON: a compressed 2 MiB ring is cheap until it becomes a JSON number array. The
/// generated TypeScript type says `number[]` (specta cannot express `ArrayBuffer`), as with [`crate::pty_commands::PtyFrame`].
/// Decode it with `new Uint8Array(result)`. An empty buffer means there is no saved history.
#[derive(Debug, Clone, PartialEq, Eq, Type)]
#[specta(transparent)]
pub struct Scrollback(Vec<u8>);

impl IpcResponse for Scrollback {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(InvokeResponseBody::Raw(self.0))
    }
}

impl Scrollback {
    /// The decoded bytes, for callers inside the app.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

/// Saved native geometry, in logical desktop coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct WindowBounds {
    /// Left edge.
    pub x: f64,
    /// Top edge.
    pub y: f64,
    /// Width.
    pub w: f64,
    /// Height.
    pub h: f64,
    /// Monitor name, when known.
    pub monitor: Option<String>,
    /// Whether the window was maximized.
    #[serde(default)]
    pub maximized: bool,
}
/// A stored window; state remains the original versioned JSON text.
#[derive(Debug, Clone, Serialize, Type)]
pub struct SavedLayout {
    /// Native window label.
    pub window_id: String,
    /// Opaque JSON string accepted by `parseLayout`.
    pub state: String,
    /// Optional saved geometry.
    pub bounds: Option<WindowBounds>,
    /// Unix milliseconds. `f64` because specta refuses to export `i64` to TypeScript (repo convention).
    pub updated_at: f64,
}

/// Saves opaque layout JSON and optional native geometry. The frontend stringifies its layout once.
#[tauri::command]
#[specta::specta]
pub fn layout_save(
    state: State<'_, AppState>,
    window_id: String,
    json: String,
    bounds: Option<WindowBounds>,
) -> Result<(), AppError> {
    let bounds = bounds
        .map(|b| serde_json::to_string(&b))
        .transpose()
        .map_err(|_| AppError::new("restore.invalid_json", "Invalid window geometry"))?;
    state
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .layout_save_with_bounds(&window_id, &json, bounds.as_deref())?;
    // Read only known additive metadata. Store the original JSON string without rewriting it.
    if let Ok(layout) = serde_json::from_str::<serde_json::Value>(&json) {
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        fn visit(
            store: &Store,
            node: &serde_json::Value,
            layout: &serde_json::Value,
            window: &str,
        ) -> Result<(), AppError> {
            if let (Some(id), Some(pane)) = (node["session_id"].as_str(), node["pane"].as_str())
                && let Some(cwd) = layout["panes"][pane]["cwd"].as_str()
            {
                store.pane_session_location(id, window, cwd)?;
            }
            if let Some(children) = node["children"].as_array() {
                for child in children {
                    visit(store, child, layout, window)?;
                }
            }
            Ok(())
        }
        if let Some(tabs) = layout["tabs"].as_array() {
            for tab in tabs {
                visit(&store, &tab["root"], &layout, &window_id)?;
            }
        }
    }
    Ok(())
}
/// Loads all windows, or one window when a label is supplied.
#[tauri::command]
#[specta::specta]
pub fn layout_load(state: State<'_, AppState>, window_id: Option<String>) -> Result<Vec<SavedLayout>, AppError> {
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let records = match window_id {
        Some(id) => store.layout_load(&id)?.into_iter().collect(),
        None => store.layout_list()?,
    };
    records
        .into_iter()
        .map(|r| {
            Ok(SavedLayout {
                window_id: r.window_id,
                state: r.state,
                bounds: r
                    .bounds
                    .map(|b| serde_json::from_str(&b))
                    .transpose()
                    .map_err(|_| AppError::new("restore.invalid_bounds", "Saved geometry is invalid"))?,
                updated_at: r.updated_at as f64,
            })
        })
        .collect()
}
/// Lists saved layouts (same shape as `layout_load`).
#[tauri::command]
#[specta::specta]
pub fn layout_list(state: State<'_, AppState>) -> Result<Vec<SavedLayout>, AppError> {
    layout_load(state, None)
}
/// Deletes a saved window without killing transferred sessions.
#[tauri::command]
#[specta::specta]
pub fn layout_delete(state: State<'_, AppState>, window_id: String) -> Result<(), AppError> {
    state
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .layout_delete(&window_id)?;
    Ok(())
}
/// Loads the terminal bytes saved for a layout pane in a previous run (keyed by pane id, see `save_on_close`).
#[tauri::command]
#[specta::specta]
pub fn scrollback_load(state: State<'_, AppState>, pane_id: String) -> Result<Scrollback, AppError> {
    Ok(Scrollback(
        state
            .store
            .lock()
            .map_err(|_| AppError::lock_failed())?
            .scrollback_load(&pane_id)?
            .unwrap_or_default(),
    ))
}

/// Prevents simultaneous close events from spawning unbounded shutdown workers.
#[derive(Default)]
pub struct SnapshotGate(Arc<AtomicBool>, std::sync::Mutex<Option<Instant>>);

/// Saves current rings, waiting no longer than 500 ms in total, including host and database work.
#[tauri::command]
#[specta::specta]
pub async fn scrollback_save_all(app: tauri::AppHandle) -> Result<bool, AppError> {
    tauri::async_runtime::spawn_blocking(move || save_on_close(&app))
        .await
        .map_err(|_| AppError::new("restore.worker_failed", "Snapshot worker failed"))
}

/// Best-effort close hook. A timed-out worker stops before its next write; no host lock is held here.
pub fn save_on_close(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return true;
    };
    let gate = app.state::<SnapshotGate>();
    // A quit can emit CloseRequested, ExitRequested and Exit in one burst (macOS Cmd+Q skips ExitRequested).
    // Share one budget across that burst.
    let Ok(mut last) = gate.1.try_lock() else {
        return false;
    };
    if last.is_some_and(|time| time.elapsed() < Duration::from_secs(1)) {
        return false;
    }
    *last = Some(Instant::now());
    drop(last);
    if gate.0.swap(true, Ordering::AcqRel) {
        return false;
    }
    let active = Arc::clone(&gate.0);
    // Daemon sessions survive the quit too, but a reboot ends them: their history is saved like local ones.
    let host = Arc::clone(&state.sessions);
    let dirs = DataDirs::from_root(state.dirs.root.clone());
    bounded(SNAPSHOT_BUDGET, move |deadline| {
        struct Reset(Arc<AtomicBool>);
        impl Drop for Reset {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _reset = Reset(active);
        let ids = host.list();
        if Instant::now() >= deadline {
            return false;
        }
        let Ok(store) = Store::open(&dirs) else {
            return false;
        };
        snapshot_within(
            deadline,
            ids,
            |id| host.snapshot(id).ok(),
            |id, bytes| {
                // Keyed by pane: the restored layout loads history by its pane ids (scrollback_load).
                let key = host.history_key(id);
                if let Err(error) = store.scrollback_save(&key, bytes) {
                    tracing::warn!(code = error.code(), "could not save terminal history");
                }
            },
        )
    })
}

/// Total time the shutdown snapshot may take, including host and database work.
pub const SNAPSHOT_BUDGET: Duration = Duration::from_millis(500);

/// Copies each available ring snapshot into the store before `deadline`.
///
/// Returns `false` as soon as the budget is spent; the caller's thread is then released and no further write starts.
/// A session whose snapshot fails is skipped instead of ending the loop, and a session is never read or saved twice.
fn snapshot_within(
    deadline: Instant,
    ids: Vec<tessera_pty::SessionId>,
    mut snapshot: impl FnMut(&tessera_pty::SessionId) -> Option<Vec<u8>>,
    mut save: impl FnMut(&tessera_pty::SessionId, &[u8]),
) -> bool {
    for id in ids {
        if Instant::now() >= deadline {
            return false;
        }
        let Some(bytes) = snapshot(&id) else {
            continue;
        };
        if Instant::now() >= deadline {
            return false;
        }
        save(&id, &bytes);
    }
    true
}
fn bounded(budget: Duration, work: impl FnOnce(Instant) -> bool + Send + 'static) -> bool {
    let deadline = Instant::now() + budget;
    let (send, receive) = mpsc::sync_channel(1);
    if std::thread::Builder::new()
        .name("tessera-restore-save".into())
        .spawn(move || {
            let _ = send.send(work(deadline));
        })
        .is_err()
    {
        return false;
    }
    receive
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(false)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn ids(count: usize) -> Vec<tessera_pty::SessionId> {
        (0..count).map(|_| tessera_pty::SessionId::new()).collect()
    }

    #[test]
    fn history_bytes_travel_raw_not_as_a_json_array() {
        let body = Scrollback(vec![27, 91, 48, 109]).body().unwrap();
        assert!(matches!(body, InvokeResponseBody::Raw(bytes) if bytes == vec![27, 91, 48, 109]));
    }

    #[test]
    fn slow_host_does_not_hold_up_quit() {
        let start = Instant::now();
        assert!(!bounded(Duration::from_millis(30), |_| {
            std::thread::sleep(Duration::from_millis(250));
            true
        }));
        assert!(start.elapsed() < Duration::from_millis(150));
        assert!(bounded(Duration::from_millis(100), |_| true));
    }

    #[test]
    fn a_slow_fake_host_saves_nothing_after_the_budget() {
        let start = Instant::now();
        let saved = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&saved);
        let completed = bounded(Duration::from_millis(50), move |deadline| {
            snapshot_within(
                deadline,
                ids(4),
                |_| {
                    std::thread::sleep(Duration::from_millis(120));
                    Some(b"slow".to_vec())
                },
                |id, _| sink.lock().unwrap().push(id.as_string()),
            )
        });
        assert!(!completed, "the budget ran out");
        assert!(start.elapsed() < Duration::from_millis(250), "quit is not held up");
        assert!(saved.lock().unwrap().is_empty(), "no write starts after the deadline");
    }

    #[test]
    fn a_fast_fake_host_saves_every_session_in_order() {
        let all = ids(3);
        let expected: Vec<_> = all.iter().map(tessera_pty::SessionId::as_string).collect();
        let saved = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
        let sink = Arc::clone(&saved);
        let completed = bounded(SNAPSHOT_BUDGET, move |deadline| {
            snapshot_within(
                deadline,
                all,
                |_| Some(b"ring".to_vec()),
                |id, bytes| sink.lock().unwrap().push((id.as_string(), bytes.to_vec())),
            )
        });
        assert!(completed);
        let saved = saved.lock().unwrap();
        assert_eq!(saved.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(), expected);
        assert!(saved.iter().all(|(_, bytes)| bytes == b"ring"));
    }

    #[test]
    fn a_failed_snapshot_skips_only_that_session() {
        let mut saved = Vec::new();
        let completed = snapshot_within(
            Instant::now() + Duration::from_secs(5),
            ids(3),
            |_| None,
            |id, _| saved.push(id.as_string()),
        );
        assert!(completed);
        assert!(saved.is_empty(), "nothing is saved without a snapshot");

        let mut saved = Vec::new();
        let all = ids(3);
        let failing = all[1];
        snapshot_within(
            Instant::now() + Duration::from_secs(5),
            all,
            |id| (*id != failing).then(|| b"ok".to_vec()),
            |id, _| saved.push(id.as_string()),
        );
        assert_eq!(saved.len(), 2);
        assert!(!saved.contains(&failing.as_string()));
    }
}
