//! Shell discovery, environment merging and macOS login-environment resolution.
//!
//! A GUI app on macOS starts with a bare `PATH` (usually `/usr/bin:/bin:/usr/sbin:/sbin`), so a shell started
//! from it cannot see Homebrew or `pnpm`. Tessera probes `-lic env` in the background with a 3 s timeout;
//! the host starts immediately from a fresh disk cache or inherited variables plus path_helper PATH.

use std::collections::BTreeMap;
use std::env;
#[cfg(target_os = "macos")]
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
#[cfg(target_os = "macos")]
use std::thread;
use std::time::Duration;
#[cfg(target_os = "macos")]
use std::time::Instant;

#[cfg(target_os = "macos")]
use tracing::{debug, warn};

/// How long the login-environment probe may run.
pub const LOGIN_ENV_TIMEOUT: Duration = Duration::from_secs(3);

/// The platform whose shell conventions should be used.
///
/// Tests use both variants on any machine; real spawns use [`Platform::current`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// macOS and Linux: `$SHELL`, falling back to `/bin/zsh` (macOS).
    Unix,
    /// Windows: `pwsh.exe`, then `powershell.exe`, then `cmd.exe`.
    Windows,
}

impl Platform {
    /// The platform this binary was compiled for.
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(windows) { Self::Windows } else { Self::Unix }
    }
}

/// The default shell for a platform: the user's `$SHELL` on Unix, the best available PowerShell on Windows.
///
/// `exists` is injected so the selection logic is a pure function in tests; the
/// real call passes a `PATH` lookup.
#[must_use]
pub fn default_shell_with(
    env: &BTreeMap<String, String>,
    platform: Platform,
    mut exists: impl FnMut(&str) -> bool,
) -> String {
    match platform {
        Platform::Unix => env
            .get("SHELL")
            .map(|shell| shell.trim())
            .filter(|shell| !shell.is_empty())
            .map_or_else(|| "/bin/zsh".to_string(), |shell| shell.to_string()),
        Platform::Windows => ["pwsh.exe", "powershell.exe", "cmd.exe"]
            .into_iter()
            .find(|candidate| exists(candidate))
            .unwrap_or("cmd.exe")
            .to_string(),
    }
}

/// The default shell for a platform, looked up on `PATH` when needed.
#[must_use]
pub fn default_shell(env: &BTreeMap<String, String>, platform: Platform) -> String {
    default_shell_with(env, platform, |program| find_program(program, env, platform).is_some())
}

/// Finds a program on `PATH` (or as a path), returning the absolute candidate.
///
/// On Windows a bare name also tries every `PATHEXT` extension. This mirrors what
/// portable-pty does before spawning, but lets the host answer `ProgramNotFound`
/// with a typed error instead of a generic spawn failure.
#[must_use]
pub fn find_program(program: &str, env: &BTreeMap<String, String>, platform: Platform) -> Option<PathBuf> {
    let looks_like_path = program.contains('/') || program.contains('\\');
    if looks_like_path {
        let path = PathBuf::from(program);
        return is_executable(&path, platform).then_some(path);
    }

    let path_var = env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value)?;

    let mut extensions: Vec<String> = Vec::new();
    if platform == Platform::Windows {
        let pathext = env
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATHEXT"))
            .map(|(_, value)| value.as_str())
            .unwrap_or(".COM;.EXE;.BAT;.CMD");
        extensions.extend(
            pathext
                .split(';')
                .map(str::trim)
                .filter(|extension| !extension.is_empty())
                .map(str::to_string),
        );
    }

    for directory in env::split_paths(path_var) {
        let candidate = directory.join(program);
        if is_executable(&candidate, platform) {
            return Some(candidate);
        }
        if platform == Platform::Windows && !has_windows_extension(program) {
            for extension in &extensions {
                let with_extension = directory.join(format!("{program}{extension}"));
                if is_executable(&with_extension, platform) {
                    return Some(with_extension);
                }
            }
        }
    }
    None
}

