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
    if let Ok(home) = std::env::var("HOME") {
        // Editors that install their command line tools below the home folder.
        parts.push(format!("{home}/.antigravity-ide/antigravity-ide/bin"));
        parts.push(format!("{home}/.antigravity/antigravity/bin"));
    }
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

/// An editor Tessera knows how to open a folder in.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct EditorOption {
    /// The preset name stored in `editor.command` (`code`, `cursor`, ...).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Found on this computer.
    pub installed: bool,
}

/// Preset, display name and the macOS application bundle.
const EDITORS: &[(&str, &str, &str)] = &[
    ("code", "Visual Studio Code", "Visual Studio Code.app"),
    ("cursor", "Cursor", "Cursor.app"),
    ("windsurf", "Windsurf", "Windsurf.app"),
    ("zed", "Zed", "Zed.app"),
    ("subl", "Sublime Text", "Sublime Text.app"),
    ("idea", "IntelliJ IDEA", "IntelliJ IDEA.app"),
    ("webstorm", "WebStorm", "WebStorm.app"),
    ("pycharm", "PyCharm", "PyCharm.app"),
    ("goland", "GoLand", "GoLand.app"),
    ("rustrover", "RustRover", "RustRover.app"),
    ("clion", "CLion", "CLion.app"),
    ("phpstorm", "PhpStorm", "PhpStorm.app"),
    ("rider", "Rider", "Rider.app"),
    ("agy-ide", "Antigravity IDE", "Antigravity IDE.app"),
    ("antigravity", "Antigravity", "Antigravity.app"),
    ("trae", "Trae", "Trae.app"),
    ("kiro", "Kiro", "Kiro.app"),
    ("codium", "VSCodium", "VSCodium.app"),
    ("fleet", "Fleet", "Fleet.app"),
    ("studio", "Android Studio", "Android Studio.app"),
    ("xed", "Xcode", "Xcode.app"),
];

fn on_path(program: &str) -> bool {
    let path = path_with_common_tools();
    #[cfg(windows)]
    let names = [
        format!("{program}.cmd"),
        format!("{program}.exe"),
        format!("{program}.bat"),
    ];
    #[cfg(not(windows))]
    let names = [program.to_string()];
    std::env::split_paths(&path).any(|dir| names.iter().any(|name| dir.join(name).is_file()))
}

/// The macOS application bundle for a preset, when it is installed.
#[cfg(target_os = "macos")]
fn app_bundle(bundle: &str) -> Option<std::path::PathBuf> {
    let mut places = vec![std::path::PathBuf::from("/Applications")];
    if let Ok(home) = std::env::var("HOME") {
        places.push(std::path::PathBuf::from(home).join("Applications"));
    }
    places
        .into_iter()
        .map(|dir| dir.join(bundle))
        .find(|path| path.exists())
}

fn is_installed(program: &str, bundle: &str) -> bool {
    #[cfg(target_os = "macos")]
    if app_bundle(bundle).is_some() {
        return true;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = bundle;
    on_path(program)
}

/// Apps in the developer-tools category that are not editors, or not ones to open a folder in.
#[cfg(target_os = "macos")]
const NOT_EDITORS: &[&str] = &[
    "url handler",
    "simulator",
    "docker",
    "github desktop",
    "postman",
    "insomnia",
    "sourcetree",
    "tower",
    "proxyman",
    "charles",
    "instruments",
    "filemerge",
    "create ml",
    "accessibility inspector",
    "reality composer",
    "terminal",
    "iterm",
    "ghostty",
    "warp",
    "tessera",
    "emdash",
    "opencode",
    "claude",
    "codex",
    "kitty",
    "alacritty",
    "wezterm",
    "tabby",
    "chatgpt",
    "ollama",
    "hopper",
];

/// Every application in /Applications and ~/Applications that macOS files under developer tools, other than the ones
/// Tessera already knows by name and the ones that are not editors. Found once per run: reading each app's category
/// takes a moment. They open with `open -a`.
#[cfg(target_os = "macos")]
fn scanned_editors() -> &'static Vec<EditorOption> {
    static FOUND: std::sync::OnceLock<Vec<EditorOption>> = std::sync::OnceLock::new();
    FOUND.get_or_init(|| {
        let mut places = vec![std::path::PathBuf::from("/Applications")];
        if let Ok(home) = std::env::var("HOME") {
            places.push(std::path::PathBuf::from(home).join("Applications"));
        }
        let mut found = Vec::new();
        for place in places {
            let Ok(read) = std::fs::read_dir(&place) else { continue };
            for entry in read.flatten() {
                let file = entry.file_name().to_string_lossy().into_owned();
                let Some(name) = file.strip_suffix(".app") else {
                    continue;
                };
                let lower = name.to_ascii_lowercase();
                if EDITORS.iter().any(|(_, _, bundle)| bundle.eq_ignore_ascii_case(&file))
                    || NOT_EDITORS.iter().any(|word| lower.contains(word))
                {
                    continue;
                }
                let plist = entry.path().join("Contents").join("Info.plist");
                let category = Command::new("plutil")
                    .args(["-extract", "LSApplicationCategoryType", "raw", "-o", "-"])
                    .arg(&plist)
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .output()
                    .ok()
                    .and_then(|out| String::from_utf8(out.stdout).ok())
                    .unwrap_or_default();
                if category.trim() == "public.app-category.developer-tools" {
                    found.push(EditorOption {
                        id: format!("app:{}", entry.path().display()),
                        name: name.to_owned(),
                        installed: true,
                    });
                }
            }
        }
        found.sort_by_key(|option| option.name.to_lowercase());
        found
    })
}

