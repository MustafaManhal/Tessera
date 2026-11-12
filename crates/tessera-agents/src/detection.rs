//! Executable discovery. The caller supplies PATH from the PTY login environment.
use crate::AgentDefinition;
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime},
};

pub const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
#[derive(Debug, Clone, Default)]
pub struct Detection {
    pub binary_path: Option<PathBuf>,
    pub version: Option<String>,
    pub error: Option<String>,
}
#[derive(Default)]
pub struct Detector {
    /// Also look in the usual install folders after PATH (the app does; tests with a fixed PATH do not).
    wide: bool,
    cache: BTreeMap<PathBuf, (Option<SystemTime>, Vec<String>, Detection)>,
}
/// PATHEXT expansion is pure so Windows behavior can be tested on macOS.
pub fn binary_candidates(binary: &str, windows: bool, pathext: &str) -> Vec<String> {
    if !windows || Path::new(binary).extension().is_some() {
        return vec![binary.into()];
    }
    let mut names = vec![binary.into()];
    for ext in pathext
        .split(';')
        .filter(|e| e.starts_with('.') && e.len() > 1 && !e.contains(['/', '\\']))
    {
        names.push(format!("{binary}{ext}"));
        // Allows platform-independent tests on a case-sensitive filesystem.
        let lower = format!("{binary}{}", ext.to_ascii_lowercase());
        if !names.contains(&lower) {
            names.push(lower);
        }
    }
    names
}
pub fn find_binary(binaries: &[String], path: &OsStr, windows: bool, pathext: &str) -> Option<PathBuf> {
    find_binary_in(binaries, path, &[], windows, pathext)
}

/// Like `find_binary`, then the folders where agent CLIs and Node tools usually live (see `extra_search_dirs`).
pub fn find_binary_wide(binaries: &[String], path: &OsStr, windows: bool, pathext: &str) -> Option<PathBuf> {
    // The login shell's PATH first; then the places agent CLIs and Node tools are commonly installed, because a program
    // installed from another terminal app, a version manager or an installer script may not be on that PATH.
    let home = std::env::var_os(if windows { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let extra = extra_search_dirs(home.as_deref(), appdata.as_deref(), local.as_deref(), windows);
    find_binary_in(binaries, path, &extra, windows, pathext)
}

/// Directories to look in after PATH. Only directories that exist are returned; version-manager folders with one
/// folder per Node version (nvm, fnm, mise) are expanded, newest name last so it is tried first.
pub fn extra_search_dirs(
    home: Option<&Path>,
    appdata: Option<&Path>,
    local: Option<&Path>,
    windows: bool,
) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut expand = |parent: PathBuf, tail: &str| {
        if let Ok(read) = std::fs::read_dir(&parent) {
            let mut versions: Vec<PathBuf> = read.filter_map(Result::ok).map(|e| e.path()).collect();
            versions.sort();
            versions.reverse();
            candidates.extend(versions.into_iter().map(|v| v.join(tail)));
        }
    };
    if let Some(home) = home {
        if windows {
            expand(home.join(".volta").join("tools").join("image").join("node"), "");
        } else {
            expand(home.join(".nvm").join("versions").join("node"), "bin");
            expand(home.join(".fnm").join("node-versions"), "installation/bin");
            expand(home.join(".local/share/fnm/node-versions"), "installation/bin");
            expand(home.join(".local/share/mise/installs/node"), "bin");
        }
    }
    if windows {
        if let Some(appdata) = appdata {
            candidates.push(appdata.join("npm"));
        }
        if let Some(local) = local {
            for tail in [
                "pnpm",
                "Volta/bin",
                "Microsoft/WinGet/Links",
                "Programs/claude",
                "Programs/Cursor/resources/app/bin",
            ] {
                candidates.push(local.join(tail));
            }
        }
        if let Some(home) = home {
            for tail in [
                ".bun/bin",
                ".cargo/bin",
                "scoop/shims",
                ".local/bin",
                ".claude/local",
                ".opencode/bin",
            ] {
                candidates.push(home.join(tail));
            }
        }
        candidates.push(PathBuf::from(r"C:\Program Files\nodejs"));
    } else {
        if let Some(home) = home {
            for tail in [
                ".local/bin",
                ".claude/local",
                ".opencode/bin",
                ".npm-global/bin",
                ".bun/bin",
                ".cargo/bin",
                ".deno/bin",
                "go/bin",
                ".volta/bin",
                ".asdf/shims",
                ".pyenv/shims",
                ".local/share/pnpm",
                "Library/pnpm",
                ".yarn/bin",
                ".config/yarn/global/node_modules/.bin",
                ".local/share/mise/shims",
                ".local/share/uv/tools",
            ] {
                candidates.push(home.join(tail));
            }
        }
        for dir in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/opt/local/bin",
            "/snap/bin",
        ] {
            candidates.push(PathBuf::from(dir));
        }
    }
    let mut seen = Vec::new();
    candidates
        .into_iter()
        .filter(|dir| dir.is_dir())
        .filter(|dir| {
            let fresh = !seen.contains(dir);
            seen.push(dir.clone());
            fresh
        })
        .collect()
}

