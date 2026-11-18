//! Platform shell candidates and pure parsers for discovery command output.

use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// Recognised shell implementations. Cmd and WSL are discoverable without pretending they support injection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// Z shell.
    Zsh,
    /// GNU Bash.
    Bash,
    /// Friendly interactive shell.
    Fish,
    /// PowerShell Core or Windows PowerShell.
    PowerShell,
    /// Windows command interpreter.
    Cmd,
    /// Bash supplied by Git for Windows.
    GitBash,
    /// A named Windows Subsystem for Linux distribution.
    Wsl,
    /// An unrecognised login shell.
    Other,
}

impl ShellKind {
    /// Stable lowercase identifier for IPC adapters and logs.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zsh => "zsh",
            Self::Bash => "bash",
            Self::Fish => "fish",
            Self::PowerShell => "powershell",
            Self::Cmd => "cmd",
            Self::GitBash => "git-bash",
            Self::Wsl => "wsl",
            Self::Other => "other",
        }
    }
}

/// A launchable shell discovered on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellInfo {
    /// Stable kind/path identifier, or `wsl:<distribution>`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Executable path; WSL entries point at wsl.exe and encode the distro in `id`.
    pub path: PathBuf,
    /// Shell implementation.
    pub kind: ShellKind,
}

/// Snapshot of environment/discovery inputs; tests can supply isolated paths without mutating process state.
#[derive(Debug, Clone, Default)]
pub struct DetectionEnv {
    /// True for Windows executable naming and candidate paths.
    pub windows: bool,
    /// Executable search directories, in priority order.
    pub path: Vec<PathBuf>,
    /// Login shell from SHELL or the macOS account database.
    pub login_shell: Option<PathBuf>,
    /// Program Files, Program Files (x86), and per-user Programs directories.
    pub program_dirs: Vec<PathBuf>,
    /// Windows installation folder.
    pub system_root: Option<PathBuf>,
    /// Names parsed from successful `wsl -l -q` output.
    pub wsl_distros: Vec<String>,
}

/// Recognises a program basename on either platform, including Windows paths while running tests on Unix.
#[must_use]
pub fn shell_kind(program: &str) -> ShellKind {
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    match name.trim_end_matches(".exe") {
        "zsh" => ShellKind::Zsh,
        "bash" => ShellKind::Bash,
        "fish" => ShellKind::Fish,
        "pwsh" | "powershell" => ShellKind::PowerShell,
        "cmd" => ShellKind::Cmd,
        "wsl" => ShellKind::Wsl,
        _ => ShellKind::Other,
    }
}

/// Parses `dscl ... UserShell` without accepting arbitrary output as a command.
#[must_use]
pub fn parse_login_shell(text: &str) -> Option<PathBuf> {
    text.lines().find_map(|line| {
        let shell = line.strip_prefix("UserShell:")?.trim();
        (shell.starts_with('/') && !shell.chars().any(char::is_control)).then(|| PathBuf::from(shell))
    })
}

/// Parses quiet WSL output in UTF-8 or UTF-16 LE/BE (with or without a LE BOM).
/// Invalid encoding, embedded NULs, status/help lines and duplicates are ignored.
#[must_use]
pub fn parse_wsl_distros(bytes: &[u8]) -> Vec<String> {
    let little = bytes.starts_with(&[0xff, 0xfe])
        || (!bytes.starts_with(&[0xfe, 0xff]) && bytes.iter().skip(1).step_by(2).any(|b| *b == 0));
    let wide = little || bytes.starts_with(&[0xfe, 0xff]);
    let text = if wide {
        let body = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
            &bytes[2..]
        } else {
            bytes
        };
        if body.len() % 2 != 0 {
            return Vec::new();
        }
        let words = body.as_chunks::<2>().0.iter().map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        });
        let Ok(text) = String::from_utf16(&words.collect::<Vec<_>>()) else {
            return Vec::new();
        };
        text
    } else {
        let Ok(text) = std::str::from_utf8(bytes) else {
            return Vec::new();
        };
        text.trim_start_matches('\u{feff}').to_owned()
    };
    let mut distros = Vec::new();
    for line in text.lines() {
        let name = line.trim();
        // WSL distribution names use letters, numbers, dots, underscores and hyphens.
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
            && !distros.iter().any(|d| d == name)
        {
            distros.push(name.to_owned());
        }
    }
    distros
}

