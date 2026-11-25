//! Rebuildable native menus from the frontend action registry, preserving OS-owned editing and app items.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeSet;
use std::sync::Mutex;
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem, Submenu},
};

const PREFIX: &str = "tessera.action.";
/// A single frontend action eligible for the native menu.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ActionMenuItem {
    /// Stable frontend action id.
    pub id: String,
    /// Localized visible name.
    pub label: String,
    /// Optional single chord (`Mod+Shift+P`). Multi-stroke bindings cannot be native accelerators.
    pub accelerator: Option<String>,
    /// Localized top-level menu group. Existing native groups are extended.
    pub group: String,
}
/// Event delivered only to the focused Tessera window.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[tauri_specta(event_name = "menu:action")]
pub struct MenuAction {
    /// Frontend action id, without any native prefix.
    pub id: String,
}
/// Current custom action ids. Native predefined ids are deliberately absent.
#[derive(Default)]
pub struct MenuRegistry(Mutex<BTreeSet<String>>);
#[derive(Clone, Copy)]
enum Platform {
    Mac,
    Windows,
}
fn current() -> Platform {
    if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Mac
    }
}
fn invalid() -> AppError {
    AppError::new("menu.invalid_items", "Invalid menu action or accelerator")
}
fn native(error: tauri::Error) -> AppError {
    AppError::new("menu.native_failed", error.to_string())
}

