//! Tolerant configuration parsing, validation and editor schema.

pub use crate::config_model::*;
use crate::error::ConfigError;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

/// Effective user configuration. Missing settings use the documented defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct Config {
    /// Appearance settings.
    pub appearance: AppearanceConfig,
    /// Font settings.
    pub font: FontConfig,
    /// Terminal settings.
    pub terminal: TerminalConfig,
    /// Shell settings.
    pub shell: ShellConfig,
    /// QuickTerminal settings.
    pub quick_terminal: QuickTerminalConfig,
    /// Worktrees settings.
    pub worktrees: WorktreesConfig,
    /// Notifications settings.
    pub notifications: NotificationsConfig,
    /// Editor settings.
    pub editor: EditorConfig,
    /// Keybindings settings.
    pub keybindings: KeybindingsConfig,
    /// Api settings.
    pub api: ApiConfig,
    /// Updates settings.
    pub updates: UpdatesConfig,
    /// Unknown top-level settings, preserved on load and save.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl<'de> Deserialize<'de> for Config {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Cross-section aliases cannot be expressed by a field-level serde alias.
        // Migrate the old terminal font setting before deserializing the sections.
        let mut table = toml::Table::deserialize(deserializer)?;
        migrate_font_alias(&mut table).map_err(serde::de::Error::custom)?;
        #[derive(Default, Deserialize)]
        #[serde(default, rename_all = "kebab-case")]
        struct Sections {
            /// Appearance settings.
            pub appearance: AppearanceConfig,
            /// Font settings.
            pub font: FontConfig,
            /// Terminal settings.
            pub terminal: TerminalConfig,
            /// Shell settings.
            pub shell: ShellConfig,
            /// QuickTerminal settings.
            pub quick_terminal: QuickTerminalConfig,
            /// Worktrees settings.
            pub worktrees: WorktreesConfig,
            /// Notifications settings.
            pub notifications: NotificationsConfig,
            /// Editor settings.
            pub editor: EditorConfig,
            /// Keybindings settings.
            pub keybindings: KeybindingsConfig,
            /// Api settings.
            pub api: ApiConfig,
            /// Updates settings.
            pub updates: UpdatesConfig,
            /// Unknown top-level settings, preserved on load and save.
            #[serde(flatten)]
            pub extra: BTreeMap<String, toml::Value>,
        }
        let sections: Sections = toml::Value::Table(table).try_into().map_err(serde::de::Error::custom)?;
        Ok(Self {
            appearance: sections.appearance,
            font: sections.font,
            terminal: sections.terminal,
            shell: sections.shell,
            quick_terminal: sections.quick_terminal,
            worktrees: sections.worktrees,
            notifications: sections.notifications,
            editor: sections.editor,
            keybindings: sections.keybindings,
            api: sections.api,
            updates: sections.updates,
            extra: sections.extra,
        })
    }
}

fn migrate_font_alias(table: &mut toml::Table) -> Result<(), String> {
    let old = table
        .get_mut("terminal")
        .and_then(toml::Value::as_table_mut)
        .and_then(|terminal| terminal.remove("font_size"));
    if let Some(old) = old {
        let font = table
            .entry("font")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut()
            .ok_or("font must be a table")?;
        if font.contains_key("size") {
            return Err("both terminal.font_size and font.size were specified".into());
        }
        font.insert("size".into(), old);
    }
    Ok(())
}

/// A warning about a preserved, unrecognised setting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigDiagnostic {
    /// Stable diagnostic code.
    pub code: String,
    /// One-based source line, when available.
    pub line: Option<usize>,
    /// Dotted setting name, when available.
    pub key: Option<String>,
    /// Short explanation.
    pub message: String,
    /// Closest known key, when the spelling is close enough.
    pub suggestion: Option<String>,
}

impl From<&ConfigError> for ConfigDiagnostic {
    fn from(error: &ConfigError) -> Self {
        Self {
            code: error.code().into(),
            line: error.line(),
            key: error.key().map(str::to_owned),
            message: error.to_string(),
            suggestion: None,
        }
    }
}

/// Loaded settings plus warnings; unknown keys do not invalidate a config.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedConfig {
    /// Effective settings.
    pub config: Config,
    /// Warnings for unknown settings, including spelling suggestions.
    pub warnings: Vec<ConfigDiagnostic>,
}

/// Loads a file, using defaults without creating a file when it is missing.
///
/// # Errors
/// Returns a located syntax/value error or a filesystem read error.
pub fn load_config(path: &Path) -> Result<Config, ConfigError> {
    parse_config(&read_config(path)?)
}

pub(crate) fn read_config(path: &Path) -> Result<String, ConfigError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(source) => Err(ConfigError::Read {
            path: path.into(),
            source,
        }),
    }
}

/// Parses and validates settings. Unknown values are retained and logged.
///
/// # Errors
/// Returns a syntax or validation error with its source line and key.
pub fn parse_config(text: &str) -> Result<Config, ConfigError> {
    parse_config_with_warnings(text).map(|parsed| parsed.config)
}

