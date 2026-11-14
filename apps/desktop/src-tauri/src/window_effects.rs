//! Native background effects and the creation-time transparency they require.

use std::collections::BTreeSet;
use std::sync::Mutex;
use tauri::utils::config::{WindowConfig, WindowEffectsConfig};
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

use crate::error::AppError;
use crate::settings_commands::Settings;

/// Tracks windows whose native surface was created with transparency enabled.
#[derive(Default)]
pub struct WindowEffects(Mutex<BTreeSet<String>>);

impl WindowEffects {
    /// Removes the destroyed window's capability entry.
    pub fn remove(&self, label: &str) {
        if let Ok(mut transparent) = self.0.lock() {
            transparent.remove(label);
        }
    }
}

fn effects(kind: &str, windows: bool) -> Result<Option<WindowEffectsConfig>, AppError> {
    match kind {
        "none" => Ok(None),
        "blur" if windows => Ok(Some(EffectsBuilder::new().effect(Effect::Acrylic).build())),
        "blur" => Ok(Some(
            EffectsBuilder::new()
                .effect(Effect::HudWindow)
                .state(EffectState::Active)
                .build(),
        )),
        _ => Err(AppError::new("window.effect_invalid", "Unknown window effect")),
    }
}

/// Configures the native surface according to the saved appearance when creating a window.
/// Transparent surfaces let the frontend's existing opacity setting reveal the native backdrop.
pub fn builder<'a>(
    app: &'a tauri::AppHandle,
    config: &WindowConfig,
) -> Result<WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>, AppError> {
    let (blur, opacity) = app.state::<Settings>().window_appearance();
    let mut config = config.clone();
    config.transparent = needs_transparency(blur, opacity);
    config.window_effects = effects(if blur { "blur" } else { "none" }, cfg!(windows))?;
    let builder = WebviewWindowBuilder::from_config(app, &config).map_err(effect_failed)?;
    if !config.transparent {
        return Ok(builder);
    }
    app.state::<WindowEffects>()
        .0
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .insert(config.label);
    // The app root already paints the theme color and applies the configured opacity.
    // Clear the HTML canvas underneath it so the native backdrop can show through.
    Ok(builder.initialization_script(
        r#"window.addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.backgroundColor = "transparent";
        }, { once: true });"#,
    ))
}

fn needs_transparency(blur: bool, opacity: f64) -> bool {
    blur || opacity < 1.0
}

fn effect_failed(error: tauri::Error) -> AppError {
    AppError::new("window.effect_failed", error.to_string())
}

/// Applies or clears a native background effect in the invoking window.
#[tauri::command]
#[specta::specta]
pub fn window_set_effect(window: WebviewWindow, kind: String) -> Result<(), AppError> {
    let effects = effects(&kind, cfg!(windows))?;
    if effects.is_some()
        && !window
            .state::<WindowEffects>()
            .0
            .lock()
            .map_err(|_| AppError::lock_failed())?
            .contains(window.label())
    {
        return Err(AppError::new(
            "window.effect_unsupported",
            "Reopen this window to enable background blur",
        ));
    }
    window.set_effects(effects).map_err(effect_failed)?;
    tracing::debug!(window = window.label(), %kind, "requested native window effect");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_effects_per_platform_and_rejects_unknown_kind() {
        for (windows, material) in [(false, Effect::HudWindow), (true, Effect::Acrylic)] {
            assert!(effects("none", windows).unwrap().is_none());
            assert_eq!(effects("blur", windows).unwrap().unwrap().effects, [material]);
            assert_eq!(effects("other", windows).unwrap_err().code, "window.effect_invalid");
        }
    }

    #[test]
    fn transparency_is_only_needed_for_blur_or_reduced_opacity() {
        assert!(!needs_transparency(false, 1.0));
        assert!(needs_transparency(true, 1.0));
        assert!(needs_transparency(false, 0.8));
    }
}
