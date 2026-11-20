//! Quick terminal (FR-21, S-15, F-04): a global hotkey slides a terminal down from the top of the active screen.
//!
//! The window (label [`LABEL`]) is created on first use and only hidden afterwards, so its shells keep running. It
//! spans the work area of the screen under the mouse pointer, `quick-terminal.height` of its height. macOS turns it into
//! a non-activating `NSPanel` that joins every Space and floats above full-screen apps; Windows uses a frameless,
//! always-on-top window without a taskbar button. Show and hide slide over [`SLIDE`]; with reduced motion the front end
//! fades instead (`quick_terminal_set_reduced_motion`). The hotkey follows `config.toml` live.

use crate::error::AppError;
use crate::settings_commands::{ConfigChanged, Settings};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_specta::Event;

/// Window label of the quick terminal. Its layout is saved under the same id, so it keeps its own tabs.
pub const LABEL: &str = "quick";
/// Slide duration (UI/UX motion table: 240 ms, easing `cubic-bezier(.2,.8,.2,1)`).
pub const SLIDE: Duration = Duration::from_millis(240);
const FRAMES: u32 = 16;
/// Focus settles for a moment after a show (Windows briefly hands it back to the previous window): a blur this soon
/// after the slide ends does not count for hide-on-blur.
const BLUR_GRACE: Duration = Duration::from_millis(500);

/// The quick terminal settings this module acts on (`[quick-terminal]`).
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    /// Whether the hotkey is registered at all.
    pub enabled: bool,
    /// Hotkey in config syntax, for example ``Ctrl+` ``.
    pub hotkey: String,
    /// Fraction of the work-area height, clamped to 0.1..=1.
    pub height: f64,
    /// Hide when the window loses focus.
    pub hide_on_blur: bool,
}

#[derive(Default)]
struct Inner {
    options: Option<Options>,
    registered: Option<Shortcut>,
    visible: bool,
    /// When the last show finished, for [`BLUR_GRACE`].
    shown_at: Option<Instant>,
    reduced_motion: bool,
}

/// App-wide quick terminal state.
#[derive(Default)]
pub struct QuickTerminal {
    inner: Mutex<Inner>,
    /// Bumped by every show or hide; a running slide stops when it no longer owns the latest generation.
    generation: AtomicU64,
}

/// A screen rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    /// Left edge.
    pub x: i32,
    /// Top edge.
    pub y: i32,
    /// Width.
    pub w: u32,
    /// Height.
    pub h: u32,
}

/// The panel's frame on a work area: full width, `fraction` of the height, anchored to the top.
#[must_use]
pub fn frame(work_area: Rect, fraction: f64) -> Rect {
    let fraction = if fraction.is_finite() {
        fraction.clamp(0.1, 1.0)
    } else {
        0.4
    };
    // Truncation is intended: a pixel height, always within u32 because fraction <= 1.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let h = (f64::from(work_area.h) * fraction).round() as u32;
    Rect {
        h: h.max(1),
        ..work_area
    }
}

