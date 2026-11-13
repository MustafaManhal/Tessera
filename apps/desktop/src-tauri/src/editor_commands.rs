//! Open a file or a worktree in the user's editor, and reveal it in the file manager (M5.4, FR-53).
//!
//! The editor comes from `editor.command` in `config.toml`: a preset name (`code`, `cursor`, `zed`, `subl`, `idea`,
//! `webstorm`, `pycharm`, `goland`, `rustrover`, `clion`) or a custom template such as `subl {path}:{line}`. The
//! command is split into words by [`split_words`] and started directly, never through a shell, so a path with spaces
//! or quotes cannot inject anything.
use crate::{error::AppError, settings_commands::Settings};
use std::{
    path::Path,
    process::{Command, Stdio},
};
use tessera_git::NoWindow as _;

/// A program and its arguments, ready to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorPlan {
    /// The executable name or path.
    pub program: String,
    /// The arguments, one per element.
    pub args: Vec<String>,
}

/// Why an editor command could not be planned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorError {
    /// The path is empty or holds a NUL byte.
    BadPath,
    /// The configured command is empty.
    NoEditor,
    /// A quote was never closed in the custom command.
    UnclosedQuote,
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::BadPath => "the path is empty or not valid",
            Self::NoEditor => "no editor is configured",
            Self::UnclosedQuote => "the editor command has an unclosed quote",
        })
    }
}

impl std::error::Error for EditorError {}

impl EditorError {
    /// Stable error code for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadPath => "editor.bad_path",
            Self::NoEditor => "editor.not_configured",
            Self::UnclosedQuote => "editor.bad_command",
        }
    }
}

/// Splits a command line into words. Single and double quotes group words; there is no escaping and no expansion.
pub fn split_words(text: &str) -> Result<Vec<String>, EditorError> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for ch in text.chars() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => current.push(c),
            (None, '"' | '\'') => {
                quote = Some(ch);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started || !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            (None, c) => current.push(c),
        }
    }
    if quote.is_some() {
        return Err(EditorError::UnclosedQuote);
    }
    if started || !current.is_empty() {
        words.push(current);
    }
    Ok(words)
}

fn location(path: &str, line: Option<u32>, column: Option<u32>) -> String {
    match (line, column) {
        (Some(l), Some(c)) => format!("{path}:{l}:{c}"),
        (Some(l), None) => format!("{path}:{l}"),
        _ => path.to_string(),
    }
}

fn fill(word: &str, path: &str, line: Option<u32>, column: Option<u32>) -> String {
    word.replace("{path}", path)
        .replace("{line}", &line.unwrap_or(1).to_string())
        .replace("{column}", &column.unwrap_or(1).to_string())
}

/// Plans the command for `editor` (a preset or a custom template) to open `path` at an optional line and column.
pub fn plan_editor(
    editor: &str,
    path: &str,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<EditorPlan, EditorError> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(EditorError::BadPath);
    }
    let editor = editor.trim();
    if editor.is_empty() {
        return Err(EditorError::NoEditor);
    }
    let preset = editor.to_ascii_lowercase();
    let plan = |program: &str, args: Vec<String>| EditorPlan {
        program: program.to_string(),
        args,
    };
    Ok(match preset.as_str() {
        "code" | "code-insiders" | "vscode" => plan(
            if preset == "vscode" { "code" } else { &preset },
            vec!["-g".into(), location(path, line, column)],
        ),
        "cursor" | "windsurf" => plan(&preset, vec!["-g".into(), location(path, line, column)]),
        "zed" | "subl" | "sublime" | "mate" => plan(
            if preset == "sublime" { "subl" } else { &preset },
            vec![location(path, line, column)],
        ),
        "idea" | "webstorm" | "pycharm" | "goland" | "rustrover" | "clion" | "phpstorm" | "rider" => {
            let mut args = Vec::new();
            if let Some(l) = line {
                args.push("--line".into());
                args.push(l.to_string());
                if let Some(c) = column {
                    args.push("--column".into());
                    args.push(c.to_string());
                }
            }
            args.push(path.to_string());
            plan(&preset, args)
        }
        _ => {
            let words = split_words(editor)?;
            let Some((program, rest)) = words.split_first() else {
                return Err(EditorError::NoEditor);
            };
            let has_path = words.iter().any(|w| w.contains("{path}"));
            let mut args: Vec<String> = rest.iter().map(|w| fill(w, path, line, column)).collect();
            if !has_path {
                args.push(path.to_string());
            }
            plan(program, args)
        }
    })
}

fn editor_error(error: EditorError) -> AppError {
    AppError::new(error.code(), error.to_string())
}

/// Folders GUI apps on macOS do not have on `PATH` but editors usually install their command line tool into.
#[cfg(target_os = "macos")]
fn path_with_common_tools() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    if let Ok(home) = std::env::var("HOME") {
        parts.push(format!("{home}/.local/bin"));
    }
    parts.push("/Applications/Visual Studio Code.app/Contents/Resources/app/bin".into());
    parts.push("/Applications/Cursor.app/Contents/Resources/app/bin".into());
    parts.push("/Applications/Zed.app/Contents/MacOS".into());
    if !current.is_empty() {
        parts.push(current);
    }
    parts.join(":")
}

#[cfg(not(target_os = "macos"))]
fn path_with_common_tools() -> String {
    std::env::var("PATH").unwrap_or_default()
}