/// `find_binary` with the extra directories given: PATH is searched first, then `extra`.
pub fn find_binary_in(
    binaries: &[String],
    path: &OsStr,
    extra: &[PathBuf],
    windows: bool,
    pathext: &str,
) -> Option<PathBuf> {
    let on_path: Vec<PathBuf> = std::env::split_paths(path)
        .filter(|d| !d.as_os_str().is_empty())
        .collect();
    for binary in binaries {
        for directory in on_path.iter().chain(extra.iter()) {
            for candidate in binary_candidates(binary, windows, pathext) {
                let file = directory.join(candidate);
                if is_executable(&file, windows) {
                    return Some(std::fs::canonicalize(&file).unwrap_or(file));
                }
            }
        }
    }
    None
}
fn is_executable(path: &Path, windows: bool) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    if !windows {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }
    let _ = windows;
    true
}
impl Detector {
    /// A detector that also searches the usual install folders for agent CLIs.
    pub fn wide() -> Self {
        Self {
            wide: true,
            ..Self::default()
        }
    }

    pub fn detect(&mut self, def: &AgentDefinition, path: &OsStr, pathext: &str, rescan: bool) -> Detection {
        let found = if self.wide {
            find_binary_wide(&def.binaries, path, cfg!(windows), pathext)
        } else {
            find_binary(&def.binaries, path, cfg!(windows), pathext)
        };
        let Some(binary) = found else {
            return Detection::default();
        };
        let mtime = binary.metadata().ok().and_then(|m| m.modified().ok());
        if !rescan
            && let Some((old, args, value)) = self.cache.get(&binary)
            && *old == mtime
            && args == &def.version_cmd
        {
            return value.clone();
        }
        // Replace the declared command name with the located executable. Never pass through a shell.
        let result = probe_version(&binary, &def.version_cmd[1..], path, VERSION_TIMEOUT);
        let (version, error) = match result {
            Ok(v) => (v, None),
            Err(e) => (None, Some(e)),
        };
        let result = Detection {
            binary_path: Some(binary.clone()),
            version,
            error,
        };
        self.cache
            .insert(binary, (mtime, def.version_cmd.clone(), result.clone()));
        result
    }
}
/// Drain bounded output while polling the child so a full pipe cannot defeat the deadline.
/// Reader threads are not joined: an inherited pipe in a grandchild cannot hold up the caller.
pub fn probe_version(
    binary: &Path,
    args: &[String],
    path: &OsStr,
    timeout: Duration,
) -> Result<Option<String>, String> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("The version command could not start: {e}."))?;
    let (tx, rx) = mpsc::channel();
    for mut stream in [
        Box::new(child.stdout.take().expect("piped stdout")) as Box<dyn Read + Send>,
        Box::new(child.stderr.take().expect("piped stderr")),
    ] {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut captured = Vec::new();
            let mut chunk = [0; 4096];
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let keep = n.min(65536_usize.saturating_sub(captured.len()));
                captured.extend_from_slice(&chunk[..keep]);
            }
            let _ = tx.send(captured);
        });
    }
    drop(tx);
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(format!("The version command exited with {status}."));
                }
                let mut outputs = Vec::new();
                for _ in 0..2 {
                    if let Ok(output) = rx.recv_timeout(Duration::from_millis(50)) {
                        outputs.extend(output);
                        outputs.push(b'\n');
                    }
                }
                return Ok(parse_version(&String::from_utf8_lossy(&outputs)));
            }
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The version command timed out.".into());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("The version command could not be read: {e}."));
            }
        }
    }
}
pub fn parse_version(text: &str) -> Option<String> {
    // Numeric releases, optional prerelease/build suffix, and date-based Cursor releases.
    regex::Regex::new(r"(?i)\bv?(\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?)\b")
        .expect("constant regex")
        .captures(text)
        .map(|m| m[1].into())
}

#[cfg(test)]
mod extra_dirs_tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    fn make_tool(dir: &Path, name: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(dir).unwrap();
        let file = dir.join(name);
        fs::write(&file, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_tool_outside_path_is_found_in_the_usual_install_folders() {
        let home = tempfile::tempdir().unwrap();
        make_tool(&home.path().join(".npm-global/bin"), "gemini");
        make_tool(&home.path().join(".nvm/versions/node/v18.0.0/bin"), "amp");
        make_tool(&home.path().join(".nvm/versions/node/v22.1.0/bin"), "amp");
        make_tool(&home.path().join(".local/bin"), "aider");
        let extra = extra_search_dirs(Some(home.path()), None, None, false);
        assert!(extra.iter().any(|d| d.ends_with(".npm-global/bin")));
        // The newest Node version comes first.
        let amp = find_binary_in(&["amp".into()], OsStr::new(""), &extra, false, "").unwrap();
        assert!(amp.to_string_lossy().contains("v22.1.0"), "{amp:?}");
        for tool in ["gemini", "aider"] {
            assert!(
                find_binary_in(&[tool.into()], OsStr::new(""), &extra, false, "").is_some(),
                "{tool}"
            );
        }
        assert!(find_binary_in(&["nothere".into()], OsStr::new(""), &extra, false, "").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn path_wins_over_the_extra_folders_and_missing_folders_are_skipped() {
        let home = tempfile::tempdir().unwrap();
        let on_path = tempfile::tempdir().unwrap();
        make_tool(on_path.path(), "tool");
        make_tool(&home.path().join(".local/bin"), "tool");
        let extra = extra_search_dirs(Some(home.path()), None, None, false);
        let found = find_binary_in(&["tool".into()], on_path.path().as_os_str(), &extra, false, "").unwrap();
        assert!(found.starts_with(fs::canonicalize(on_path.path()).unwrap()));
        assert!(extra.iter().all(|d| d.is_dir()));
    }
}