/// `cubic-bezier(.2,.8,.2,1)` at time `t` in 0..=1, solved for x by bisection.
#[must_use]
pub fn ease(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    let bezier = |p1: f64, p2: f64, s: f64| 3.0 * (1.0 - s).powi(2) * s * p1 + 3.0 * (1.0 - s) * s * s * p2 + s.powi(3);
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..30 {
        let mid = f64::midpoint(lo, hi);
        if bezier(0.2, 0.2, mid) < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    bezier(0.8, 1.0, f64::midpoint(lo, hi))
}

/// Parses the config hotkey. Accepts the platform-neutral names the settings use (`Ctrl`, `Alt`, `Shift`, `Cmd`,
/// `Mod` for Cmd on macOS and Ctrl elsewhere) and single characters such as `` ` ``.
///
/// # Errors
/// A message naming the part that is not understood.
pub fn parse_hotkey(text: &str) -> Result<Shortcut, String> {
    let mut parts = Vec::new();
    for part in text.split('+').map(str::trim) {
        let mapped = match part.to_ascii_lowercase().as_str() {
            "" => return Err(format!("\"{text}\" has an empty key")),
            "mod" | "cmdorctrl" | "commandorcontrol" => "CommandOrControl".to_owned(),
            "cmd" | "command" | "super" | "meta" => "Super".to_owned(),
            "ctrl" | "control" => "Control".to_owned(),
            "alt" | "option" => "Alt".to_owned(),
            "shift" => "Shift".to_owned(),
            "`" => "Backquote".to_owned(),
            "space" => "Space".to_owned(),
            _ => part.to_owned(),
        };
        parts.push(mapped);
    }
    parts
        .join("+")
        .parse::<Shortcut>()
        .map_err(|error| format!("\"{text}\" is not a hotkey: {error}"))
}

/// The global-shortcut plugin; its handler toggles the quick terminal when the registered hotkey is pressed.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let ours = app
                .state::<QuickTerminal>()
                .inner
                .lock()
                .ok()
                .and_then(|inner| inner.registered)
                .is_some_and(|registered| registered.id() == shortcut.id());
            if ours {
                spawn_toggle(app.clone());
            }
        })
        .build()
}

/// Registers the hotkey from the loaded settings and follows `config:changed`.
pub fn start(app: &tauri::AppHandle) {
    let options = app.state::<Settings>().quick_terminal();
    apply(app, options);
    let handle = app.clone();
    ConfigChanged::listen(app, move |event| {
        let q = &event.payload.0.quick_terminal;
        apply(
            &handle,
            Options {
                enabled: q.enabled,
                hotkey: q.hotkey.clone(),
                height: q.height,
                hide_on_blur: q.hide_on_blur,
            },
        );
    });
}

fn apply(app: &tauri::AppHandle, options: Options) {
    let state = app.state::<QuickTerminal>();
    let Ok(mut inner) = state.inner.lock() else { return };
    let unchanged = inner
        .options
        .as_ref()
        .is_some_and(|old| old.enabled == options.enabled && old.hotkey == options.hotkey);
    let enabled = options.enabled;
    let hotkey = options.hotkey.clone();
    inner.options = Some(options);
    if unchanged {
        return;
    }
    let shortcuts = app.global_shortcut();
    if let Some(old) = inner.registered.take()
        && let Err(error) = shortcuts.unregister(old)
    {
        tracing::warn!(%error, "could not release the old quick terminal hotkey");
    }
    if !enabled {
        let visible = inner.visible;
        drop(inner);
        if visible {
            spawn_toggle(app.clone());
        }
        return;
    }
    match parse_hotkey(&hotkey) {
        Ok(shortcut) => match shortcuts.register(shortcut) {
            Ok(()) => {
                tracing::info!(hotkey = %hotkey, "quick terminal hotkey registered");
                inner.registered = Some(shortcut);
            }
            // Another app may own it: the palette entry still works.
            Err(error) => tracing::warn!(hotkey = %hotkey, %error, "could not register the quick terminal hotkey"),
        },
        Err(message) => tracing::warn!(%message, "invalid quick-terminal.hotkey"),
    }
}

fn spawn_toggle(app: tauri::AppHandle) {
    // Window creation and the slide run off the event loop (creating a window inside its callbacks can deadlock on
    // Windows); every AppKit call is sent back to the main thread.
    if let Err(error) = std::thread::Builder::new()
        .name("tessera-quick-terminal".into())
        .spawn(move || {
            if let Err(error) = toggle(&app) {
                tracing::warn!(code = error.code, message = %error.message, "quick terminal toggle failed");
            }
        })
    {
        tracing::warn!(%error, "could not start the quick terminal worker");
    }
}

