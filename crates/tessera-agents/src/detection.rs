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
    for binary in binaries {
        for directory in std::env::split_paths(path).filter(|d| !d.as_os_str().is_empty()) {
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
    pub fn detect(&mut self, def: &AgentDefinition, path: &OsStr, pathext: &str, rescan: bool) -> Detection {
        let Some(binary) = find_binary(&def.binaries, path, cfg!(windows), pathext) else {
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
