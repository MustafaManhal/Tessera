//! Native window progress, notification focus and scoped secure keyboard input.
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{Manager, State};

/// OSC 9;4 progress states accepted by the desktop bridge.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProgressState {
    /// Clear the indicator.
    None,
    /// Determinate progress.
    Normal,
    /// Failed operation.
    Error,
    /// Unknown completion time.
    Indeterminate,
    /// Suspended operation.
    Paused,
}

/// Validates finite percentages and clamps out-of-range input before passing it to Tauri.
pub fn progress_bar(state: ProgressState, value: f64) -> Result<ProgressBarState, AppError> {
    if !value.is_finite() {
        return Err(AppError::new(
            "native.invalid_progress",
            "Progress must be a finite number.",
        ));
    }
    let status = match state {
        ProgressState::None => ProgressBarStatus::None,
        ProgressState::Normal => ProgressBarStatus::Normal,
        ProgressState::Error => ProgressBarStatus::Error,
        ProgressState::Indeterminate => ProgressBarStatus::Indeterminate,
        ProgressState::Paused => ProgressBarStatus::Paused,
    };
    Ok(ProgressBarState {
        status: Some(status),
        progress: Some(value.clamp(0.0, 100.0).round() as u64),
    })
}

/// Sets app-wide Dock progress on macOS and main-window taskbar progress on Windows.
#[tauri::command]
#[specta::specta]
pub fn window_set_progress(app: tauri::AppHandle, state: ProgressState, value: f64) -> Result<(), AppError> {
    main_window(&app)?
        .set_progress_bar(progress_bar(state, value)?)
        .map_err(native_error)
}

/// The dock badge (macOS) / taskbar overlay count (Windows) for panes that need the user; 0 clears it.
#[tauri::command]
#[specta::specta]
pub fn window_set_attention_count(app: tauri::AppHandle, count: u32) -> Result<(), AppError> {
    main_window(&app)?
        .set_badge_count(if count == 0 { None } else { Some(i64::from(count)) })
        .map_err(native_error)
}

fn native_error(error: tauri::Error) -> AppError {
    AppError::new("native.window_failed", error.to_string())
}
fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, AppError> {
    app.get_webview_window("main")
        .ok_or_else(|| AppError::new("native.window_missing", "The main window is unavailable."))
}

/// Shows, restores and focuses the main window for notification actions.
#[tauri::command]
#[specta::specta]
pub fn window_focus_main(app: tauri::AppHandle) -> Result<(), AppError> {
    let window = main_window(&app)?;
    window.show().map_err(native_error)?;
    window.unminimize().map_err(native_error)?;
    window.set_focus().map_err(native_error)
}

/// Unsupported is a successful, typed response on Windows, so it needs no error toast.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SecureKeyboardState {
    /// The system's actual secure-input state (may include another application's ownership).
    Supported { enabled: bool },
    /// This OS does not expose Carbon secure event input.
    Unsupported,
}

/// Pure reference counter; unmatched disables are harmless, failed native calls do not commit changes.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Default, Clone, Copy)]
struct SecureCounter(u32);
#[cfg(any(target_os = "macos", test))]
impl SecureCounter {
    fn next(self, enabled: bool) -> Result<Self, AppError> {
        if enabled {
            self.0
                .checked_add(1)
                .map(Self)
                .ok_or_else(|| AppError::new("native.secure_overflow", "Too many secure input requests."))
        } else {
            Ok(Self(self.0.saturating_sub(1)))
        }
    }
}

/// Owns at most one Carbon enable, shared by all caller references; releases on background and exit.
#[derive(Default)]
pub struct SecureKeyboard {
    #[cfg(target_os = "macos")]
    inner: std::sync::Mutex<SecureInner>,
}
#[cfg(target_os = "macos")]
#[derive(Default)]
struct SecureInner {
    count: SecureCounter,
    active: bool,
    owned: bool,
}