/// Shows the quick terminal when hidden, hides it when shown.
///
/// # Errors
/// `quick_terminal.off` when disabled in settings, or a native window error.
pub fn toggle(app: &tauri::AppHandle) -> Result<(), AppError> {
    let state = app.state::<QuickTerminal>();
    let (visible, options) = {
        let inner = state.inner.lock().map_err(|_| AppError::lock_failed())?;
        (inner.visible, inner.options.clone())
    };
    if visible {
        return hide(app);
    }
    let options = options.filter(|o| o.enabled).ok_or_else(|| {
        AppError::new(
            "quick_terminal.off",
            "The quick terminal is off. Turn it on in Settings, Quick terminal.",
        )
    })?;
    show(app, &options)
}

fn native(error: tauri::Error) -> AppError {
    AppError::new("quick_terminal.native", error.to_string())
}

fn window(app: &tauri::AppHandle) -> Result<WebviewWindow, AppError> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| AppError::new("window.config_missing", "Main window configuration is unavailable"))?;
    config.label = LABEL.to_owned();
    config.title = "Tessera quick terminal".into();
    config.visible = false;
    config.focus = false;
    config.decorations = false;
    config.title_bar_style = tauri::TitleBarStyle::Visible;
    config.hidden_title = false;
    config.traffic_light_position = None;
    config.min_width = None;
    config.min_height = None;
    config.skip_taskbar = true;
    config.always_on_top = true;
    config.visible_on_all_workspaces = true;
    config.shadow = true;
    let window = crate::window_effects::builder(app, &config)?.build().map_err(native)?;
    #[cfg(target_os = "macos")]
    on_main(app, {
        let window = window.clone();
        move || macos::make_panel(&window)
    })?;
    Ok(window)
}

/// Runs `work` on the main thread and waits for it (AppKit is main-thread only).
#[cfg(target_os = "macos")]
fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppError> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(work());
    })
    .map_err(native)?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| AppError::new("quick_terminal.main_thread", "The main thread did not answer"))
}

/// The work area of the screen under the mouse pointer (the primary screen when the pointer is unknown).
fn active_work_area(app: &tauri::AppHandle) -> Result<Rect, AppError> {
    let monitors = app.available_monitors().map_err(native)?;
    let pointer = app.cursor_position().ok();
    let contains = |m: &tauri::Monitor, x: f64, y: f64| {
        let (p, s) = (m.position(), m.size());
        x >= f64::from(p.x)
            && y >= f64::from(p.y)
            && x < f64::from(p.x) + f64::from(s.width)
            && y < f64::from(p.y) + f64::from(s.height)
    };
    let monitor = pointer
        .and_then(|p| monitors.iter().find(|m| contains(m, p.x, p.y)).cloned())
        .or(app.primary_monitor().map_err(native)?)
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| AppError::new("quick_terminal.no_screen", "No screen is available"))?;
    let area = monitor.work_area();
    Ok(Rect {
        x: area.position.x,
        y: area.position.y,
        w: area.size.width,
        h: area.size.height,
    })
}

fn show(app: &tauri::AppHandle, options: &Options) -> Result<(), AppError> {
    let window = window(app)?;
    let target = frame(active_work_area(app)?, options.height);
    let state = app.state::<QuickTerminal>();
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let reduced = {
        let mut inner = state.inner.lock().map_err(|_| AppError::lock_failed())?;
        inner.visible = true;
        inner.shown_at = Some(Instant::now());
        inner.reduced_motion
    };
    window
        .set_size(tauri::PhysicalSize::new(target.w, target.h))
        .map_err(native)?;
    let hidden_y = target.y - i32::try_from(target.h).unwrap_or(i32::MAX);
    let start = if reduced { target.y } else { hidden_y };
    window
        .set_position(tauri::PhysicalPosition::new(target.x, start))
        .map_err(native)?;
    present(app, &window)?;
    if let Err(error) = window.emit_to(LABEL, "quick-terminal:shown", ()) {
        tracing::debug!(%error, "could not tell the quick terminal it is shown");
    }
    if !reduced && !slide(app, &window, target.x, start, target.y, generation)? {
        return Ok(()); // a newer hide took over
    }
    // Take focus again once in place, and start the blur grace period from here.
    #[cfg(not(target_os = "macos"))]
    window.set_focus().map_err(native)?;
    if let Ok(mut inner) = state.inner.lock() {
        inner.shown_at = Some(Instant::now());
    }
    Ok(())
}