fn has_windows_extension(program: &str) -> bool {
    Path::new(program).extension().is_some()
}

fn is_executable(path: &Path, platform: Platform) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    if platform == Platform::Unix {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            return metadata.permissions().mode() & 0o111 != 0;
        }
        #[cfg(not(unix))]
        {
            return true;
        }
    }
    true
}

/// Parses `KEY=VALUE` lines from `env` output.
///
/// Values may contain `=`; a line without `=` continues the previous value (this
/// is how exported shell functions appear in `env` output). Lines with an empty
/// or whitespace-containing key, and lines before the first valid entry, are
/// ignored, so a chatty login script cannot inject a bogus variable.
#[must_use]
pub fn parse_env_output(output: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    let mut current: Option<String> = None;

    for raw_line in output.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            continue;
        }
        match line.split_once('=') {
            Some((key, value)) if is_valid_key(key) => {
                result.insert(key.to_string(), value.to_string());
                current = Some(key.to_string());
            }
            Some(_) => {
                current = None;
            }
            None => {
                if let Some(key) = &current
                    && let Some(value) = result.get_mut(key)
                {
                    value.push('\n');
                    value.push_str(line);
                }
            }
        }
    }
    result
}

fn is_valid_key(key: &str) -> bool {
    !key.is_empty() && !key.chars().any(|c| c == '=' || c.is_whitespace() || c.is_control())
}

/// Resolves the user's login shell environment: base env + login env + caller env, in that order.
#[must_use]
pub fn merge_environment(
    base: &BTreeMap<String, String>,
    login: &BTreeMap<String, String>,
    caller: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut merged = base.clone();
    merged.extend(login.iter().map(|(key, value)| (key.clone(), value.clone())));
    merged.extend(caller.iter().map(|(key, value)| (key.clone(), value.clone())));
    merged
}

/// The variables Tessera always sets for a session, overriding the caller.
#[must_use]
pub fn tessera_environment(
    session_id: &crate::SessionId,
    task_id: Option<&str>,
    version: &str,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert("COLORTERM".to_string(), "truecolor".to_string());
    env.insert("TERM_PROGRAM".to_string(), "Tessera".to_string());
    env.insert("TERM_PROGRAM_VERSION".to_string(), version.to_string());
    env.insert("TESSERA_SESSION_ID".to_string(), session_id.to_string());
    if let Some(root) = api_data_root() {
        // Bind panes to this app's data root, not an endpoint inherited from another Tessera pane.
        let socket = api_socket(&root, cfg!(windows));
        let token = root.join("api-token");
        env.insert("TESSERA_SOCKET".into(), socket);
        env.insert("TESSERA_API_TOKEN_FILE".into(), token.to_string_lossy().into_owned());
    }

    if let Some(task_id) = task_id {
        env.insert("TESSERA_TASK_ID".to_string(), task_id.to_string());
    }
    env
}

// Match the desktop data root without a dependency on the API crate or changing PTY state/spawn paths.
fn api_data_root() -> Option<std::path::PathBuf> {
    if std::env::var_os("TESSERA_BENCH_ROOT").is_some() {
        return std::env::var_os("TESSERA_BENCH_DATA_ROOT")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("TESSERA_BENCH_ROOT").map(|p| std::path::PathBuf::from(p).join("data")));
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    } else {
        std::env::var_os("HOME").map(|p| std::path::PathBuf::from(p).join("Library/Application Support"))
    }?;
    Some(base.join(if cfg!(debug_assertions) {
        "Tessera Dev"
    } else {
        "Tessera"
    }))
}
fn api_socket(root: &std::path::Path, windows: bool) -> String {
    if !windows {
        return root.join("tessera.sock").to_string_lossy().into_owned();
    }
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in root.to_string_lossy().to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!(r"\\.\pipe\tessera-{hash:016x}")
}