#[cfg(target_os = "macos")]
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn EnableSecureEventInput() -> i32;
    fn DisableSecureEventInput() -> i32;
    fn IsSecureEventInputEnabled() -> u8;
}
#[cfg(target_os = "macos")]
impl SecureInner {
    fn apply(&mut self, count: SecureCounter, active: bool) -> Result<(), AppError> {
        let wanted = count.0 > 0 && active;
        if wanted != self.owned {
            // SAFETY: process-wide Carbon calls have no pointer arguments and are serialized by the mutex.
            let status = unsafe {
                if wanted {
                    EnableSecureEventInput()
                } else {
                    DisableSecureEventInput()
                }
            };
            if status != 0 {
                return Err(AppError::new(
                    "native.secure_input_failed",
                    format!("Carbon secure input returned {status}."),
                ));
            }
            self.owned = wanted;
        }
        self.count = count;
        self.active = active;
        Ok(())
    }
}
impl SecureKeyboard {
    /// Suspends the native enable when the main window loses focus, retaining caller references.
    pub fn focus(&self, active: bool) {
        #[cfg(target_os = "macos")]
        {
            let mut inner = self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let count = inner.count;
            if let Err(error) = inner.apply(count, active) {
                tracing::error!(?error, "secure input focus update failed");
            }
        }
        #[cfg(windows)]
        let _ = active;
    }
    /// Releases this process's Carbon ownership without disturbing other applications.
    pub fn shutdown(&self) {
        #[cfg(target_os = "macos")]
        {
            let mut inner = self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Err(error) = inner.apply(SecureCounter::default(), false) {
                tracing::error!(?error, "secure input cleanup failed");
            }
        }
    }
}
impl Drop for SecureKeyboard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Acquires/releases one secure input reference. Enable twice, disable once remains protected while focused.
#[tauri::command]
#[specta::specta]
pub fn secure_keyboard_entry_set(
    state: State<'_, SecureKeyboard>,
    enabled: bool,
) -> Result<SecureKeyboardState, AppError> {
    #[cfg(target_os = "macos")]
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| AppError::new("native.secure_lock", "Secure input state is unavailable."))?;
        let next = inner.count.next(enabled)?;
        let active = inner.active;
        inner.apply(next, active)?;
    }
    #[cfg(windows)]
    let _ = (state, enabled);
    Ok(secure_keyboard_entry_state())
}

/// Queries the actual OS state instead of inferring it from caller references.
#[tauri::command]
#[specta::specta]
pub fn secure_keyboard_entry_state() -> SecureKeyboardState {
    #[cfg(target_os = "macos")]
    // SAFETY: Carbon query has no arguments and returns its documented Boolean byte.
    {
        SecureKeyboardState::Supported {
            enabled: unsafe { IsSecureEventInputEnabled() != 0 },
        }
    }
    #[cfg(windows)]
    {
        SecureKeyboardState::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_every_progress_state_and_clamps() {
        for (input, expected) in [
            (ProgressState::None, ProgressBarStatus::None),
            (ProgressState::Normal, ProgressBarStatus::Normal),
            (ProgressState::Error, ProgressBarStatus::Error),
            (ProgressState::Paused, ProgressBarStatus::Paused),
            (ProgressState::Indeterminate, ProgressBarStatus::Indeterminate),
        ] {
            let mapped = progress_bar(input, 42.0).expect("valid");
            assert_eq!(format!("{:?}", mapped.status), format!("{:?}", Some(expected)));
            assert_eq!(mapped.progress, Some(42));
        }
        assert_eq!(
            progress_bar(ProgressState::Normal, -1.0).expect("clamped").progress,
            Some(0)
        );
        assert_eq!(
            progress_bar(ProgressState::Normal, 101.0).expect("clamped").progress,
            Some(100)
        );
        assert_eq!(
            progress_bar(ProgressState::Normal, f64::NAN).expect_err("invalid").code,
            "native.invalid_progress"
        );
        assert!(progress_bar(ProgressState::None, f64::INFINITY).is_err());
        assert!(serde_json::from_str::<ProgressState>("\"unknown\"").is_err());
    }
    #[test]
    fn nested_secure_input_and_unmatched_disable_are_safe() {
        let count = SecureCounter::default()
            .next(true)
            .expect("enable")
            .next(true)
            .expect("enable")
            .next(false)
            .expect("disable");
        assert_eq!(count.0, 1);
        assert_eq!(
            count
                .next(false)
                .expect("disable")
                .next(false)
                .expect("extra disable")
                .0,
            0
        );
        assert_eq!(
            SecureCounter(u32::MAX).next(true).expect_err("overflow").code,
            "native.secure_overflow"
        );
    }
}
