//! Whether git is on this computer, and installing it when it is not: winget on Windows, Apple's command line
//! developer tools on macOS. Projects, tasks and worktrees all need git, so the app checks on start.
use crate::agent_commands::run_install;
use crate::agent_types::AgentInstallResult;
use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::Manager;
use tessera_git::NoWindow as _;

/// What the app knows about git here, and how it would install it.
#[derive(Debug, Clone, Serialize, Type)]
pub struct GitSetup {
    /// Whether `git --version` runs.
    pub installed: bool,
    /// The version git reports, such as "2.47.1".
    pub version: Option<String>,
    /// The command Tessera runs to install git on this computer, shown to the user before it runs.
    pub install_command: String,
    /// The page to download git from by hand.
    pub download_url: String,
}

#[cfg(windows)]
const INSTALL_COMMAND: &str = "winget install --id Git.Git --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity";
#[cfg(not(windows))]
const INSTALL_COMMAND: &str = "xcode-select --install";
#[cfg(windows)]
const DOWNLOAD_URL: &str = "https://git-scm.com/download/win";
#[cfg(not(windows))]
const DOWNLOAD_URL: &str = "https://git-scm.com/download/mac";

/// The first `name` on the process PATH (with `.exe` on Windows).
fn on_path(name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(&file))
        .find(|candidate| candidate.is_file())
}

/// On macOS `/usr/bin/git` is a stub that opens Apple's install dialog when the command line tools are missing, so
/// it is only run once `xcode-select -p` names a folder that is there. Any other git on the PATH (Homebrew) is fine.
#[cfg(target_os = "macos")]
fn may_run_git() -> bool {
    if on_path("git").is_some_and(|git| git != std::path::Path::new("/usr/bin/git")) {
        return true;
    }
    Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdin(Stdio::null())
        .output()
        .is_ok_and(|out| {
            out.status.success() && std::path::Path::new(String::from_utf8_lossy(&out.stdout).trim()).is_dir()
        })
}
#[cfg(not(target_os = "macos"))]
fn may_run_git() -> bool {
    true
}

/// Where the Git for Windows installer puts `git.exe` (machine-wide or for this user only).
#[cfg(windows)]
fn installed_git_dirs() -> Vec<PathBuf> {
    ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|var| std::env::var_os(var).map(|root| PathBuf::from(root).join("Git").join("cmd")))
        .chain(
            std::env::var_os("LOCALAPPDATA").map(|root| PathBuf::from(root).join("Programs").join("Git").join("cmd")),
        )
        .collect()
}

/// A git installed after Tessera started (or by an installer that left PATH alone) is not on this process's PATH:
/// put its folder at the front so projects, tasks and new terminals find it without a restart.
#[cfg(windows)]
fn add_installed_git_to_path() {
    if on_path("git").is_some() {
        return;
    }
    let Some(dir) = installed_git_dirs()
        .into_iter()
        .find(|dir| dir.join("git.exe").is_file())
    else {
        return;
    };
    let mut paths = vec![dir];
    if let Some(current) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        // SAFETY: on Windows the standard library serializes environment access behind its own lock and the OS
        // environment block is process-wide and thread-safe; no C code here reads it through `getenv`.
        unsafe { std::env::set_var("PATH", joined) };
    }
}
#[cfg(not(windows))]
fn add_installed_git_to_path() {}

/// `git --version` without its "git version " prefix, or `None` when git does not run.
fn git_version() -> Option<String> {
    add_installed_git_to_path();
    if !may_run_git() {
        return None;
    }
    let out = Command::new("git")
        .no_window()
        .arg("--version")
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(text.trim().trim_start_matches("git version ").to_owned())
}

fn setup() -> GitSetup {
    let version = git_version();
    GitSetup {
        installed: version.is_some(),
        version,
        install_command: INSTALL_COMMAND.to_owned(),
        download_url: DOWNLOAD_URL.to_owned(),
    }
}

/// Checks whether git runs on this computer.
#[tauri::command]
#[specta::specta]
pub async fn git_setup_check() -> Result<GitSetup, AppError> {
    tauri::async_runtime::spawn_blocking(setup)
        .await
        .map_err(|e| AppError::new("git.setup_failed", e.to_string()))
}

/// Installs git: winget on Windows (waits for it to finish), Apple's command line tools installer on macOS (opens
/// Apple's own window and returns; the user checks again once it is done).
#[tauri::command]
#[specta::specta]
pub async fn git_setup_install(app: tauri::AppHandle) -> Result<AgentInstallResult, AppError> {
    let env = app.state::<AppState>().pty.login_environment_snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        if cfg!(windows) && on_path("winget").is_none() {
            return AgentInstallResult {
                ok: false,
                output: format!("winget is not available on this computer. Download Git from {DOWNLOAD_URL}."),
            };
        }
        let result = run_install(INSTALL_COMMAND, &env, cfg!(windows));
        add_installed_git_to_path();
        result
    })
    .await
    .map_err(|e| AppError::new("git.setup_failed", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_the_git_on_this_machine() {
        let setup = setup();
        assert!(!setup.install_command.is_empty());
        assert!(setup.download_url.starts_with("https://git-scm.com/"));
        // The test machines all have git.
        if Command::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
        {
            assert!(setup.installed);
            assert!(
                setup
                    .version
                    .as_deref()
                    .is_some_and(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
            );
        }
    }
}