fn executable(path: &Path, windows: bool) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    if !windows {
        use std::os::unix::fs::PermissionsExt;
        return path
            .metadata()
            .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0);
    }
    let _ = windows;
    true
}

fn find(env: &DetectionEnv, name: &str) -> Option<PathBuf> {
    let name = if env.windows {
        format!("{name}.exe")
    } else {
        name.into()
    };
    env.path
        .iter()
        .map(|dir| dir.join(&name))
        .find(|path| executable(path, env.windows))
}

/// Finds installed candidates using an explicit snapshot and filesystem existence checks.
/// The login shell comes first on Unix; Windows prefers pwsh, Windows PowerShell, then cmd.
#[must_use]
pub fn detect_shells(env: &DetectionEnv) -> Vec<ShellInfo> {
    let mut candidates = Vec::new();
    if !env.windows
        && let Some(login) = &env.login_shell
    {
        candidates.push((login.clone(), shell_kind(&login.to_string_lossy())));
    }
    let names: &[&str] = if env.windows {
        &["pwsh", "powershell", "cmd", "bash"]
    } else {
        &["zsh", "bash", "fish", "pwsh"]
    };
    for name in names {
        if let Some(path) = find(env, name) {
            candidates.push((
                path,
                if env.windows && *name == "bash" {
                    ShellKind::GitBash
                } else {
                    shell_kind(name)
                },
            ));
        }
    }
    if env.windows {
        for dir in &env.program_dirs {
            candidates.push((dir.join("PowerShell").join("7").join("pwsh.exe"), ShellKind::PowerShell));
            candidates.push((dir.join("Git").join("bin").join("bash.exe"), ShellKind::GitBash));
        }
        if let Some(root) = &env.system_root {
            candidates.push((
                root.join("System32/WindowsPowerShell/v1.0/powershell.exe"),
                ShellKind::PowerShell,
            ));
            candidates.push((root.join("System32/cmd.exe"), ShellKind::Cmd));
        }
    }
    let mut shells = Vec::new();
    for (path, kind) in candidates {
        if !executable(&path, env.windows) || shells.iter().any(|shell: &ShellInfo| shell.path == path) {
            continue;
        }
        let name = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        shells.push(ShellInfo {
            id: format!("{}:{}", kind.as_str(), path.display()),
            name,
            path,
            kind,
        });
    }
    if env.windows
        && let Some(path) = find(env, "wsl").or_else(|| {
            env.system_root
                .as_ref()
                .map(|root| root.join("System32/wsl.exe"))
                .filter(|path| executable(path, true))
        })
    {
        for distro in &env.wsl_distros {
            shells.push(ShellInfo {
                id: format!("wsl:{distro}"),
                name: format!("WSL: {distro}"),
                path: path.clone(),
                kind: ShellKind::Wsl,
            });
        }
    }
    shells
}

/// Captures the process environment and platform discovery output without modifying it.
#[must_use]
pub fn discover_shells() -> Vec<ShellInfo> {
    let vars: BTreeMap<String, String> = std::env::vars().collect();
    let mut env = DetectionEnv {
        windows: cfg!(windows),
        path: std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect(),
        login_shell: vars.get("SHELL").map(PathBuf::from),
        program_dirs: ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(|key| vars.get(key).map(PathBuf::from))
            .collect(),
        system_root: vars.get("SystemRoot").map(PathBuf::from),
        wsl_distros: Vec::new(),
    };
    if let Some(local) = vars.get("LOCALAPPDATA") {
        env.program_dirs.push(PathBuf::from(local).join("Programs"));
    }
    #[cfg(target_os = "macos")]
    if env.login_shell.is_none()
        && let Some(user) = vars.get("USER")
    {
        env.login_shell =
            output_timeout(Command::new("/usr/bin/dscl").args([".", "-read", &format!("/Users/{user}"), "UserShell"]))
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|text| parse_login_shell(&text));
    }
    if env.windows
        && let Some(wsl) = find(&env, "wsl")
    {
        let mut command = Command::new(wsl);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        env.wsl_distros = output_timeout(command.args(["-l", "-q"]))
            .map(|bytes| parse_wsl_distros(&bytes))
            .unwrap_or_default();
    }
    detect_shells(&env)
}

// Discovery must not hang the UI on an unhealthy WSL installation. Drain concurrently to avoid a full pipe.
fn output_timeout(command: &mut Command) -> Option<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.by_ref().take(1024 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let bytes = reader.join().ok()?;
    success.then_some(bytes)
}
