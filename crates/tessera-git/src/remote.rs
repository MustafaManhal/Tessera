//! Repositories on an SSH host (M10.2, FR-63).
//!
//! A remote repository is addressed by a path of the form `ssh://<alias>/<absolute posix path>`, stored like any other
//! project or worktree path. Every Git call on such a path runs `git` on the host through the system `ssh` (so the
//! user's config, agent, keys and `known_hosts` apply), with the same options as a local call. The app tells this
//! module how to reach an alias through [`set_resolver`]: it returns the `ssh` program, its options (before the
//! target), the target and extra environment (the askpass hand-off for a saved password).
use crate::{GitError, process};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

/// Path scheme of remote repositories and worktrees.
pub const SCHEME: &str = "ssh://";

/// How to run `ssh` for one host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteHost {
    /// The `ssh` executable.
    pub program: PathBuf,
    /// Options before the target (`-p`, `-l`, `-i` for a manual host; none for a config alias).
    pub options: Vec<String>,
    /// What ssh connects to: the config alias or the host name.
    pub target: String,
    /// Extra environment, e.g. `SSH_ASKPASS` when a saved password answers the prompt.
    pub env: BTreeMap<String, String>,
}

impl RemoteHost {
    /// Whether ssh may ask for a password through `SSH_ASKPASS`; otherwise it runs in batch mode and never prompts.
    #[must_use]
    pub fn askpass(&self) -> bool {
        self.env.contains_key("SSH_ASKPASS")
    }

    /// The `ssh` command for one non-interactive remote command (`sh -c` syntax on the host).
    #[must_use]
    pub fn command(&self, remote_command: &str) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.options);
        if !self.askpass() {
            command.args(["-o", "BatchMode=yes"]);
        }
        // Reuse one connection for the many short Git calls (OpenSSH for Windows has no ControlMaster).
        #[cfg(not(windows))]
        command.args([
            "-o",
            "ControlMaster=auto",
            "-o",
            "ControlPath=/tmp/tessera-ssh-%C",
            "-o",
            "ControlPersist=60",
        ]);
        command
            .args(["-T", "-o", "ConnectTimeout=15", "--", &self.target, remote_command])
            .envs(&self.env)
            .stdin(std::process::Stdio::null());
        command
    }

    /// `ssh -tt <target> 'cd <dir> && exec <command>'` arguments for an interactive pane (program is [`Self::program`]).
    #[must_use]
    pub fn pane_args(&self, dir: &str, command: &str) -> Vec<String> {
        let mut args = self.options.clone();
        args.extend([
            "-tt".to_owned(),
            "--".to_owned(),
            self.target.clone(),
            format!("cd {} && exec {command}", quote(dir)),
        ]);
        args
    }
}

type Resolver = dyn Fn(&str) -> Option<RemoteHost> + Send + Sync;

fn resolver() -> &'static RwLock<Option<Arc<Resolver>>> {
    static RESOLVER: RwLock<Option<Arc<Resolver>>> = RwLock::new(None);
    &RESOLVER
}

fn cache() -> &'static Mutex<HashMap<String, RemoteHost>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, RemoteHost>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// Installs how aliases are reached (the app reads its SSH host list). Clears cached hosts.
pub fn set_resolver(resolve: impl Fn(&str) -> Option<RemoteHost> + Send + Sync + 'static) {
    *resolver().write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::new(resolve));
    forget_hosts();
}

/// Drops cached hosts after the SSH host list changed.
pub fn forget_hosts() {
    cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
}

/// Resolves an alias through the installed resolver (cached).
///
/// # Errors
/// [`GitError::Remote`] when no resolver is installed or the alias is unknown.
pub fn host(alias: &str) -> Result<RemoteHost, GitError> {
    if let Some(found) = cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(alias)
    {
        return Ok(found.clone());
    }
    let resolve = resolver()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .ok_or_else(|| GitError::Remote {
            message: "SSH hosts are not available.".into(),
        })?;
    let found = resolve(alias).ok_or_else(|| GitError::Remote {
        message: format!("The SSH host {alias} is not in the host list."),
    })?;
    cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(alias.to_owned(), found.clone());
    Ok(found)
}

/// `ssh://<alias>/<path>` for a remote absolute path.
#[must_use]
pub fn encode(alias: &str, path: &str) -> String {
    format!("{SCHEME}{alias}/{}", path.trim_start_matches('/'))
}

/// Splits a remote path into its alias and the absolute path on the host; `None` for a local path. Backslashes
/// (from joining on Windows) become slashes.
#[must_use]
pub fn split(path: &Path) -> Option<(String, String)> {
    let text = path.to_str()?.replace('\\', "/");
    let rest = text.strip_prefix(SCHEME)?;
    let (alias, path) = rest.split_once('/').unwrap_or((rest, ""));
    if alias.is_empty() {
        return None;
    }
    let path = format!("/{}", path.trim_end_matches('/'));
    Some((alias.to_owned(), if path.len() > 1 { path } else { "/".into() }))
}

/// Whether `path` is on an SSH host.
#[must_use]
pub fn is_remote(path: impl AsRef<Path>) -> bool {
    split(path.as_ref()).is_some()
}

/// Joins `child` onto a remote path with `/` on every OS.
#[must_use]
pub fn join(base: &Path, child: &str) -> PathBuf {
    let text = base.to_string_lossy().replace('\\', "/");
    PathBuf::from(format!(
        "{}/{}",
        text.trim_end_matches('/'),
        child.trim_start_matches('/')
    ))
}

