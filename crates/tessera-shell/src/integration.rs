//! Pure launch transformations and on-demand installation of embedded scripts.

use crate::detect::{ShellKind, shell_kind};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

/// Shell integration could not be installed.
#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    /// Filesystem operation failed inside the app-owned integration directory.
    #[error("could not write shell integration at {path}: {source}")]
    Io {
        /// Affected app-owned path.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: std::io::Error,
    },
}

impl ShellError {
    /// Stable IPC error code.
    pub fn code(&self) -> &'static str {
        "shell.integration_io"
    }
}

const SCRIPTS: &[(&str, &str)] = &[
    ("zsh/.zshenv", include_str!("../scripts/zsh/.zshenv")),
    ("zsh/.zprofile", include_str!("../scripts/zsh/.zprofile")),
    ("zsh/.zshrc", include_str!("../scripts/zsh/.zshrc")),
    ("zsh/.zlogin", include_str!("../scripts/zsh/.zlogin")),
    ("zsh/integration.zsh", include_str!("../scripts/zsh/integration.zsh")),
    ("bash.sh", include_str!("../scripts/bash.sh")),
    (
        "fish/vendor_conf.d/tessera.fish",
        include_str!("../scripts/fish/vendor_conf.d/tessera.fish"),
    ),
    ("powershell.ps1", include_str!("../scripts/powershell.ps1")),
];
static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

/// Writes embedded scripts below `<data_dir>/shell-integration`; unchanged scripts are not rewritten.
/// Never opens user startup files. Refuses symlinked installation directories/files.
///
/// # Errors
/// Returns an I/O error without truncating an existing script.
pub fn write_scripts(data_dir: &Path) -> Result<PathBuf, ShellError> {
    let root = data_dir.join("shell-integration");
    let error = |path: &Path, source| ShellError::Io {
        path: path.into(),
        source,
    };
    for directory in [
        &root,
        &root.join("zsh"),
        &root.join("fish"),
        &root.join("fish/vendor_conf.d"),
    ] {
        if fs::symlink_metadata(directory).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(error(
                directory,
                std::io::Error::other("integration directory is a symlink"),
            ));
        }
        fs::create_dir_all(directory).map_err(|e| error(directory, e))?;
    }
    for (name, contents) in SCRIPTS {
        let path = root.join(name);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(error(&path, std::io::Error::other("integration file is a symlink")));
        }
        if fs::read(&path).is_ok_and(|bytes| bytes == contents.as_bytes()) {
            continue;
        }
        let temp = path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &path)
        })();
        if let Err(source) = result {
            let _ = fs::remove_file(&temp);
            return Err(error(&path, source));
        }
    }
    tracing::debug!(path = %root.display(), "shell integration scripts ready");
    Ok(root)
}

fn shell_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Base injection variables; `dir` is the installed shell-integration directory.
/// Pure: use [`prepare_launch`] to also preserve ZDOTDIR/XDG settings from an environment snapshot.
#[must_use]
pub fn integration_env(shell: ShellKind, dir: &Path, enabled: bool) -> Vec<(String, String)> {
    if !enabled || matches!(shell, ShellKind::Cmd | ShellKind::Wsl | ShellKind::Other) {
        return Vec::new();
    }
    let mut env = vec![("TESSERA_SHELL_DIR".into(), shell_path(dir))];
    match shell {
        ShellKind::Zsh => env.push(("ZDOTDIR".into(), shell_path(&dir.join("zsh")))),
        ShellKind::Fish => env.push((
            "XDG_DATA_DIRS".into(),
            format!("{}:/usr/local/share:/usr/share", shell_path(dir)),
        )),
        _ => {}
    }
    env
}

/// Base interactive arguments. PowerShell paths are single-quoted with embedded quotes doubled.
#[must_use]
pub fn integration_args(shell: ShellKind, dir: &Path, enabled: bool) -> Vec<String> {
    if !enabled {
        return Vec::new();
    }
    match shell {
        ShellKind::Zsh | ShellKind::Fish => vec!["-i".into()],
        ShellKind::Bash | ShellKind::GitBash => vec!["--rcfile".into(), shell_path(&dir.join("bash.sh")), "-i".into()],
        ShellKind::PowerShell => vec![
            "-NoExit".into(),
            "-Command".into(),
            format!(". '{}'", shell_path(&dir.join("powershell.ps1")).replace('\'', "''")),
        ],
        _ => Vec::new(),
    }
}

