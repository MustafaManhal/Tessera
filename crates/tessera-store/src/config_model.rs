//! Configuration sections and defaults from backend schema section 5.1.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Values for Theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    /// Stable.
    Stable,
    /// Beta.
    Beta,
}

/// Values for TerminalEngine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TerminalEngine {
    /// Xterm.
    Xterm,
    /// Ghostty.
    Ghostty,
}

/// Values for CursorStyle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Osc52 {
    /// Off.
    Off,
    /// Ask.
    Ask,
    /// Allow.
    Allow,
}

/// One shortcut or several alternative shortcuts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum Keybinding {
    /// A single chord.
    Chord(String),
    /// Alternative chords.
    Chords(Vec<String>),
}

/// The [appearance] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct AppearanceConfig {
    /// Light colour theme.
    pub theme_light: String,
    /// Dark colour theme.
    pub theme_dark: String,
    /// Window opacity, from 0.0 to 1.0.
    #[schemars(range(min = 0, max = 1))]
    pub window_opacity: f64,
    /// Enable macOS vibrancy or Windows Mica.
    pub background_blur: bool,
    /// Interface scale, from 0.5 to 3.0.
    #[schemars(range(min = 0.5, max = 3))]
    pub ui_zoom: f64,
    /// Space between a terminal's text and its pane edge, in pixels (0 to 32).
    #[schemars(range(min = 0, max = 32))]
    pub padding: u32,
    /// How much panes without focus are dimmed, from 0.0 (not at all) to 0.6.
    #[schemars(range(min = 0.0, max = 0.6))]
    pub dim_unfocused: f64,
    /// Legacy system, light or dark preference; retained for compatibility.
    pub theme: Theme,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme_light: "GitHub Light".into(),
            theme_dark: "Tessera Night".into(),
            window_opacity: 1.0,
            background_blur: true,
            ui_zoom: 1.0,
            padding: 6,
            dim_unfocused: 0.0,
            theme: Theme::System,
            extra: BTreeMap::new(),
        }
    }
}

/// The [font] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct FontConfig {
    /// Terminal font family.
    pub family: String,
    /// Font size in logical pixels, from 6 to 72.
    #[schemars(range(min = 6, max = 72))]
    pub size: f64,
    /// Line height multiplier, from 0.5 to 3.0.
    #[schemars(range(min = 0.5, max = 3))]
    pub line_height: f64,
    /// Enable font ligatures.
    pub ligatures: bool,
    /// OpenType feature tags.
    pub features: Vec<String>,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for FontConfig {
    fn default() -> Self {
        Self {
            family: "JetBrains Mono".into(),
            size: 13.0,
            line_height: 1.2,
            ligatures: true,
            features: vec!["calt".into(), "ss01".into()],
            extra: BTreeMap::new(),
        }
    }
}

/// The [terminal] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct TerminalConfig {
    /// Terminal rendering engine.
    pub engine: TerminalEngine,
    /// Scrollback ring size, from 0 to 1000000 lines.
    #[serde(alias = "scrollback_lines")]
    #[schemars(range(min = 0, max = 1000000))]
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
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            engine: TerminalEngine::Xterm,
            scrollback: 10_000,
            copy_on_select: false,
            cursor_style: CursorStyle::Block,
            cursor_blink: true,
            confirm_multiline_paste: true,
            osc52: Osc52::Ask,
            shell_integration: true,
            keep_sessions_running: false,
            long_command_notify_seconds: 30,
            extra: BTreeMap::new(),
        }
    }
}

/// The [shell] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct ShellConfig {
    /// Default shell: auto, a path, a command or a WSL distro.
    pub default: String,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            default: "auto".into(),
            extra: BTreeMap::new(),
        }
    }
}

/// The [quick-terminal] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct QuickTerminalConfig {
    /// Enable the quick terminal.
    pub enabled: bool,
    /// Global quick terminal hotkey.
    pub hotkey: String,
    /// Fraction of screen height, greater than 0 and at most 1.
    #[schemars(range(min = 0, max = 1))]
    pub height: f64,
    /// Hide when focus leaves the quick terminal.
    pub hide_on_blur: bool,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for QuickTerminalConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hotkey: "Ctrl+`".into(),
            height: 0.4,
            hide_on_blur: true,
            extra: BTreeMap::new(),
        }
    }
}

/// The [worktrees] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct WorktreesConfig {
    /// Worktree folder, or auto for the sibling tessera-worktrees folder.
    pub dir: String,
    /// Prefix for task branches.
    pub branch_prefix: String,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for WorktreesConfig {
    fn default() -> Self {
        Self {
            dir: "auto".into(),
            branch_prefix: "tessera/".into(),
            extra: BTreeMap::new(),
        }
    }
}

/// The [notifications] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct NotificationsConfig {
    /// Notify when an agent needs input.
    pub agent_needs_input: bool,
    /// Notify when an agent finishes.
    pub agent_done: bool,
    /// Notify about CI results.
    pub ci: bool,
    /// Unix timestamp until which notifications are muted; zero disables DND.
    pub dnd_until: u32,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            agent_needs_input: true,
            agent_done: true,
            ci: true,
            dnd_until: 0,
            extra: BTreeMap::new(),
        }
    }
}

/// The [editor] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct EditorConfig {
    /// Editor command, optionally with path and line placeholders.
    pub command: String,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            command: "code".into(),
            extra: BTreeMap::new(),
        }
    }
}

/// The [keybindings] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct KeybindingsConfig {
    /// Shortcut for pane.splitRight.
    #[serde(rename = "pane.splitRight")]
    pub split_right: Keybinding,
    /// Shortcuts for palette.open.
    #[serde(rename = "palette.open")]
    pub palette_open: Keybinding,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for KeybindingsConfig {
    fn default() -> Self {
        Self {
            split_right: Keybinding::Chord("Cmd+D".into()),
            palette_open: Keybinding::Chords(vec!["Cmd+K".into(), "Cmd+Shift+P".into()]),
            extra: BTreeMap::new(),
        }
    }
}

/// The [api] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct ApiConfig {
    /// Enable the local API socket.
    pub socket: bool,
    /// Enable the MCP server.
    pub mcp_server: bool,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            socket: true,
            mcp_server: false,
            extra: BTreeMap::new(),
        }
    }
}

/// The [updates] section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct UpdatesConfig {
    /// Update channel.
    pub channel: UpdateChannel,
    /// Unknown keys retained for forward compatibility.
    #[serde(flatten)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, toml::Value>,
}

impl Default for UpdatesConfig {
    fn default() -> Self {
        Self {
            channel: UpdateChannel::Stable,
            extra: BTreeMap::new(),
        }
    }
}
