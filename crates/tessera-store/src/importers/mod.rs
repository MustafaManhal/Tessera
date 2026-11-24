//! First-run settings importers (FR-66, S-14): pure parsers for Ghostty, iTerm2 and Windows Terminal
//! configuration. Each returns the settings it could map onto `config.toml` keys plus a per-item
//! "could not import" list; nothing here touches disk or the user's real files — callers pass text.

use serde::Serialize;

/// One setting the importer could apply, as a `config.toml` patch entry.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportedItem {
    /// Dotted config path, e.g. `font.family`.
    pub key: String,
    /// TOML value to write.
    pub value: toml::Value,
    /// What the user sees in the preview ("Font family: JetBrains Mono").
    pub label: String,
}

/// One item that could not be imported, with the reason shown to the user.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportFailure {
    /// The source item ("theme", "keybinds", "colours").
    pub item: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImportResult {
    pub applied: Vec<ImportedItem>,
    pub failed: Vec<ImportFailure>,
}

fn item(key: &str, value: toml::Value, label: String) -> ImportedItem {
    ImportedItem {
        key: key.into(),
        value,
        label,
    }
}

fn fail(item: &str, reason: impl Into<String>) -> ImportFailure {
    ImportFailure {
        item: item.into(),
        reason: reason.into(),
    }
}

// -- Ghostty (`~/.config/ghostty/config`) ------------------------------------------------------------

/// `key = value` lines; `#` comments and blank lines ignored. Maps font-family/font-size; theme names
/// and keybinds cannot map onto Tessera's theme/keybinding model and are reported per item.
pub fn parse_ghostty(text: &str) -> ImportResult {
    let mut result = ImportResult::default();
    let mut seen_theme = false;
    let mut seen_keybind = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            result.failed.push(fail("line", format!("could not parse `{line}`")));
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        match key {
            "font-family" if !value.is_empty() => {
                result.applied.push(item(
                    "font.family",
                    toml::Value::String(value.into()),
                    format!("Font family: {value}"),
                ));
            }
            "font-size" => match value.parse::<f64>() {
                Ok(size) if (6.0..=72.0).contains(&size) => {
                    result.applied.push(item(
                        "font.size",
                        toml::Value::Float(size),
                        format!("Font size: {size}"),
                    ));
                }
                _ => result
                    .failed
                    .push(fail("font-size", format!("`{value}` is not a size from 6 to 72"))),
            },
            "theme" => seen_theme = true,
            "keybind" => seen_keybind = true,
            _ => {}
        }
    }
    if seen_theme {
        result.failed.push(fail(
            "theme",
            "Ghostty themes are not Tessera colour schemes; pick one in Appearance",
        ));
    }
    if seen_keybind {
        result
            .failed
            .push(fail("keybinds", "Ghostty keybinds do not map onto Tessera actions"));
    }
    result
}

// -- iTerm2 (`~/Library/Preferences/com.googlecode.iterm2.plist`) -------------------------------------

/// iTerm2 stores an `NSKeyedArchiver` plist; the "Normal" profile's font appears as a `Normal Font`
/// string like `"JetBrainsMonoNF-Regular 14.0"`. Colours live in keyed archives we cannot map safely,
/// so they are reported rather than guessed.
pub fn parse_iterm2(text: &str) -> ImportResult {
    let mut result = ImportResult::default();
    // "Normal Font" = "Family Name size" — the archiver quotes both the key and the value.
    let mut found_font = false;
    for needle in ["\"Normal Font\"", "Normal Font ="] {
        if let Some(pos) = text.find(needle) {
            let rest = &text[pos..];
            // Find `= "..."` after the key.
            if let Some(eq) = rest.find('=') {
                let tail = rest[eq + 1..].trim_start();
                if let Some(end) = tail.find('"') {
                    let inner_start = end + 1;
                    if let Some(close) = tail[inner_start..].find('"') {
                        let raw = &tail[inner_start..inner_start + close];
                        if let Some((family, size)) = raw.rsplit_once(' ') {
                            let size_num = size
                                .trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.')
                                .parse::<f64>()
                                .ok();
                            if !family.is_empty() {
                                result.applied.push(item(
                                    "font.family",
                                    toml::Value::String(family.into()),
                                    format!("Font family: {family}"),
                                ));
                                found_font = true;
                            }
                            if let Some(size) = size_num.filter(|s| (6.0..=72.0).contains(s)) {
                                result.applied.push(item(
                                    "font.size",
                                    toml::Value::Float(size),
                                    format!("Font size: {size}"),
                                ));
                            }
                        }
                    }
                }
            }
            break;
        }
    }
    let _ = found_font;
    if result.applied.is_empty() {
        result
            .failed
            .push(fail("profile", "no readable 'Normal' profile font found"));
    }
    result
        .failed
        .push(fail("colours", "iTerm2 colour profiles are not Tessera colour schemes"));
    result
        .failed
        .push(fail("keys", "iTerm2 keybindings do not map onto Tessera actions"));
    result
}

// -- Windows Terminal (`settings.json`) --------------------------------------------------------------