/// Prepared arguments and environment delta. The caller merges `env` after its explicit environment overrides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    /// Final executable arguments; unchanged for unsupported or noninteractive commands.
    pub args: Vec<String>,
    /// Only integration-specific variables, never a replacement for the caller's whole environment.
    pub env: BTreeMap<String, String>,
    /// Whether scripts need to be installed before spawning.
    pub injected: bool,
}

/// Installs app-owned scripts and prepares the same launch plan for native and test hosts.
/// `env` must contain the inherited environment with explicit spawn overrides already merged.
/// Disabled integration leaves arguments untouched and performs no filesystem writes.
///
/// # Errors
/// Returns [`ShellError`] when scripts cannot be installed. Callers may log the error and
/// start the original shell without integration.
pub fn prepare_installed_launch(
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    data_root: &Path,
    enabled: bool,
) -> Result<LaunchPlan, ShellError> {
    if !enabled {
        return Ok(prepare_launch(program, args, env, data_root, false));
    }
    let dir = write_scripts(data_root)?;
    Ok(prepare_launch(program, args, env, &dir, true))
}

/// Plans integration for an interactive shell without changing process environment or touching disk.
/// Explicit command/file/custom-rc arguments bypass injection. `SHELL_INTEGRATION=off` wins over config.
/// Bash login mode is emulated by its rc shim because Bash ignores --rcfile for login shells.
#[must_use]
pub fn prepare_launch(
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    dir: &Path,
    enabled: bool,
) -> LaunchPlan {
    let kind = shell_kind(program);
    let value = |key: &str| {
        env.iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    };
    let unchanged = || LaunchPlan {
        args: args.to_vec(),
        env: BTreeMap::new(),
        injected: false,
    };
    if !enabled || value("SHELL_INTEGRATION").is_some_and(|v| v.eq_ignore_ascii_case("off")) {
        return unchanged();
    }
    let supported = match kind {
        ShellKind::Zsh | ShellKind::Bash | ShellKind::Fish => args
            .iter()
            .all(|arg| matches!(arg.as_str(), "-l" | "--login" | "-i" | "--interactive" | "-il" | "-li")),
        ShellKind::PowerShell => args
            .iter()
            .all(|arg| matches!(arg.to_ascii_lowercase().as_str(), "-nologo" | "-noprofile" | "-noexit")),
        _ => false,
    };
    if !supported {
        return unchanged();
    }
    let mut plan = LaunchPlan {
        args: integration_args(kind, dir, true),
        env: integration_env(kind, dir, true).into_iter().collect(),
        injected: true,
    };
    let login = args
        .iter()
        .any(|arg| matches!(arg.as_str(), "-l" | "--login" | "-il" | "-li"));
    match kind {
        ShellKind::Zsh => {
            plan.env.insert(
                "TESSERA_ZDOTDIR_SET".into(),
                if value("ZDOTDIR").is_some() { "1" } else { "0" }.into(),
            );
            plan.env
                .insert("TESSERA_ZDOTDIR".into(), value("ZDOTDIR").unwrap_or_default().into());
            if login {
                plan.args.push("-l".into());
            }
        }
        ShellKind::Bash => {
            if login {
                plan.env.insert("TESSERA_BASH_LOGIN".into(), "1".into());
            }
        }
        ShellKind::Fish => {
            plan.env.insert(
                "TESSERA_XDG_DATA_DIRS_SET".into(),
                if value("XDG_DATA_DIRS").is_some() { "1" } else { "0" }.into(),
            );
            plan.env.insert(
                "TESSERA_XDG_DATA_DIRS".into(),
                value("XDG_DATA_DIRS").unwrap_or_default().into(),
            );
            plan.env.insert(
                "XDG_DATA_DIRS".into(),
                format!(
                    "{}:{}",
                    shell_path(dir),
                    value("XDG_DATA_DIRS")
                        .filter(|value| !value.is_empty())
                        .unwrap_or("/usr/local/share:/usr/share")
                ),
            );
            if login {
                plan.args.push("-l".into());
            }
        }
        ShellKind::PowerShell => {
            let mut preserved: Vec<String> = args
                .iter()
                .filter(|arg| !arg.eq_ignore_ascii_case("-noexit"))
                .cloned()
                .collect();
            preserved.extend(plan.args);
            plan.args = preserved;
        }
        _ => {}
    }
    plan
}