fn hide(app: &tauri::AppHandle) -> Result<(), AppError> {
    let Some(window) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    let state = app.state::<QuickTerminal>();
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let reduced = {
        let mut inner = state.inner.lock().map_err(|_| AppError::lock_failed())?;
        inner.visible = false;
        inner.reduced_motion
    };
    if !reduced {
        let at = window.outer_position().map_err(native)?;
        let height = window.outer_size().map_err(native)?.height;
        let end = at.y - i32::try_from(height).unwrap_or(i32::MAX);
        if !slide(app, &window, at.x, at.y, end, generation)? {
            return Ok(()); // a newer show took over
        }
    }
    #[cfg(target_os = "macos")]
    on_main(app, move || macos::hide(&window))?;
    #[cfg(not(target_os = "macos"))]
    window.hide().map_err(native)?;
    Ok(())
}

fn present(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let window = window.clone();
        on_main(app, move || macos::show(&window))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        window.show().map_err(native)?;
        window.set_always_on_top(true).map_err(native)?;
        window.set_focus().map_err(native)?;
    }
    Ok(())
}

/// Moves the window vertically from `from` to `to` over [`SLIDE`]. Returns false when a newer show or hide started.
fn slide(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    x: i32,
    from: i32,
    to: i32,
    generation: u64,
) -> Result<bool, AppError> {
    let state = app.state::<QuickTerminal>();
    for frame in 1..=FRAMES {
        if state.generation.load(Ordering::Acquire) != generation {
            return Ok(false);
        }
        std::thread::sleep(SLIDE / FRAMES);
        let progress = ease(f64::from(frame) / f64::from(FRAMES));
        // Rounding to a pixel row is intended.
        #[allow(clippy::cast_possible_truncation)]
        let y = from + (f64::from(to - from) * progress).round() as i32;
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(native)?;
    }
    Ok(state.generation.load(Ordering::Acquire) == generation)
}

/// Window events for the quick terminal: hide on blur (setting) and hide instead of close.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != LABEL {
        return;
    }
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            spawn_hide(app.clone());
        }
        tauri::WindowEvent::Focused(false) => {
            let hide = app.state::<QuickTerminal>().inner.lock().is_ok_and(|inner| {
                inner.visible
                    && inner.options.as_ref().is_some_and(|o| o.hide_on_blur)
                    && inner.shown_at.is_none_or(|at| at.elapsed() >= BLUR_GRACE)
            });
            if hide {
                spawn_hide(app.clone());
            }
        }
        _ => {}
    }
}

/// The quick terminal is never closed, only hidden, so it would keep the app running after the last regular window
/// closed. When `closing` is that last window, destroy the quick terminal too and let the app exit as before.
pub fn release_with_last_window(app: &tauri::AppHandle, closing: &str) {
    let others = app
        .webview_windows()
        .into_keys()
        .any(|label| label != LABEL && label != closing);
    if !others
        && let Some(quick) = app.get_webview_window(LABEL)
        && let Err(error) = quick.destroy()
    {
        tracing::warn!(%error, "could not close the quick terminal with the last window");
    }
}

fn spawn_hide(app: tauri::AppHandle) {
    if let Err(error) = std::thread::Builder::new()
        .name("tessera-quick-terminal".into())
        .spawn(move || {
            if let Err(error) = hide(&app) {
                tracing::warn!(code = error.code, "quick terminal hide failed");
            }
        })
    {
        tracing::warn!(%error, "could not start the quick terminal worker");
    }
}

/// Shows or hides the quick terminal (palette action and menu).
#[tauri::command]
#[specta::specta]
pub async fn quick_terminal_toggle(app: tauri::AppHandle) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || toggle(&app))
        .await
        .map_err(|error| AppError::new("quick_terminal.worker_failed", error.to_string()))?
}

