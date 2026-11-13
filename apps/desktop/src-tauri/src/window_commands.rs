//! Native windows; terminal lifetime stays with the application-wide PTY host.

use crate::{error::AppError, restore_commands::WindowBounds, state::AppState};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewWindow};

/// Minimum gap between two automatic geometry writes while a window is dragged or resized.
pub const GEOMETRY_INTERVAL: Duration = Duration::from_millis(500);

/// Throttles the move/resize write storm. A close always writes, regardless of this clock.
#[derive(Default)]
pub struct GeometryThrottle(Mutex<Option<Instant>>);

impl GeometryThrottle {
    /// True when this event should write: a forced close, or the first event after the interval.
    fn due(&self, force: bool, now: Instant) -> bool {
        let Ok(mut last) = self.0.lock() else {
            return false;
        };
        if !force && last.is_some_and(|at| now.duration_since(at) < GEOMETRY_INTERVAL) {
            return false;
        }
        *last = Some(now);
        true
    }
}

/// Allocates distinct window labels even for simultaneous creation requests.
#[derive(Default)]
pub struct WindowLabels(AtomicU64);
impl WindowLabels {
    fn next(&self, occupied: &BTreeSet<String>) -> String {
        loop {
            let id = self.0.fetch_add(1, Ordering::Relaxed) + 1;
            let label = format!("window-{id}");
            if !occupied.contains(&label) {
                return label;
            }
        }
    }
}
/// A live window and its geometry in logical desktop coordinates.
#[derive(Debug, Clone, Serialize, Type)]
pub struct WindowInfo {
    /// Unique Tauri label.
    pub id: String,
    /// Native title.
    pub title: String,
    /// Whether this window has keyboard focus.
    pub focused: bool,
    /// Current geometry.
    pub bounds: WindowBounds,
}
/// Tab move notification. The receiver must acknowledge/update its layout before the sender removes the tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[tauri_specta(event_name = "tab:transferred")]
pub struct TabTransferred {
    /// Source native window label.
    pub from: String,
    /// Destination native window label.
    pub to: String,
    /// Opaque serialized tab supplied by the frontend.
    pub tab_json: String,
}
fn native(error: tauri::Error) -> AppError {
    AppError::new("window.native_failed", error.to_string())
}
fn find(app: &tauri::AppHandle, id: &str) -> Result<WebviewWindow, AppError> {
    app.get_webview_window(id)
        .ok_or_else(|| AppError::new("window.not_found", "Window is no longer open"))
}
fn geometry(window: &tauri::Window) -> Result<WindowBounds, AppError> {
    let scale = window.scale_factor().map_err(native)?;
    let position = window.outer_position().map_err(native)?.to_logical::<f64>(scale);
    let size = window.inner_size().map_err(native)?.to_logical::<f64>(scale);
    Ok(WindowBounds {
        x: position.x,
        y: position.y,
        w: size.width,
        h: size.height,
        monitor: window
            .current_monitor()
            .map_err(native)?
            .and_then(|m| m.name().cloned()),
        maximized: window.is_maximized().map_err(native)?,
    })
}
/// Keeps the complete window inside a monitor's work area, including a reachable title bar.
pub fn clamp(bounds: &WindowBounds, screens: &[WindowBounds]) -> WindowBounds {
    let valid = |n: f64| n.is_finite();
    let Some(screen) = screens
        .iter()
        .filter(|s| valid(s.x) && valid(s.y) && s.w > 0.0 && s.h > 0.0)
        .max_by(|a, b| {
            let overlap = |s: &WindowBounds| {
                ((bounds.x + bounds.w).min(s.x + s.w) - bounds.x.max(s.x)).max(0.0)
                    * ((bounds.y + bounds.h).min(s.y + s.h) - bounds.y.max(s.y)).max(0.0)
            };
            overlap(a).total_cmp(&overlap(b))
        })
    else {
        return WindowBounds {
            x: 0.0,
            y: 0.0,
            w: 1200.0,
            h: 780.0,
            monitor: None,
            maximized: bounds.maximized,
        };
    };
    let w = if valid(bounds.w) {
        bounds.w.max(640.0).min(screen.w)
    } else {
        1200.0_f64.min(screen.w)
    };
    let h = if valid(bounds.h) {
        bounds.h.max(400.0).min(screen.h)
    } else {
        780.0_f64.min(screen.h)
    };
    WindowBounds {
        x: if valid(bounds.x) {
            bounds.x.clamp(screen.x, screen.x + screen.w - w)
        } else {
            screen.x
        },
        y: if valid(bounds.y) {
            bounds.y.clamp(screen.y, screen.y + screen.h - h)
        } else {
            screen.y
        },
        w,
        h,
        monitor: screen.monitor.clone(),
        maximized: bounds.maximized,
    }
}
fn screens(app: &tauri::AppHandle) -> Result<Vec<WindowBounds>, AppError> {
    Ok(app
        .available_monitors()
        .map_err(native)?
        .into_iter()
        .map(|m| {
            let pos = m.work_area().position.to_logical::<f64>(m.scale_factor());
            let size = m.work_area().size.to_logical::<f64>(m.scale_factor());
            WindowBounds {
                x: pos.x,
                y: pos.y,
                w: size.width,
                h: size.height,
                monitor: m.name().cloned(),
                maximized: false,
            }
        })
        .collect())
}
fn apply(window: &WebviewWindow, bounds: &WindowBounds) -> Result<(), AppError> {
    window
        .set_size(tauri::LogicalSize::new(bounds.w, bounds.h))
        .map_err(native)?;
    window
        .set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
        .map_err(native)?;
    if bounds.maximized {
        window.maximize().map_err(native)?;
    }
    Ok(())
}
fn create(app: &tauri::AppHandle, label: &str, bounds: &WindowBounds) -> Result<WebviewWindow, AppError> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| AppError::new("window.config_missing", "Main window configuration is unavailable"))?;
    config.label = label.to_owned();
    config.visible = true;
    config.focus = true;
    config.decorations = !cfg!(target_os = "windows");
    let builder = crate::window_effects::builder(app, &config)?;
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
    let window = builder
        .position(bounds.x, bounds.y)
        .inner_size(bounds.w, bounds.h)
        .build()
        .map_err(native)?;
    if bounds.maximized {
        window.maximize().map_err(native)?;
    }
    Ok(window)
}
/// Creates a main-like window offset from the focused window, clamped to the current screens.
#[tauri::command]
#[specta::specta]
pub async fn window_new(app: tauri::AppHandle) -> Result<String, AppError> {
    new_window(&app)
}