/// The editors Tessera can open a folder in: every one it finds on this computer, then the well-known ones that are
/// not installed.
#[tauri::command]
#[specta::specta]
pub async fn editor_list() -> Vec<EditorOption> {
    tauri::async_runtime::spawn_blocking(|| {
        let known: Vec<EditorOption> = EDITORS
            .iter()
            .map(|(id, name, bundle)| EditorOption {
                id: (*id).to_owned(),
                name: (*name).to_owned(),
                installed: is_installed(id, bundle),
            })
            .collect();
        let mut installed: Vec<EditorOption> = known.iter().filter(|option| option.installed).cloned().collect();
        #[cfg(target_os = "macos")]
        installed.extend(scanned_editors().iter().cloned());
        installed.sort_by_key(|option| option.name.to_lowercase());
        installed.dedup_by(|a, b| a.name == b.name);
        let missing = known.into_iter().filter(|option| !option.installed);
        installed.into_iter().chain(missing).collect()
    })
    .await
    .unwrap_or_default()
}

/// Opens `path` in the editor `editor` (a preset from [`editor_list`]), whatever `editor.command` says.
#[tauri::command]
#[specta::specta]
pub fn open_in_editor_with(editor: String, path: String) -> Result<(), AppError> {
    // An application found by scanning /Applications: let macOS open the folder in it.
    #[cfg(target_os = "macos")]
    if let Some(app) = editor.strip_prefix("app:") {
        let status = Command::new("open")
            .arg("-a")
            .arg(app)
            .arg(&path)
            .stdin(Stdio::null())
            .status();
        return match status {
            Ok(done) if done.success() => Ok(()),
            _ => Err(AppError::new("editor.start_failed", "The editor could not be started.")),
        };
    }
    let plan = plan_editor(&editor, &path, None, None).map_err(editor_error)?;
    #[cfg(target_os = "macos")]
    if !on_path(&plan.program)
        && let Some((_, _, bundle)) = EDITORS
            .iter()
            .find(|(id, _, _)| *id == editor.trim().to_ascii_lowercase())
        && let Some(app) = app_bundle(bundle)
    {
        // The editor's command line tool is not installed, but the application is: let macOS open the folder in it.
        let status = Command::new("open")
            .arg("-a")
            .arg(app)
            .arg(&path)
            .stdin(Stdio::null())
            .status();
        return match status {
            Ok(done) if done.success() => Ok(()),
            _ => Err(AppError::new("editor.start_failed", "The editor could not be started.")),
        };
    }
    tracing::info!(program = %plan.program, "opening a folder in the chosen editor");
    start(&plan)
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

#[cfg(all(test, target_os = "macos"))]
mod scan_tests {
    use super::*;

    #[test]
    fn scanning_applications_finds_editors_without_panicking_and_keeps_them_sorted() {
        let found = scanned_editors();
        let names: Vec<_> = found.iter().map(|o| o.name.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        assert!(found.iter().all(|o| o.installed && o.id.starts_with("app:")));
        eprintln!(
            "scanned editors: {:?}",
            found.iter().map(|o| &o.name).collect::<Vec<_>>()
        );
    }
}