/// Hides the quick terminal (its last tab closed, or Escape when the front end wants it).
#[tauri::command]
#[specta::specta]
pub async fn quick_terminal_hide(app: tauri::AppHandle) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || hide(&app))
        .await
        .map_err(|error| AppError::new("quick_terminal.worker_failed", error.to_string()))?
}

/// Whether the quick terminal is shown, for tests and the front end.
#[tauri::command]
#[specta::specta]
pub fn quick_terminal_visible(app: tauri::AppHandle) -> bool {
    app.state::<QuickTerminal>()
        .inner
        .lock()
        .is_ok_and(|inner| inner.visible)
}

/// The front end reports `prefers-reduced-motion`; with it the quick terminal appears in place and fades.
#[tauri::command]
#[specta::specta]
pub fn quick_terminal_set_reduced_motion(app: tauri::AppHandle, reduced: bool) {
    if let Ok(mut inner) = app.state::<QuickTerminal>().inner.lock() {
        inner.reduced_motion = reduced;
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use tauri::{Manager, WebviewWindow};
    use tauri_nspanel::{CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt, tauri_panel};

    tauri_panel! {
        panel!(QuickPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })
    }

    /// Turns the window into a non-activating panel above full-screen apps on every Space.
    pub fn make_panel(window: &WebviewWindow) {
        match window.to_panel::<QuickPanel>() {
            Ok(panel) => {
                panel.set_level(PanelLevel::Status.value());
                panel.set_collection_behavior(
                    CollectionBehavior::new()
                        .can_join_all_spaces()
                        .full_screen_auxiliary()
                        .value(),
                );
                if let Err(error) = panel.set_style_mask(StyleMask::empty().nonactivating_panel().resizable().value()) {
                    tracing::warn!(?error, "could not make the quick terminal non-activating");
                }
                panel.set_hides_on_deactivate(false);
            }
            Err(error) => tracing::warn!(%error, "could not turn the quick terminal into a panel"),
        }
    }

    pub fn show(window: &WebviewWindow) {
        match window.app_handle().get_webview_panel(super::LABEL) {
            Ok(panel) => panel.show_and_make_key(),
            Err(_) => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }

    pub fn hide(window: &WebviewWindow) {
        match window.app_handle().get_webview_panel(super::LABEL) {
            Ok(panel) => panel.hide(),
            Err(_) => {
                let _ = window.hide();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_spans_the_work_area_width_and_a_fraction_of_its_height() {
        let area = Rect {
            x: -1920,
            y: 25,
            w: 1920,
            h: 1055,
        };
        assert_eq!(
            frame(area, 0.4),
            Rect {
                x: -1920,
                y: 25,
                w: 1920,
                h: 422
            }
        );
        assert_eq!(frame(area, 7.0).h, 1055);
        assert_eq!(frame(area, 0.0).h, 106);
        assert_eq!(frame(area, f64::NAN).h, 422);
    }

    #[test]
    fn easing_starts_at_zero_ends_at_one_and_never_goes_back() {
        assert!(ease(0.0).abs() < 1e-6);
        assert!((ease(1.0) - 1.0).abs() < 1e-6);
        let mut last = 0.0;
        for step in 1..=100 {
            let value = ease(f64::from(step) / 100.0);
            assert!(value >= last - 1e-9, "not monotonic at {step}");
            last = value;
        }
        // Fast start, slow end: more than half the distance in the first third.
        assert!(ease(1.0 / 3.0) > 0.5);
    }

    #[test]
    fn hotkeys_parse_from_the_settings_syntax() {
        for text in ["Ctrl+`", "Mod+Shift+T", "Cmd+Space", "Alt+F12", "control+backquote"] {
            assert!(parse_hotkey(text).is_ok(), "{text}");
        }
        assert_eq!(parse_hotkey("Ctrl+`"), parse_hotkey("Control+Backquote"));
        assert!(parse_hotkey("Ctrl+").is_err());
        assert!(parse_hotkey("Ctrl+Nonsense").is_err());
    }
}