/// Creates a window from setup or a worker thread (never from a synchronous Windows IPC callback).
pub fn new_window(app: &tauri::AppHandle) -> Result<String, AppError> {
    let state = app.state::<AppState>();
    let mut occupied: BTreeSet<_> = app.webview_windows().into_keys().collect();
    for saved in state.store.lock().map_err(|_| AppError::lock_failed())?.layout_list()? {
        occupied.insert(saved.window_id);
    }
    let label = app.state::<WindowLabels>().next(&occupied);
    let mut bounds = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(|w| geometry(&w.as_ref().window()).ok())
        .unwrap_or(WindowBounds {
            x: 80.0,
            y: 80.0,
            w: 1200.0,
            h: 780.0,
            monitor: None,
            maximized: false,
        });
    bounds.x += 28.0;
    bounds.y += 28.0;
    bounds.maximized = false;
    let bounds = clamp(&bounds, &screens(app)?);
    let window = create(app, &label, &bounds)?;
    if let Err(error) = state
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .layout_save_with_bounds(
            &label,
            "{}",
            Some(
                &serde_json::to_string(&bounds)
                    .map_err(|_| AppError::new("window.invalid_bounds", "Invalid geometry"))?,
            ),
        )
    {
        let _ = window.close();
        return Err(error.into());
    }
    Ok(label)
}
/// Lists currently open native windows.
#[tauri::command]
#[specta::specta]
pub fn window_list(app: tauri::AppHandle) -> Result<Vec<WindowInfo>, AppError> {
    let mut windows = app
        .webview_windows()
        .into_values()
        // The quick terminal is not a tab destination and not in the window menu.
        .filter(|w| w.label() != crate::quick_terminal::LABEL)
        .map(|w| {
            Ok(WindowInfo {
                id: w.label().to_owned(),
                title: w.title().map_err(native)?,
                focused: w.is_focused().map_err(native)?,
                bounds: geometry(&w.as_ref().window())?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    windows.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(windows)
}
/// Requests window closure; the close hook saves geometry and snapshots without killing host sessions.
#[tauri::command]
#[specta::specta]
pub fn window_close(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    find(&app, &id)?.close().map_err(native)
}
/// Sets a native title, limited to 512 Unicode characters.
#[tauri::command]
#[specta::specta]
pub fn window_set_title(app: tauri::AppHandle, id: String, title: String) -> Result<(), AppError> {
    if title.chars().count() > 512 {
        return Err(AppError::new("window.title_too_long", "Window title is too long"));
    }
    find(&app, &id)?.set_title(&title).map_err(native)
}
/// Delivers a tab to exactly the destination window. Does not kill or detach any terminal.
#[tauri::command]
#[specta::specta]
pub fn window_transfer_tab(app: tauri::AppHandle, from: String, to: String, tab_json: String) -> Result<(), AppError> {
    if from == to {
        return Err(AppError::new(
            "window.same_target",
            "Choose a different destination window",
        ));
    }
    if tab_json.len() > tessera_store::restore::LAYOUT_LIMIT {
        return Err(AppError::new("restore.too_large", "Tab exceeds the size limit"));
    }
    let _: serde_json::Value =
        serde_json::from_str(&tab_json).map_err(|_| AppError::new("restore.invalid_json", "Invalid tab JSON"))?;
    find(&app, &from)?;
    find(&app, &to)?;
    app.emit_to(
        to.as_str(),
        "tab:transferred",
        TabTransferred {
            from,
            to: to.clone(),
            tab_json,
        },
    )
    .map_err(native)
}
/// Persists normal geometry on move/resize and snapshots on close. Maximized bounds retain the normal size.
pub fn save_geometry(window: &tauri::Window, force: bool) {
    if let Some(throttle) = window.try_state::<GeometryThrottle>()
        && !throttle.due(force, Instant::now())
    {
        return;
    }
    let Some(state) = window.try_state::<AppState>() else {
        return;
    };
    let Ok(mut bounds) = geometry(window) else {
        return;
    };
    let Ok(store) = state.store.try_lock() else {
        return;
    };
    if bounds.maximized
        && let Ok(Some(saved)) = store.layout_load(window.label())
        && let Some(old) = saved.bounds.and_then(|b| serde_json::from_str::<WindowBounds>(&b).ok())
    {
        bounds.x = old.x;
        bounds.y = old.y;
        bounds.w = old.w;
        bounds.h = old.h;
    }
    if let Ok(json) = serde_json::to_string(&bounds)
        && let Err(error) = store.layout_bounds_upsert(window.label(), &json)
    {
        tracing::warn!(code = error.code(), "could not save window geometry");
    }
}
/// Reopens saved secondary windows and restores the main window's visible-screen geometry.
pub fn restore_windows(app: &tauri::AppHandle) -> Result<(), AppError> {
    let records = app
        .state::<AppState>()
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .layout_list()?;
    let screens = screens(app)?;
    for saved in records {
        let Some(bounds) = saved.bounds.and_then(|b| serde_json::from_str::<WindowBounds>(&b).ok()) else {
            continue;
        };
        let bounds = clamp(&bounds, &screens);
        if let Some(window) = app.get_webview_window(&saved.window_id) {
            apply(&window, &bounds)?;
        } else if saved.window_id.starts_with("window-") {
            create(app, &saved.window_id, &bounds)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bounds(x: f64, y: f64, w: f64, h: f64) -> WindowBounds {
        WindowBounds {
            x,
            y,
            w,
            h,
            monitor: None,
            maximized: false,
        }
    }
    #[test]
    fn removed_monitor_and_oversized_window_clamp_inside_work_area() {
        let screen = bounds(-1440.0, 25.0, 1440.0, 875.0);
        let result = clamp(&bounds(5000.0, -2000.0, 2200.0, 1100.0), std::slice::from_ref(&screen));
        assert_eq!(result, bounds(-1440.0, 25.0, 1440.0, 875.0));
        let valid = bounds(-1200.0, 100.0, 800.0, 600.0);
        assert_eq!(clamp(&valid, &[screen]), valid);
    }
    #[test]
    fn labels_skip_live_and_saved_windows() {
        let labels = WindowLabels::default();
        let occupied = ["main".into(), "window-1".into(), "window-3".into()]
            .into_iter()
            .collect();
        assert_eq!(labels.next(&occupied), "window-2");
        assert_eq!(labels.next(&occupied), "window-4");
    }
    #[test]
    fn geometry_roundtrip_and_older_bounds() {
        let mut b = bounds(10.0, 20.0, 900.0, 700.0);
        b.maximized = true;
        assert_eq!(
            serde_json::from_str::<WindowBounds>(&serde_json::to_string(&b).unwrap()).unwrap(),
            b
        );
        assert!(
            !serde_json::from_str::<WindowBounds>(r#"{"x":0,"y":0,"w":900,"h":700,"monitor":null}"#)
                .unwrap()
                .maximized
        );
    }
    #[test]
    fn geometry_writes_are_throttled_but_a_close_always_writes() {
        let throttle = GeometryThrottle::default();
        let start = Instant::now();
        assert!(throttle.due(false, start));
        assert!(!throttle.due(false, start + Duration::from_millis(499)));
        assert!(throttle.due(true, start + Duration::from_millis(1)));
        assert!(throttle.due(false, start + Duration::from_millis(501)));
    }
    #[test]
    fn transfer_payload_keeps_from_to_and_the_opaque_tab() {
        let event = TabTransferred {
            from: "window-1".into(),
            to: "main".into(),
            tab_json: r#"{"id":"tab-7","root":{"pane":"p1","session_id":"01J"}}"#.into(),
        };
        let text = serde_json::to_string(&event).unwrap();
        assert!(text.contains(r#""tab_json":"{\"id\":\"tab-7\""#));
        assert_eq!(serde_json::from_str::<TabTransferred>(&text).unwrap(), event);
    }
    #[test]
    fn transferred_session_survives_the_source_window_closing() {
        // A window owns only its webview; the PTY host owns the session. Transferring emits the event, then closes
        // the source window: dropping a window's host handle must not end the process or its ring.
        let host = tessera_pty::PtyHost::new();
        let source = host.clone();
        let session = source.spawn(tessera_pty::SpawnSpec::new(std::env::temp_dir())).unwrap();
        let target = host.clone();
        drop(source);
        target.write(&session, b"echo transferred\r").unwrap();
        assert!(target.list().contains(&session));
        assert!(target.snapshot(&session).is_ok());
        target.kill(&session).unwrap();
    }
}