fn start(plan: &EditorPlan) -> Result<(), AppError> {
    let mut command = Command::new(&plan.program);
    command
        .no_window()
        .args(&plan.args)
        .env("PATH", path_with_common_tools())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match command.spawn() {
        Ok(mut child) => {
            // Reap it in the background so no zombie stays behind; the editor keeps running on its own.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(AppError::new(
            "editor.not_found",
            format!("The editor command `{}` was not found on this computer.", plan.program),
        )),
        Err(error) => Err(AppError::new(
            "editor.start_failed",
            format!("The editor could not be started: {error}"),
        )),
    }
}

/// Opens `path` (a file or a folder) in the configured editor at an optional line and column.
#[tauri::command]
#[specta::specta]
pub fn open_in_editor(
    settings: tauri::State<'_, Settings>,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), AppError> {
    let config = crate::settings_commands::settings_get(settings)?;
    let plan = plan_editor(&config.editor.command, &path, line, column).map_err(editor_error)?;
    tracing::info!(program = %plan.program, "opening a path in the editor");
    start(&plan)
}

/// Shows `path` in the system file manager (Finder, Explorer, or the folder's file manager).
#[tauri::command]
#[specta::specta]
pub fn reveal_in_files(path: String) -> Result<(), AppError> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(editor_error(EditorError::BadPath));
    }
    let target = Path::new(&path);
    let plan = if cfg!(target_os = "macos") {
        EditorPlan {
            program: "open".into(),
            args: vec![if target.is_dir() { "".into() } else { "-R".into() }, path.clone()]
                .into_iter()
                .filter(|a: &String| !a.is_empty())
                .collect(),
        }
    } else if cfg!(windows) {
        EditorPlan {
            program: "explorer".into(),
            args: vec![if target.is_dir() {
                path.clone()
            } else {
                format!("/select,{path}")
            }],
        }
    } else {
        EditorPlan {
            program: "xdg-open".into(),
            args: vec![if target.is_dir() {
                path.clone()
            } else {
                target.parent().map_or(path.clone(), |p| p.display().to_string())
            }],
        }
    };
    start(&plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(editor: &str, line: Option<u32>, column: Option<u32>) -> EditorPlan {
        plan_editor(editor, "/work/my app/src/main.rs", line, column).expect("plan")
    }

    #[test]
    fn vscode_and_cursor_use_goto() {
        assert_eq!(
            plan("code", Some(12), Some(3)),
            EditorPlan {
                program: "code".into(),
                args: vec!["-g".into(), "/work/my app/src/main.rs:12:3".into()]
            }
        );
        assert_eq!(plan("Cursor", None, None).args, vec!["-g", "/work/my app/src/main.rs"]);
        assert_eq!(plan("vscode", Some(1), None).program, "code");
    }

    #[test]
    fn zed_and_sublime_append_line_and_column() {
        assert_eq!(plan("zed", Some(9), None).args, vec!["/work/my app/src/main.rs:9"]);
        assert_eq!(plan("sublime", Some(9), Some(2)).program, "subl");
    }

    #[test]
    fn jetbrains_uses_line_and_column_flags() {
        assert_eq!(
            plan("idea", Some(5), Some(7)).args,
            vec!["--line", "5", "--column", "7", "/work/my app/src/main.rs"]
        );
        assert_eq!(plan("idea", None, None).args, vec!["/work/my app/src/main.rs"]);
    }

    #[test]
    fn custom_templates_fill_placeholders_without_a_shell() {
        let p = plan("myedit --goto {path}:{line}:{column}", Some(4), Some(2));
        assert_eq!(p.program, "myedit");
        assert_eq!(p.args, vec!["--goto", "/work/my app/src/main.rs:4:2"]);
        // No `{path}`: the path is appended as one argument, spaces intact.
        let p = plan("nvim-qt --remote", None, None);
        assert_eq!(p.args, vec!["--remote", "/work/my app/src/main.rs"]);
        // Defaults when the line is unknown.
        assert_eq!(
            plan("ed {path} {line}", None, None).args,
            vec!["/work/my app/src/main.rs", "1"]
        );
    }

    #[test]
    fn quotes_group_words_and_unclosed_quotes_fail() {
        assert_eq!(
            split_words(r#""C:\Program Files\Ed\ed.exe" --open '{path}'"#).unwrap(),
            vec![r"C:\Program Files\Ed\ed.exe", "--open", "{path}"]
        );
        assert_eq!(split_words("a '' b").unwrap(), vec!["a", "", "b"]);
        assert_eq!(split_words("a 'b").unwrap_err(), EditorError::UnclosedQuote);
        assert!(split_words("   ").unwrap().is_empty());
    }

    #[test]
    fn bad_input_is_refused() {
        assert_eq!(plan_editor("code", "", None, None).unwrap_err(), EditorError::BadPath);
        assert_eq!(
            plan_editor("code", "a\0b", None, None).unwrap_err(),
            EditorError::BadPath
        );
        assert_eq!(plan_editor("  ", "/x", None, None).unwrap_err(), EditorError::NoEditor);
        assert_eq!(
            plan_editor("a 'b", "/x", None, None).unwrap_err(),
            EditorError::UnclosedQuote
        );
        assert_eq!(EditorError::NoEditor.code(), "editor.not_configured");
    }

    #[cfg(unix)]
    #[test]
    fn a_real_program_starts_and_is_reaped() {
        // `true` ignores its arguments and exits at once: starting it must succeed.
        assert!(
            start(&EditorPlan {
                program: "true".into(),
                args: vec!["-g".into(), "/tmp/x:1".into()],
            })
            .is_ok()
        );
    }

    #[test]
    fn a_missing_program_reports_not_found() {
        let error = start(&EditorPlan {
            program: "tessera-no-such-editor-xyz".into(),
            args: vec![],
        })
        .unwrap_err();
        assert_eq!(error.code, "editor.not_found");
    }
}
