//! Source-preserving, tagged hook edits. Untagged JSON/TOML bytes are never serialized again.
mod codex;
mod files;
mod json;
pub use files::{HookFiles, WriteFailure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const START: &str = "# >>> tessera-managed >>>";
pub const END: &str = "# <<< tessera-managed <<<";
pub const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SessionEnd",
];
pub const GEMINI_EVENTS: &[&str] = &[
    "SessionStart",
    "BeforeAgent",
    "BeforeTool",
    "Notification",
    "AfterAgent",
    "SessionEnd",
];
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Claude,
    Codex,
    Gemini,
}
impl Kind {
    pub fn parse(kind: &str) -> Result<Self, HookError> {
        match kind {
            "claude-settings" => Ok(Self::Claude),
            "codex-config" => Ok(Self::Codex),
            "gemini-settings" => Ok(Self::Gemini),
            _ => Err(HookError::Unsupported),
        }
    }
    pub fn events(self) -> &'static [&'static str] {
        match self {
            Self::Claude => CLAUDE_EVENTS,
            Self::Gemini => GEMINI_EVENTS,
            Self::Codex => &["agent-turn-complete"],
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Installed,
    Outdated,
    None,
    Conflict,
    Unparseable,
}
impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Outdated => "outdated",
            Self::None => "none",
            Self::Conflict => "conflict",
            Self::Unparseable => "unparseable",
        }
    }
}
#[derive(Debug, Clone, Copy)]
pub enum Action {
    Install,
    Remove,
}
/// Creation provenance only; contains no user configuration text or credentials.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Ownership {
    pub created_file: bool,
    pub created_hooks: bool,
    pub created_events: BTreeSet<String>,
}
#[derive(Debug, Clone)]
pub struct Plan {
    pub state: State,
    pub after: String,
    pub diff: String,
    pub ownership: Ownership,
}
#[derive(Debug, thiserror::Error)]
pub enum HookError {
    #[error("This agent does not have a supported hook adapter.")]
    Unsupported,
    #[error("The existing notify program is owned by the user and was preserved: {0}.")]
    Conflict(String),
    #[error("The configuration could not be parsed at line {line}: {message}.")]
    Unparseable { line: usize, message: String },
    #[error("The hook files could not be updated: {0}.")]
    Io(String),
    #[error("The configuration changed during the operation; no replacement was made.")]
    Changed,
}
impl HookError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported => "hooks.unsupported",
            Self::Conflict(_) => "hooks.conflict",
            Self::Unparseable { .. } => "hooks.unparseable",
            Self::Io(_) => "hooks.write_failed",
            Self::Changed => "hooks.conflict",
        }
    }
}
impl From<std::io::Error> for HookError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}
pub fn state(kind: Kind, text: &str, cli: &str) -> State {
    match inspect(kind, text, cli) {
        Ok(state) => state,
        Err(HookError::Conflict(_)) => State::Conflict,
        Err(_) => State::Unparseable,
    }
}
fn inspect(kind: Kind, text: &str, cli: &str) -> Result<State, HookError> {
    match kind {
        Kind::Codex => codex::inspect(text, cli),
        _ => json::inspect(kind, text, cli),
    }
}
pub fn plan(kind: Kind, text: &str, cli: &str, action: Action, ownership: &Ownership) -> Result<Plan, HookError> {
    if cli.contains(['\0', '\n', '\r']) {
        return Err(HookError::Unsupported);
    }
    let before = inspect(kind, text, cli)?;
    let (mut after, ownership) = match kind {
        Kind::Codex => (codex::change(text, cli, action)?, ownership.clone()),
        _ => json::change(kind, text, cli, action, ownership)?,
    };
    if matches!(action, Action::Remove)
        && ownership.created_file
        && kind != Kind::Codex
        && serde_json::from_str::<serde_json::Value>(&after).is_ok_and(|v| v.as_object().is_some_and(|o| o.is_empty()))
    {
        after.clear();
    }
    let diff = unified_diff(text, &after);
    Ok(Plan {
        state: before,
        after,
        diff,
        ownership,
    })
}
/// Shell form is a quoted executable plus fixed event arguments. Codex uses direct argv instead.
fn windows_path(cli: &str) -> bool {
    cli.as_bytes().get(1) == Some(&b':') || cli.starts_with(r"\\")
}
fn command(cli: &str, event: &str) -> String {
    if windows_path(cli) {
        return format!("& '{}' hook {event}", cli.replace('\'', "''"));
    }
    // POSIX shell form; Windows uses PowerShell literal strings and its call operator.
    let escaped = cli
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "\\$")
        .replace('`', "\\`");
    format!("\"{escaped}\" hook {event}")
}
fn unified_diff(before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let old: Vec<_> = before.split_inclusive('\n').collect();
    let new: Vec<_> = after.split_inclusive('\n').collect();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let start = prefix.saturating_sub(3);
    let tail = suffix.min(3);
    let old_count = old.len() - suffix + tail - start;
    let new_count = new.len() - suffix + tail - start;
    let mut out = format!(
        "--- config\n+++ config\n@@ -{},{} +{},{} @@\n",
        if old_count == 0 { start } else { start + 1 },
        old_count,
        if new_count == 0 { start } else { start + 1 },
        new_count
    );
    let mut line = |prefix: char, value: &str| {
        out.push(prefix);
        out.push_str(value);
        if !value.ends_with('\n') {
            out.push_str("\n\\ No newline at end of file\n");
        }
    };
    for value in &old[start..prefix] {
        line(' ', value);
    }
    for value in &old[prefix..old.len() - suffix] {
        line('-', value);
    }
    for value in &new[prefix..new.len() - suffix] {
        line('+', value);
    }
    for value in &old[old.len() - suffix..old.len() - suffix + tail] {
        line(' ', value);
    }
    out
}

#[cfg(test)]
mod tests;