fn accelerator(text: &str, platform: Platform) -> Result<String, AppError> {
    if text.len() > 128 {
        return Err(invalid());
    }
    let plus = text.ends_with("++");
    let parts: Vec<_> = if plus {
        text[..text.len() - 2].split('+').map(str::trim).collect()
    } else {
        text.split('+').map(str::trim).collect()
    };
    let (modifiers, key) = if plus {
        (parts.as_slice(), "+")
    } else {
        let (key, mods) = parts.split_last().ok_or_else(invalid)?;
        (mods, *key)
    };
    let mut out = Vec::<String>::new();
    for modifier in modifiers {
        let value = match modifier.to_ascii_lowercase().as_str() {
            "mod" | "cmdorctrl" | "commandorcontrol" | "commandorctrl" => match platform {
                Platform::Mac => "Super",
                Platform::Windows => "Ctrl",
            },
            "cmd" | "command" | "meta" | "super" | "win" => "Super",
            "ctrl" | "control" => "Ctrl",
            "shift" => "Shift",
            "alt" | "opt" | "option" => "Alt",
            _ => return Err(invalid()),
        };
        if !out.iter().any(|s| s == value) {
            out.push(value.into());
        }
    }
    let key = match key.to_ascii_lowercase().as_str() {
        "esc" | "escape" => "Escape".into(),
        "return" | "enter" => "Enter".into(),
        "del" | "delete" => "Delete".into(),
        "left" | "arrowleft" => "ArrowLeft".into(),
        "right" | "arrowright" => "ArrowRight".into(),
        "up" | "arrowup" => "ArrowUp".into(),
        "down" | "arrowdown" => "ArrowDown".into(),
        "tab" => "Tab".into(),
        "space" => "Space".into(),
        "backspace" => "Backspace".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        "pageup" => "PageUp".into(),
        "pagedown" => "PageDown".into(),
        "insert" => "Insert".into(),
        "+" => {
            if !out.iter().any(|s| s == "Shift") {
                out.push("Shift".into());
            }
            "Equal".into()
        }
        k if k.len() == 1 && (k.as_bytes()[0].is_ascii_alphanumeric() || "`-=[]\\;',./".contains(k)) => {
            k.to_ascii_uppercase()
        }
        k if k
            .strip_prefix('f')
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (1..=24).contains(&n)) =>
        {
            k.to_ascii_uppercase()
        }
        _ => return Err(invalid()),
    };
    out.push(key);
    Ok(out.join("+"))
}
/// Windows treats `&` as a mnemonic marker and needs `&&` for a literal; macOS shows it verbatim.
fn mnemonic(text: &str, platform: Platform) -> String {
    match platform {
        Platform::Windows => text.replace('&', "&&"),
        Platform::Mac => text.to_owned(),
    }
}
/// Maps a native event id to a frontend action, only for ids this process installed.
fn routed<'a>(action: &'a str, known: &BTreeSet<String>) -> Option<&'a str> {
    let id = action.strip_prefix(PREFIX)?;
    known.contains(id).then_some(id)
}
fn native_owned(id: &str) -> bool {
    matches!(
        id,
        "app.about"
            | "app.hide"
            | "app.quit"
            | "window.close"
            | "window.minimize"
            | "terminal.copy"
            | "terminal.paste"
            | "terminal.selectAll"
            | "edit.copy"
            | "edit.paste"
            | "edit.cut"
            | "edit.undo"
            | "edit.redo"
            | "edit.selectAll"
    )
}
fn validate(items: &[ActionMenuItem]) -> Result<Vec<(ActionMenuItem, Option<String>)>, AppError> {
    if items.len() > 512 {
        return Err(invalid());
    }
    let mut ids = BTreeSet::new();
    items
        .iter()
        .map(|item| {
            if item.id.is_empty()
                || item.id.len() > 128
                || item.label.trim().is_empty()
                || item.label.len() > 256
                || item.group.trim().is_empty()
                || item.group.len() > 64
                || item.id.chars().any(char::is_control)
                || item.label.chars().any(char::is_control)
                || item.group.chars().any(char::is_control)
                || !ids.insert(&item.id)
            {
                return Err(invalid());
            }
            let accel = item
                .accelerator
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(|s| accelerator(s, current()))
                .transpose()?;
            Ok((item.clone(), accel))
        })
        .collect()
}
/// Replaces the custom menu atomically. Call on startup and after keybinding or localization changes.
/// Standard About/Hide/Quit/Edit/Window items remain native and are not routed through JavaScript.
#[tauri::command]
#[specta::specta]
pub fn menu_set(app: tauri::AppHandle, items: Vec<ActionMenuItem>) -> Result<(), AppError> {
    let items = validate(&items)?;
    let menu = Menu::default(&app).map_err(native)?;
    let mut ids = BTreeSet::new();
    for (item, accel) in items {
        if native_owned(&item.id) {
            continue;
        }
        let group = menu
            .items()
            .map_err(native)?
            .into_iter()
            .filter_map(|i| i.as_submenu().cloned())
            .find(|s| s.text().is_ok_and(|label| label.eq_ignore_ascii_case(&item.group)));
        let group = match group {
            Some(group) => group,
            None => {
                let group = Submenu::new(&app, mnemonic(&item.group, current()), true).map_err(native)?;
                menu.append(&group).map_err(native)?;
                group
            }
        };
        let custom = MenuItem::with_id(
            &app,
            format!("{PREFIX}{}", item.id),
            mnemonic(&item.label, current()),
            true,
            accel.as_deref(),
        )
        .map_err(native)?;
        group.append(&custom).map_err(native)?;
        ids.insert(item.id);
    }
    // Validate/build the complete replacement before touching the installed menu.
    let registry = app.state::<MenuRegistry>();
    let mut active = registry
        .0
        .lock()
        .map_err(|_| AppError::new("menu.lock_failed", "Menu registry unavailable"))?;
    app.set_menu(menu).map_err(native)?;
    *active = ids;
    Ok(())
}
/// The action ids currently in the native menu (empty before the front end sent any). Lets tests and the Windows
/// smoke prove the menu was built from the registry without seeing the menu bar.
#[tauri::command]
#[specta::specta]
pub fn menu_list(app: tauri::AppHandle) -> Result<Vec<String>, AppError> {
    let registry = app.state::<MenuRegistry>();
    let active = registry
        .0
        .lock()
        .map_err(|_| AppError::new("menu.lock_failed", "Menu registry unavailable"))?;
    Ok(active.iter().cloned().collect())
}

