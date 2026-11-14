//! Typed IPC settings and patches. Conversion tests keep these in step with the store schema.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// A TOML-compatible JSON value for unknown forward-compatible settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum ConfigValue {
    /// Boolean.
    Bool(bool),
    /// Integer (JSON numbers have limited precision in JavaScript).
    Integer(#[specta(type = f64)] i64),
    /// Fractional number.
    Number(f64),
    /// JSON representation of a nonfinite unknown TOML float.
    Null(()),
    /// String (including TOML dates).
    String(String),
    /// Array.
    Array(Vec<ConfigValue>),
    /// Table.
    Table(BTreeMap<String, ConfigValue>),
}

/// Values for Theme.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// System.
    System,
    /// Light.
    Light,
    /// Dark.
    Dark,
}

/// Values for UpdateChannel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    /// Stable.
    Stable,
    /// Beta.
    Beta,
}

/// Values for TerminalEngine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TerminalEngine {
    /// Xterm.
    Xterm,
    /// Ghostty.
    Ghostty,
}

/// Values for CursorStyle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    /// Block.
    Block,
    /// Bar.
    Bar,
    /// Underline.
    Underline,
}

/// Values for Osc52.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Osc52 {
    /// Off.
    Off,
    /// Ask.
    Ask,
    /// Allow.
    Allow,
}

/// One shortcut or alternatives.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum Keybinding {
    /// A single chord.
    Chord(String),
    /// Alternative chords.
    Chords(Vec<String>),
}