/// `profiles.defaults.font.face`/`size` map directly; `colorScheme` names a Windows Terminal scheme,
/// not a Tessera theme, and `actions`/`keybindings` do not map.
pub fn parse_windows_terminal(text: &str) -> ImportResult {
    let mut result = ImportResult::default();
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        result.failed.push(fail("file", "settings.json is not valid JSON"));
        return result;
    };
    let defaults = json
        .pointer("/profiles/defaults")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let font = defaults.get("font").cloned().unwrap_or(serde_json::Value::Null);
    if let Some(face) = font.get("face").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        result.applied.push(item(
            "font.family",
            toml::Value::String(face.into()),
            format!("Font family: {face}"),
        ));
    }
    if let Some(size) = font
        .get("size")
        .and_then(|v| v.as_f64())
        .filter(|s| (6.0..=72.0).contains(s))
    {
        result.applied.push(item(
            "font.size",
            toml::Value::Float(size),
            format!("Font size: {size}"),
        ));
    }
    if font.get("face").is_none() && font.get("size").is_none() {
        result
            .failed
            .push(fail("font", "no font settings under profiles.defaults"));
    }
    if json
        .pointer("/profiles/defaults/colorScheme")
        .and_then(|v| v.as_str())
        .is_some()
        || json.pointer("/schemes").is_some()
    {
        result.failed.push(fail(
            "colour scheme",
            "Windows Terminal schemes are not Tessera colour schemes",
        ));
    }
    if json
        .get("actions")
        .and_then(|v| v.as_array())
        .is_some_and(|a| !a.is_empty())
    {
        result.failed.push(fail(
            "keybindings",
            "Windows Terminal actions do not map onto Tessera actions",
        ));
    }
    result
}

// -- Detection paths -----------------------------------------------------------------------------------

/// The Ghostty config path on this OS, when the app looks installed.
pub fn ghostty_config_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let path = if cfg!(windows) {
        // Ghostty on Windows uses %APPDATA%\ghostty\config.
        std::env::var_os("APPDATA").map(|a| std::path::PathBuf::from(a).join("ghostty").join("config"))?
    } else {
        std::path::PathBuf::from(home)
            .join(".config")
            .join("ghostty")
            .join("config")
    };
    path.is_file().then_some(path)
}

/// The iTerm2 plist on macOS (the only OS iTerm2 ships on).
pub fn iterm2_plist_path() -> Option<std::path::PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    let path = std::path::PathBuf::from(home)
        .join("Library")
        .join("Preferences")
        .join("com.googlecode.iterm2.plist");
    path.is_file().then_some(path)
}

/// Windows Terminal `settings.json` under `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_*\LocalState`.
pub fn windows_terminal_settings_path() -> Option<std::path::PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let local = std::env::var_os("LOCALAPPDATA")?;
    let packages = std::path::PathBuf::from(local).join("Packages");
    let entries = std::fs::read_dir(&packages).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("Microsoft.WindowsTerminal") {
            let candidate = entry.path().join("LocalState").join("settings.json");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ghostty_maps_font_and_reports_theme_and_keybinds() {
        let text = "# config\nfont-family = \"JetBrainsMono Nerd Font\"\nfont-size = 14\ntheme = dark:\"Catppuccin Mocha\"\nkeybind = ctrl+shift+t=new_tab\nunknown-key = x\n";
        let result = parse_ghostty(text);
        assert_eq!(result.applied.len(), 2);
        assert_eq!(result.applied[0].key, "font.family");
        assert_eq!(result.applied[1].key, "font.size");
        assert_eq!(result.applied[1].value, toml::Value::Float(14.0));
        let items: Vec<&str> = result.failed.iter().map(|f| f.item.as_str()).collect();
        assert!(items.contains(&"theme") && items.contains(&"keybinds"));
    }

    #[test]
    fn ghostty_rejects_bad_size_and_empty() {
        let result = parse_ghostty("font-size = 3\nfont-family = \n");
        assert!(result.applied.is_empty());
        assert!(result.failed.iter().any(|f| f.item == "font-size"));
    }

    #[test]
    fn iterm2_extracts_normal_font() {
        let text =
            "{\"$objects\":[\"x\",{\"Normal Font\"=\"JetBrainsMonoNF-Regular 14.0\"},{\"Background Color\"=\"...\"}]}";
        let result = parse_iterm2(text);
        assert!(
            result
                .applied
                .iter()
                .any(|i| i.key == "font.family" && i.label.contains("JetBrainsMonoNF-Regular"))
        );
        assert!(result.applied.iter().any(|i| i.key == "font.size"));
        assert!(result.failed.iter().any(|f| f.item == "colours"));
    }

    #[test]
    fn iterm2_without_font_reports() {
        let result = parse_iterm2("{\"nothing\":true}");
        assert!(result.applied.is_empty());
        assert!(result.failed.iter().any(|f| f.item == "profile"));
    }

    #[test]
    fn windows_terminal_maps_font_and_reports_scheme_and_keys() {
        let text = r#"{"profiles":{"defaults":{"font":{"face":"Cascadia Code","size":12},"colorScheme":"One Half Dark"}},"actions":[{"command":"newTab"}],"unicode" :"héllo"}"#;
        let result = parse_windows_terminal(text);
        assert_eq!(result.applied.len(), 2);
        assert_eq!(result.applied[0].key, "font.family");
        let items: Vec<&str> = result.failed.iter().map(|f| f.item.as_str()).collect();
        assert!(items.contains(&"colour scheme") && items.contains(&"keybindings"));
    }

    #[test]
    fn windows_terminal_malformed_json() {
        let result = parse_windows_terminal("{not json");
        assert!(result.applied.is_empty());
        assert_eq!(result.failed[0].item, "file");
    }
}