/// Called by Tauri's native menu event handler. OS predefined items are left to the OS.
pub fn on_action(app: &tauri::AppHandle, action: &str) {
    let Some(registry) = app.try_state::<MenuRegistry>() else {
        return;
    };
    let Ok(known) = registry.0.lock() else {
        return;
    };
    let Some(id) = routed(action, &known) else {
        return;
    };
    let id = id.to_owned();
    drop(known);
    if let Some(window) = app.webview_windows().values().find(|w| w.is_focused().unwrap_or(false))
        && let Err(error) = window.emit("menu:action", MenuAction { id })
    {
        tracing::warn!(%error,"could not deliver native menu action");
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_platform_modifiers_and_named_keys() {
        assert_eq!(accelerator("Mod+Shift+P", Platform::Mac).unwrap(), "Super+Shift+P");
        assert_eq!(accelerator("Mod+Shift+P", Platform::Windows).unwrap(), "Ctrl+Shift+P");
        assert_eq!(
            accelerator("Control+Option+Left", Platform::Mac).unwrap(),
            "Ctrl+Alt+ArrowLeft"
        );
        assert_eq!(
            accelerator("CmdOrCtrl++", Platform::Windows).unwrap(),
            "Ctrl+Shift+Equal"
        );
        assert_eq!(accelerator("Mod+,", Platform::Mac).unwrap(), "Super+,");
        assert_eq!(accelerator("Ctrl+F4", Platform::Windows).unwrap(), "Ctrl+F4");
        assert!(accelerator("Ctrl+K Ctrl+C", Platform::Windows).is_err());
        assert!(accelerator("Ctrl+NoSuchKey", Platform::Mac).is_err());
        assert!(accelerator("Ctrl+", Platform::Windows).is_err());
    }
    #[test]
    fn accelerator_table_is_identical_for_both_platforms_apart_from_mod() {
        let mac = [
            ("Mod+T", "Super+T"),
            ("Mod+Shift+N", "Super+Shift+N"),
            ("Mod+W", "Super+W"),
            ("Mod+,", "Super+,"),
            ("Mod+.", "Super+."),
            ("Mod+/", "Super+/"),
            ("Mod+`", "Super+`"),
            ("Mod+1", "Super+1"),
            ("Mod+9", "Super+9"),
            ("Mod+Enter", "Super+Enter"),
            ("Mod+Escape", "Super+Escape"),
            ("Mod+Backspace", "Super+Backspace"),
            ("Mod+Delete", "Super+Delete"),
            ("Mod+Tab", "Super+Tab"),
            ("Mod+Space", "Super+Space"),
            ("Mod+Home", "Super+Home"),
            ("Mod+End", "Super+End"),
            ("Mod+PageUp", "Super+PageUp"),
            ("Mod+PageDown", "Super+PageDown"),
            ("Mod+Insert", "Super+Insert"),
            ("Mod+ArrowDown", "Super+ArrowDown"),
            ("Alt+F4", "Alt+F4"),
            ("Shift+F12", "Shift+F12"),
            ("Ctrl+Shift+F24", "Ctrl+Shift+F24"),
            ("Mod+Shift+P", "Super+Shift+P"),
        ];
        for (binding, expected) in mac {
            assert_eq!(accelerator(binding, Platform::Mac).unwrap(), expected, "{binding}");
            let windows = expected.replacen("Super", "Ctrl", 1);
            assert_eq!(
                accelerator(binding, Platform::Windows).unwrap(),
                windows,
                "{binding} on Windows"
            );
        }
        for invalid in ["", "Mod+", "+", "Mod+F25", "Mod+KeyP", "Hyper+A", "Mod+K Ctrl+C"] {
            assert!(
                accelerator(invalid, Platform::Mac).is_err(),
                "{invalid:?} is not one chord"
            );
            assert!(
                accelerator(invalid, Platform::Windows).is_err(),
                "{invalid:?} is not one chord"
            );
        }
    }
    #[test]
    fn mnemonics_only_escape_on_windows() {
        assert_eq!(mnemonic("Save & Close", Platform::Windows), "Save && Close");
        assert_eq!(mnemonic("Save & Close", Platform::Mac), "Save & Close");
    }
    #[test]
    fn events_route_only_prefixed_installed_ids() {
        let known: BTreeSet<String> = ["tab.new".to_owned()].into_iter().collect();
        assert_eq!(routed("tessera.action.tab.new", &known), Some("tab.new"));
        assert_eq!(routed("tab.new", &known), None);
        assert_eq!(routed("tessera.action.edit.copy", &known), None);
        assert_eq!(routed("close", &known), None);
    }
    #[test]
    fn duplicates_and_invalid_labels_reject_the_whole_replacement() {
        let item = ActionMenuItem {
            id: "tab.new".into(),
            label: "New tab".into(),
            group: "File".into(),
            accelerator: Some("Mod+T".into()),
        };
        assert!(validate(std::slice::from_ref(&item)).is_ok());
        assert!(validate(&[item.clone(), item.clone()]).is_err());
        let mut bad = item;
        bad.label = "\n".into();
        assert!(validate(&[bad]).is_err());
        assert!(native_owned("terminal.copy"));
        assert!(!native_owned("tab.new"));
    }
}