/// Complete effective settings, including retained unknown keys.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
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
    /// Unknown top-level keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Appearance settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct AppearanceConfig {
    /// Light colour theme.
    pub theme_light: String,
    /// Dark colour theme.
    pub theme_dark: String,
    /// Window opacity, from 0.0 to 1.0.
    pub window_opacity: f64,
    /// Enable macOS vibrancy or Windows Mica.
    pub background_blur: bool,
    /// Interface scale, from 0.5 to 3.0.
    pub ui_zoom: f64,
    /// Space between a terminal's text and its pane edge, in pixels (0 to 32).
    pub padding: u32,
    /// How much panes without focus are dimmed, from 0.0 (not at all) to 0.6.
    pub dim_unfocused: f64,
    /// Legacy system, light or dark preference; retained for compatibility.
    pub theme: Theme,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Font settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct FontConfig {
    /// Terminal font family.
    pub family: String,
    /// Font size in logical pixels, from 6 to 72.
    pub size: f64,
    /// Line height multiplier, from 0.5 to 3.0.
    pub line_height: f64,
    /// Enable font ligatures.
    pub ligatures: bool,
    /// OpenType feature tags.
    pub features: Vec<String>,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Terminal settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct TerminalConfig {
    /// Terminal rendering engine.
    pub engine: TerminalEngine,
    /// Scrollback ring size, from 0 to 1000000 lines.
    #[serde(alias = "scrollback_lines")]
    pub scrollback: u32,
    /// Copy selected text automatically.
    pub copy_on_select: bool,
    /// Terminal cursor shape.
    pub cursor_style: CursorStyle,
    /// Blink the terminal cursor.
    pub cursor_blink: bool,
    /// Confirm before pasting multiple lines.
    pub confirm_multiline_paste: bool,
    /// OSC 52 clipboard write permission.
    pub osc52: Osc52,
    /// Inject shell integration for prompts and working directories.
    pub shell_integration: bool,
    /// Keep shells and agents running in the background after Tessera quits. Off: quitting ends them.
    pub keep_sessions_running: bool,
    /// Notify when commands exceed this duration in seconds.
    pub long_command_notify_seconds: u32,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Shell settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct ShellConfig {
    /// Default shell: auto, a path, a command or a WSL distro.
    pub default: String,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// QuickTerminal settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct QuickTerminalConfig {
    /// Enable the quick terminal.
    pub enabled: bool,
    /// Global quick terminal hotkey.
    pub hotkey: String,
    /// Fraction of screen height, greater than 0 and at most 1.
    pub height: f64,
    /// Hide when focus leaves the quick terminal.
    pub hide_on_blur: bool,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Worktrees settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct WorktreesConfig {
    /// Worktree folder, or auto for the sibling tessera-worktrees folder.
    pub dir: String,
    /// Prefix for task branches.
    pub branch_prefix: String,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Notifications settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct NotificationsConfig {
    /// Notify when an agent needs input.
    pub agent_needs_input: bool,
    /// Notify when an agent finishes.
    pub agent_done: bool,
    /// Notify about CI results.
    pub ci: bool,
    /// Unix timestamp until which notifications are muted; zero disables DND.
    pub dnd_until: u32,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Editor settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct EditorConfig {
    /// Editor command, optionally with path and line placeholders.
    pub command: String,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Keybindings settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct KeybindingsConfig {
    /// Shortcut for pane.splitRight.
    #[serde(rename = "pane.splitRight")]
    pub split_right: Keybinding,
    /// Shortcuts for palette.open.
    #[serde(rename = "palette.open")]
    pub palette_open: Keybinding,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Api settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct ApiConfig {
    /// Enable the local API socket.
    pub socket: bool,
    /// Enable the MCP server.
    pub mcp_server: bool,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Updates settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub struct UpdatesConfig {
    /// Update channel.
    pub channel: UpdateChannel,
    /// Unknown section keys.
    #[serde(flatten)]
    pub extra: BTreeMap<String, ConfigValue>,
}

/// Partial settings update; omitted fields are unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct SettingsPatch {
    /// Appearance settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearancePatch>,
    /// Font settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<FontPatch>,
    /// Terminal settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalPatch>,
    /// Shell settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<ShellPatch>,
    /// QuickTerminal settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_terminal: Option<QuickTerminalPatch>,
    /// Worktrees settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktrees: Option<WorktreesPatch>,
    /// Notifications settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationsPatch>,
    /// Editor settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor: Option<EditorPatch>,
    /// Keybindings settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keybindings: Option<KeybindingsPatch>,
    /// Api settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<ApiPatch>,
    /// Updates settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updates: Option<UpdatesPatch>,
}

/// Appearance patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct AppearancePatch {
    /// Light colour theme.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_light: Option<String>,
    /// Dark colour theme.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_dark: Option<String>,
    /// Window opacity, from 0.0 to 1.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_opacity: Option<f64>,
    /// Enable macOS vibrancy or Windows Mica.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_blur: Option<bool>,
    /// Interface scale, from 0.5 to 3.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_zoom: Option<f64>,
    /// Space between a terminal's text and its pane edge, in pixels (0 to 32).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<u32>,
    /// How much panes without focus are dimmed, from 0.0 to 0.6.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dim_unfocused: Option<f64>,
    /// Legacy system, light or dark preference; retained for compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<Theme>,
}

/// Font patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct FontPatch {
    /// Terminal font family.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// Font size in logical pixels, from 6 to 72.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    /// Line height multiplier, from 0.5 to 3.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    /// Enable font ligatures.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ligatures: Option<bool>,
    /// OpenType feature tags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub features: Option<Vec<String>>,
}

/// Terminal patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct TerminalPatch {
    /// Terminal rendering engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<TerminalEngine>,
    /// Scrollback ring size, from 0 to 1000000 lines.
    #[serde(alias = "scrollback_lines")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scrollback: Option<u32>,
    /// Copy selected text automatically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy_on_select: Option<bool>,
    /// Terminal cursor shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_style: Option<CursorStyle>,
    /// Blink the terminal cursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    /// Confirm before pasting multiple lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_multiline_paste: Option<bool>,
    /// OSC 52 clipboard write permission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub osc52: Option<Osc52>,
    /// Inject shell integration for prompts and working directories.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_integration: Option<bool>,
    /// Keep shells and agents running in the background after Tessera quits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_sessions_running: Option<bool>,
    /// Notify when commands exceed this duration in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_command_notify_seconds: Option<u32>,
}

/// Shell patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct ShellPatch {
    /// Default shell: auto, a path, a command or a WSL distro.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// QuickTerminal patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct QuickTerminalPatch {
    /// Enable the quick terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Global quick terminal hotkey.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<String>,
    /// Fraction of screen height, greater than 0 and at most 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    /// Hide when focus leaves the quick terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_on_blur: Option<bool>,
}

/// Worktrees patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct WorktreesPatch {
    /// Worktree folder, or auto for the sibling tessera-worktrees folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// Prefix for task branches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_prefix: Option<String>,
}

/// Notifications patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct NotificationsPatch {
    /// Notify when an agent needs input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_needs_input: Option<bool>,
    /// Notify when an agent finishes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_done: Option<bool>,
    /// Notify about CI results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ci: Option<bool>,
    /// Unix timestamp until which notifications are muted; zero disables DND.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dnd_until: Option<u32>,
}

/// Editor patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct EditorPatch {
    /// Editor command, optionally with path and line placeholders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/// Keybindings patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct KeybindingsPatch {
    /// Shortcut for pane.splitRight.
    #[serde(rename = "pane.splitRight")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_right: Option<Keybinding>,
    /// Shortcuts for palette.open.
    #[serde(rename = "palette.open")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette_open: Option<Keybinding>,
}

/// Api patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct ApiPatch {
    /// Enable the local API socket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<bool>,
    /// Enable the MCP server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_server: Option<bool>,
}

/// Updates patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct UpdatesPatch {
    /// Update channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<UpdateChannel>,
}
