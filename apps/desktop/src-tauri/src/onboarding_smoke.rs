//! Opt-in debug-app check for first-run onboarding and importers (M12.1, FR-66/FR-69). Set
//! TESSERA_ONBOARDING_SMOKE_ROOT to a disposable directory; writes onboarding-smoke.json there. Uses a
//! temporary HOME with a fixture Ghostty config — never the user's real terminal files.

use std::path::{Path, PathBuf};
use tauri::Manager;

pub fn start(app: &tauri::AppHandle) {
    let Some(root) = std::env::var_os("TESSERA_ONBOARDING_SMOKE_ROOT").map(PathBuf::from) else {
        return;
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let report = match run(&handle, &root).await {
            Ok(value) => value,
            Err(error) => serde_json::json!({"ok": false, "error": error}),
        };
        let path = root.join("onboarding-smoke.json");
        if let Err(error) = std::fs::write(&path, report.to_string()) {
            tracing::error!(%error, "could not write onboarding smoke result");
        }
        tracing::info!(%report, "onboarding smoke finished");
    });
}

async fn run(app: &tauri::AppHandle, root: &Path) -> Result<serde_json::Value, String> {
    use crate::import_commands as imp;
    // Temporary HOME with a fixture Ghostty config.
    let home = root.join("home");
    let ghostty_dir = home.join(".config").join("ghostty");
    std::fs::create_dir_all(&ghostty_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        ghostty_dir.join("config"),
        "font-family = \"JetBrainsMono Nerd Font\"\nfont-size = 14\ntheme = dark:\"Catppuccin Mocha\"\nkeybind = ctrl+shift+t=new_tab\n",
    )
    .map_err(|e| e.to_string())?;
    let real_home = std::env::var_os("HOME");
    // Debug-only smoke: single-purpose process, restore afterwards.
    unsafe {
        std::env::set_var("HOME", &home);
    }

    let sources = imp::import_sources();
    let ghostty = sources.iter().find(|s| s.id == "ghostty").cloned();
    let preview = match &ghostty {
        Some(source) if source.available => imp::import_preview("ghostty".into())
            .await
            .map_err(|e| format!("preview: {e:?}"))?,
        _ => return Err("ghostty source not detected".into()),
    };
    let state = imp::onboarding_state(app.state()).map_err(|e| format!("state: {e:?}"))?;
    if let Some(home) = real_home {
        unsafe {
            std::env::set_var("HOME", home);
        }
    }
    Ok(serde_json::json!({
        "ok": true,
        "onboarding_done": state.done,
        "ghostty": ghostty.map(|s| s.path),
        "applied": preview.applied.iter().map(|i| i.label.clone()).collect::<Vec<_>>(),
        "failed": preview.failed.iter().map(|f| format!("{}: {}", f.item, f.reason)).collect::<Vec<_>>(),
    }))
}