/// Re-addresses a path printed by Git on the host (e.g. `rev-parse --show-toplevel`) with the alias of `origin`.
#[must_use]
pub fn rebase(origin: &Path, printed: &str) -> Option<String> {
    split(origin).map(|(alias, _)| encode(&alias, printed))
}

/// Single-quotes `value` for a POSIX shell.
#[must_use]
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Runs one shell command on the host and returns stdout. A nonzero exit of the command is
/// [`GitError::WorktreeFailed`] with its stderr (so Git's own failures map as locally); ssh's 255 is
/// [`GitError::Remote`].
///
/// # Errors
/// As above, plus timeouts and launch failures.
pub fn shell(alias: &str, remote_command: &str, timeout: Duration) -> Result<Vec<u8>, GitError> {
    let host = host(alias)?;
    let output = process::output(&mut host.command(remote_command), timeout)?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if output.status.code() == Some(255) {
        return Err(GitError::Remote {
            message: if stderr.is_empty() {
                format!("Could not connect to {alias}.")
            } else {
                stderr
            },
        });
    }
    Err(GitError::WorktreeFailed { stderr })
}

/// Runs Git in `dir` on the host with the same options as a local call.
pub(crate) fn git<I, S>(alias: &str, dir: &str, args: I, timeout: Duration) -> Result<Vec<u8>, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut line = String::from(
        "env LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat GIT_OPTIONAL_LOCKS=0 git --no-pager -c safe.bareRepository=all -C ",
    );
    line.push_str(&quote(dir));
    for arg in args {
        let arg = arg.as_ref().to_string_lossy();
        // A remote path argument (a worktree destination) becomes the plain path on the host.
        let arg = match split(Path::new(arg.as_ref())) {
            Some((on, path)) if on == alias => path,
            _ => arg.into_owned(),
        };
        line.push(' ');
        line.push_str(&quote(&arg));
    }
    shell(alias, &line, timeout)
}

/// `mkdir -p` on the host.
///
/// # Errors
/// As [`shell`].
pub fn create_dir_all(path: &Path) -> Result<(), GitError> {
    let (alias, dir) = split(path).ok_or_else(|| GitError::InvalidPath { path: path.into() })?;
    shell(&alias, &format!("mkdir -p -- {}", quote(&dir)), crate::DEFAULT_TIMEOUT)?;
    Ok(())
}

/// Whether a remote path exists on the host (`test -e`).
///
/// # Errors
/// [`GitError::Remote`] when the host cannot be reached.
pub fn exists(path: &Path) -> Result<bool, GitError> {
    let (alias, dir) = split(path).ok_or_else(|| GitError::InvalidPath { path: path.into() })?;
    match shell(&alias, &format!("test -e {}", quote(&dir)), crate::DEFAULT_TIMEOUT) {
        Ok(_) => Ok(true),
        Err(GitError::WorktreeFailed { .. }) => Ok(false),
        Err(error) => Err(error),
    }
}

/// Whether two remote paths name the same place (same alias and path, compared as text).
#[must_use]
pub fn same(a: &Path, b: &Path) -> bool {
    split(a).is_some_and(|a| split(b).is_some_and(|b| a == b))
}

/// The user's home directory on the host.
///
/// # Errors
/// As [`shell`].
pub fn home(alias: &str) -> Result<String, GitError> {
    let out = shell(alias, "printf %s \"$HOME\"", crate::DEFAULT_TIMEOUT)?;
    let home = String::from_utf8_lossy(&out).trim().to_owned();
    if home.starts_with('/') {
        Ok(home)
    } else {
        Err(GitError::Remote {
            message: "The host did not report a home directory.".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_round_trip_and_join_with_slashes() {
        let repo = encode("build", "/home/me/repo");
        assert_eq!(repo, "ssh://build/home/me/repo");
        assert_eq!(split(Path::new(&repo)), Some(("build".into(), "/home/me/repo".into())));
        let joined = join(Path::new("ssh://build/home/me/wt"), "fix-bug");
        assert_eq!(joined, PathBuf::from("ssh://build/home/me/wt/fix-bug"));
        // Joining on Windows puts a backslash in; it still splits.
        assert_eq!(
            split(Path::new("ssh://build/home/me/wt\\fix-bug")).unwrap().1,
            "/home/me/wt/fix-bug"
        );
        assert!(split(Path::new("/home/me/repo")).is_none());
        assert!(split(Path::new("ssh:///nope")).is_none());
        assert_eq!(
            rebase(Path::new("ssh://b/x"), "/srv/repo").as_deref(),
            Some("ssh://b/srv/repo")
        );
        assert_eq!(quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn commands_use_batch_mode_unless_a_password_is_answered() {
        let host = RemoteHost {
            program: "ssh".into(),
            options: vec!["-p".into(), "2222".into()],
            target: "box".into(),
            env: BTreeMap::new(),
        };
        let args: Vec<String> = host
            .command("true")
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..2], ["-p", "2222"]);
        assert!(args.contains(&"BatchMode=yes".to_owned()));
        assert_eq!(&args[args.len() - 2..], ["box", "true"]);
        let mut askpass = host.clone();
        askpass.env.insert("SSH_ASKPASS".into(), "/x/tessera".into());
        assert!(!askpass.command("true").get_args().any(|a| a == "BatchMode=yes"));
        assert_eq!(
            host.pane_args("/srv/my repo", "\"${SHELL:-/bin/sh}\" -l"),
            [
                "-p",
                "2222",
                "-tt",
                "--",
                "box",
                "cd '/srv/my repo' && exec \"${SHELL:-/bin/sh}\" -l"
            ]
        );
    }
}