/// Fast macOS PATH fallback, resolved without running the user's startup scripts.
/// Invoked only by the background refresher; Windows inherits its launch environment.
pub(crate) fn path_helper_environment() -> BTreeMap<String, String> {
    #[cfg(target_os = "macos")]
    {
        match Command::new("/usr/libexec/path_helper").arg("-s").output() {
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(path) = text
                    .strip_prefix("PATH=\"")
                    .and_then(|value| value.split_once("\";").map(|(path, _)| path))
                {
                    return BTreeMap::from([("PATH".into(), path.into())]);
                }
            }
            _ => {}
        }
    }
    BTreeMap::new()
}

/// Runs the user's shell as a login shell and returns its environment.
///
/// Only macOS needs this (GUI apps get a minimal `PATH`); other platforms return
/// an empty map. Failures and the timeout are logged and never fatal.
#[must_use]
pub fn login_environment(shell: &str) -> BTreeMap<String, String> {
    #[cfg(target_os = "macos")]
    {
        login_environment_macos(shell)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = shell;
        BTreeMap::new()
    }
}

#[cfg(target_os = "macos")]
fn login_environment_macos(shell: &str) -> BTreeMap<String, String> {
    if shell.trim().is_empty() {
        return BTreeMap::new();
    }
    let started = Instant::now();
    let mut child = match Command::new(shell)
        .args(["-lic", "env"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            warn!(shell, %error, "could not run the login shell; using the inherited environment");
            return BTreeMap::new();
        }
    };

    let stdout = child.stdout.take();
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stdout) = stdout {
            let _ = stdout.read_to_string(&mut text);
        }
        let _ = sender.send(text);
    });

    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() >= LOGIN_ENV_TIMEOUT => {
                warn!(shell, "login shell environment probe timed out");
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                warn!(shell, %error, "could not wait for the login shell");
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };

    let text = receiver
        .recv_timeout(LOGIN_ENV_TIMEOUT.saturating_sub(started.elapsed()))
        .unwrap_or_default();
    // A descendant can retain stdout after the shell exits. Do not join a blocked reader.
    if reader.is_finished() {
        let _ = reader.join();
    }
    if !success {
        return BTreeMap::new();
    }
    let environment = parse_env_output(&text);
    debug!(shell, variables = environment.len(), "resolved the login environment");
    environment
}