/// Parses settings and returns structured warnings for unknown keys.
///
/// # Errors
/// Returns a syntax or validation error with its source line and key.
pub fn parse_config_with_warnings(text: &str) -> Result<ParsedConfig, ConfigError> {
    let document = crate::config_document::Document::parse(text)?;
    let table: toml::Table = toml::from_str(text).map_err(|error| document.syntax_error(error))?;
    let defaults = toml::Value::try_from(Config::default()).map_err(|error| ConfigError::Invalid {
        line: 1,
        key: String::new(),
        message: error.to_string(),
    })?;
    let mut warnings = Vec::new();
    for (section, value) in &table {
        let Some(known) = defaults.get(section).and_then(toml::Value::as_table) else {
            warnings.push(unknown(
                &document,
                &[section],
                defaults.as_table().into_iter().flat_map(|v| v.keys()),
            ));
            continue;
        };
        let values = value
            .as_table()
            .ok_or_else(|| document.invalid(&[section], "expected a table"))?;
        for (key, value) in values {
            let alias = section == "terminal" && matches!(key.as_str(), "font_size" | "scrollback_lines");
            if !known.contains_key(key) && !alias {
                warnings.push(unknown(&document, &[section, key], known.keys()));
                continue;
            }
            // Deserialize each known leaf independently to retain the exact location on type/enum errors.
            let leaf = toml::Table::from_iter([(key.clone(), value.clone())]);
            let single = toml::Value::Table(toml::Table::from_iter([(section.clone(), toml::Value::Table(leaf))]));
            let _: Config = single
                .try_into()
                .map_err(|error: toml::de::Error| document.invalid(&[section, key], error.message()))?;
        }
    }
    if table.get("terminal").and_then(|v| v.get("font_size")).is_some()
        && table.get("font").and_then(|v| v.get("size")).is_some()
    {
        return Err(document.invalid(&["terminal", "font_size"], "also specified as font.size"));
    }
    if table.get("terminal").and_then(|v| v.get("scrollback_lines")).is_some()
        && table.get("terminal").and_then(|v| v.get("scrollback")).is_some()
    {
        return Err(document.invalid(
            &["terminal", "scrollback_lines"],
            "also specified as terminal.scrollback",
        ));
    }
    let config: Config =
        toml::Value::Table(table)
            .try_into()
            .map_err(|error: toml::de::Error| ConfigError::Invalid {
                line: 1,
                key: String::new(),
                message: error.message().into(),
            })?;
    let font_key = if document.value(&["terminal", "font_size"]).is_some() {
        ["terminal", "font_size"]
    } else {
        ["font", "size"]
    };
    let scrollback_key = if document.value(&["terminal", "scrollback_lines"]).is_some() {
        ["terminal", "scrollback_lines"]
    } else {
        ["terminal", "scrollback"]
    };
    for (key, value, min, max) in [
        (font_key, config.font.size, 6.0, 72.0),
        (scrollback_key, f64::from(config.terminal.scrollback), 0.0, 1_000_000.0),
        (
            ["appearance", "window-opacity"],
            config.appearance.window_opacity,
            0.0,
            1.0,
        ),
        (["appearance", "ui-zoom"], config.appearance.ui_zoom, 0.5, 3.0),
        (
            ["appearance", "padding"],
            f64::from(config.appearance.padding),
            0.0,
            32.0,
        ),
        (
            ["appearance", "dim-unfocused"],
            config.appearance.dim_unfocused,
            0.0,
            0.6,
        ),
        (["font", "line-height"], config.font.line_height, 0.5, 3.0),
        (
            ["quick-terminal", "height"],
            config.quick_terminal.height,
            f64::MIN_POSITIVE,
            1.0,
        ),
    ] {
        if !value.is_finite() || !(min..=max).contains(&value) {
            return Err(document.invalid(&key, format!("expected a finite number between {min} and {max}")));
        }
    }
    for warning in &warnings {
        tracing::warn!(key = ?warning.key, line = ?warning.line, suggestion = ?warning.suggestion, "unknown configuration key; kept but not used");
    }
    Ok(ParsedConfig { config, warnings })
}

fn unknown<'a>(
    document: &crate::config_document::Document<'_>,
    key: &[&str],
    known: impl Iterator<Item = &'a String>,
) -> ConfigDiagnostic {
    let name = key.last().copied().unwrap_or_default();
    let suggestion = suggest_key(name, known.map(String::as_str));
    let suggestion = suggestion.map(|suggestion| {
        let mut path = key[..key.len() - 1].to_vec();
        path.push(&suggestion);
        path.join(".")
    });
    ConfigDiagnostic {
        code: "config.unknown_key".into(),
        line: Some(document.line(key)),
        key: Some(key.join(".")),
        message: "unknown configuration key; kept but not used".into(),
        suggestion,
    }
}

/// Finds a nearby spelling (Unicode edit distance, at most two edits).
#[must_use]
pub fn suggest_key<'a>(key: &str, known: impl IntoIterator<Item = &'a str>) -> Option<String> {
    known
        .into_iter()
        .map(|candidate| (edit_distance(key, candidate), candidate))
        .filter(|(distance, _)| *distance <= 2)
        .min()
        .map(|(_, key)| key.to_owned())
}

fn edit_distance(left: &str, right: &str) -> usize {
    let right: Vec<char> = right.chars().collect();
    let mut row: Vec<usize> = (0..=right.len()).collect();
    for (i, a) in left.chars().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, b) in right.iter().enumerate() {
            let old = row[j + 1];
            row[j + 1] = (row[j] + 1).min(old + 1).min(diagonal + usize::from(a != *b));
            diagonal = old;
        }
    }
    row[right.len()]
}

/// Pretty JSON Schema for editor completion, including defaults and validation bounds.
#[must_use]
pub fn config_json_schema() -> String {
    let schema = schemars::schema_for!(Config);
    schemars::_private::serde_json::to_string_pretty(&schema).expect("a JSON Schema always serialises to JSON")
}