#[cfg(test)]
mod api_endpoint_tests {
    use super::*;
    #[test]
    fn api_addresses_use_distinct_roots_and_stable_windows_names() {
        let root = std::path::Path::new(r"C:\Users\me\Tessera");
        assert!(api_socket(root, true).starts_with(r"\\.\pipe\tessera-"));
        assert_eq!(
            api_socket(root, true),
            api_socket(std::path::Path::new(r"c:\users\ME\tessera"), true)
        );
        assert_ne!(
            api_socket(root, true),
            api_socket(std::path::Path::new(r"C:\Users\me\Tessera Dev"), true)
        );
        assert!(api_socket(root, false).ends_with("tessera.sock"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn unix_default_shell_prefers_the_users_shell() {
        let env = map(&[("SHELL", "/opt/homebrew/bin/fish")]);
        assert_eq!(
            default_shell_with(&env, Platform::Unix, |_| false),
            "/opt/homebrew/bin/fish"
        );
    }

    #[test]
    fn unix_default_shell_falls_back_to_zsh() {
        let env = map(&[("SHELL", "   ")]);
        assert_eq!(default_shell_with(&env, Platform::Unix, |_| false), "/bin/zsh");
        assert_eq!(
            default_shell_with(&BTreeMap::new(), Platform::Unix, |_| false),
            "/bin/zsh"
        );
    }

    #[test]
    fn windows_default_shell_prefers_pwsh_then_powershell_then_cmd() {
        let env = BTreeMap::new();
        let mut available = |name: &str| name == "pwsh.exe";
        assert_eq!(default_shell_with(&env, Platform::Windows, &mut available), "pwsh.exe");
        let mut available = |name: &str| name == "powershell.exe";
        assert_eq!(
            default_shell_with(&env, Platform::Windows, &mut available),
            "powershell.exe"
        );
        let mut available = |_: &str| true;
        assert_eq!(default_shell_with(&env, Platform::Windows, &mut available), "pwsh.exe");
        let mut available = |_: &str| false;
        assert_eq!(default_shell_with(&env, Platform::Windows, &mut available), "cmd.exe");
    }

    #[test]
    fn env_parser_keeps_equals_and_empty_values() {
        let env = parse_env_output("A=1\nB=\nC=x=y\n");
        assert_eq!(env.get("A").map(String::as_str), Some("1"));
        assert_eq!(env.get("B").map(String::as_str), Some(""));
        assert_eq!(env.get("C").map(String::as_str), Some("x=y"));
    }

    #[test]
    fn env_parser_joins_multiline_values() {
        let env = parse_env_output("BASH_FUNC_hello%%=() {  echo hi\n}\nNEXT=1\n");
        assert_eq!(
            env.get("BASH_FUNC_hello%%").map(String::as_str),
            Some("() {  echo hi\n}")
        );
        assert_eq!(env.get("NEXT").map(String::as_str), Some("1"));
    }

    #[test]
    fn env_parser_ignores_garbage_and_bad_keys() {
        let env = parse_env_output("not a variable\n=empty-key\n BAD=1\nGOOD=yes\n");
        assert_eq!(env.len(), 1);
        assert_eq!(env.get("GOOD").map(String::as_str), Some("yes"));
    }

    #[test]
    fn merge_order_is_base_then_login_then_caller() {
        let base = map(&[("PATH", "/usr/bin"), ("LANG", "C")]);
        let login = map(&[("PATH", "/opt/homebrew/bin:/usr/bin"), ("EDITOR", "vim")]);
        let caller = map(&[("EDITOR", "nvim"), ("PROJECT", "tessera")]);
        let merged = merge_environment(&base, &login, &caller);
        assert_eq!(
            merged.get("PATH").map(String::as_str),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(merged.get("EDITOR").map(String::as_str), Some("nvim"));
        assert_eq!(merged.get("LANG").map(String::as_str), Some("C"));
        assert_eq!(merged.get("PROJECT").map(String::as_str), Some("tessera"));
    }

    #[test]
    fn tessera_variables_override_the_caller() {
        let id: crate::SessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV".parse().expect("ulid");
        let env = tessera_environment(&id, Some("task-1"), "1.2.3");
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert_eq!(env.get("TERM_PROGRAM").map(String::as_str), Some("Tessera"));
        assert_eq!(env.get("TERM_PROGRAM_VERSION").map(String::as_str), Some("1.2.3"));
        assert_eq!(env.get("TESSERA_TASK_ID").map(String::as_str), Some("task-1"));
        assert_eq!(
            env.get("TESSERA_SESSION_ID").map(String::as_str),
            Some("01ARZ3NDEKTSV4RRFFQ69G5FAV")
        );
    }

    #[test]
    fn a_missing_program_is_reported() {
        let env = map(&[("PATH", env::temp_dir().to_str().unwrap_or_default())]);
        assert!(find_program("definitely-not-a-tessera-program", &env, Platform::current()).is_none());
    }

    #[test]
    fn finds_an_existing_program_through_the_callers_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let program = dir.path().join(if cfg!(windows) {
            "tessera-test-shell.exe"
        } else {
            "tessera-test-shell"
        });
        std::fs::write(&program, b"not really a program").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&program).expect("metadata").permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&program, permissions).expect("chmod");
        }
        let env = map(&[("PATH", dir.path().to_str().expect("utf-8 path"))]);
        let found = find_program(
            program.file_name().expect("name").to_str().expect("utf-8"),
            &env,
            Platform::current(),
        );
        assert_eq!(found.as_deref(), Some(program.as_path()));
    }
}
