//! SSH hosts and terminals (M10.1, FR-62, S-19).
//!
//! Hosts come from `~/.ssh/config` (read live, never written) and from hosts the user adds by hand. A terminal on a host
//! is the system `ssh` in an ordinary PTY pane (OpenSSH ships with macOS and Windows 10+), so ssh's own config, agent,
//! keys and `known_hosts` apply. A password is typed in the terminal unless the user saved it: then it lives in the OS
//! keychain (macOS Keychain, Windows Credential Manager) and `ssh` asks the bundled `tessera` CLI for it through
//! `SSH_ASKPASS`. That happens only for hosts already in `known_hosts`, so a new host key is always confirmed by the
//! user in the terminal, and the CLI answers only password prompts.

use crate::error::AppError;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tessera_store::ssh_config::{SshConfigHost, read_ssh_config};
use tessera_store::ssh_hosts::{SshHost, SshHostInput as StoreInput};

/// Keychain service name for saved SSH passwords; the account is the host alias.
pub const KEYCHAIN_SERVICE: &str = "Tessera SSH";

/// A host as the UI shows it: from `~/.ssh/config`, added by hand, or a config host with stored settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SshHostInfo {
    /// Saved row id, or `config:<alias>` for a config host without stored settings.
    pub id: String,
    /// What `ssh <alias>` takes.
    pub alias: String,
    /// Host name or address.
    pub host: String,
    /// Port, when not the default.
    pub port: Option<u16>,
    /// Login name, when set.
    pub user: Option<String>,
    /// `agent`, `key` or `password`.
    pub auth: String,
    /// Key file, when `auth` is `key` (or the config's first `IdentityFile`).
    pub key_path: Option<String>,
    /// `ProxyJump` from the config, for display.
    pub proxy_jump: Option<String>,
    /// `config` or `manual`.
    pub source: String,
    /// A password for this host is saved in the OS keychain.
    pub password_saved: bool,
}

/// What the host form sends. `id` null creates a manual host; a `config:<alias>` id stores settings for a config host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SshHostInput {
    /// Existing id, `config:<alias>`, or null.
    pub id: Option<String>,
    /// Alias (unique).
    pub alias: String,
    /// Host name or address.
    pub host: String,
    /// Port.
    pub port: Option<u16>,
    /// Login name.
    pub user: Option<String>,
    /// `agent`, `key` or `password`.
    pub auth: String,
    /// Key file for `key`.
    pub key_path: Option<String>,
}

/// How the front end starts a terminal on a host: an ordinary PTY spawn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SshLaunch {
    /// The `ssh` executable.
    pub program: String,
    /// Arguments.
    pub args: Vec<String>,
    /// Extra environment (the askpass hand-off when a password is saved for a known host).
    pub env: BTreeMap<String, String>,
    /// Tab title.
    pub title: String,
    /// Why a saved password will not be used this time (the host key is not known yet), for a one-line notice.
    pub notice: Option<String>,
}

fn store_error(error: tessera_store::StoreError) -> AppError {
    AppError::new("ssh.store", error.to_string())
}

fn home(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .home_dir()
        .map_err(|_| AppError::new("ssh.home", "The home folder could not be found."))
}

fn valid_auth(auth: &str) -> bool {
    matches!(auth, "agent" | "key" | "password")
}

/// Merges config hosts and saved rows: a saved row with the alias of a config host adds its settings to it.
#[must_use]
pub fn merge(config: Vec<SshConfigHost>, saved: Vec<SshHost>) -> Vec<SshHostInfo> {
    let mut out: Vec<SshHostInfo> = Vec::new();
    for host in config {
        let row = saved.iter().find(|s| s.alias == host.alias);
        out.push(SshHostInfo {
            id: row.map_or_else(|| format!("config:{}", host.alias), |r| r.id.clone()),
            host: host.host_name.clone().unwrap_or_else(|| host.alias.clone()),
            port: host.port,
            user: host.user.clone(),
            auth: row.map_or_else(
                || if host.identity_file.is_some() { "key" } else { "agent" }.to_owned(),
                |r| r.auth.clone(),
            ),
            key_path: row.and_then(|r| r.key_path.clone()).or(host.identity_file.clone()),
            proxy_jump: host.proxy_jump.clone(),
            source: "config".into(),
            password_saved: row.is_some_and(|r| r.keychain_ref.is_some()),
            alias: host.alias,
        });
    }
    for row in saved {
        if row.from_ssh_config || out.iter().any(|h| h.alias == row.alias) {
            continue; // settings of a config host that is gone, or already merged
        }
        out.push(SshHostInfo {
            id: row.id,
            alias: row.alias,
            host: row.host,
            port: row.port,
            user: row.user,
            auth: row.auth,
            key_path: row.key_path,
            proxy_jump: None,
            source: "manual".into(),
            password_saved: row.keychain_ref.is_some(),
        });
    }
    out
}

/// The hosts for S-19: `~/.ssh/config` first (in file order), then hosts added by hand.
#[tauri::command]
#[specta::specta]
pub async fn ssh_hosts_list(app: tauri::AppHandle) -> Result<Vec<SshHostInfo>, AppError> {
    // Remote projects resolve hosts again after any change to the list (M10.2).
    tessera_git::remote::forget_hosts();
    let home = home(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let saved = app
            .state::<AppState>()
            .store
            .lock()
            .map_err(|_| AppError::lock_failed())?
            .ssh_hosts()
            .map_err(store_error)?;
        Ok(merge(read_ssh_config(&home), saved))
    })
    .await
    .map_err(|e| AppError::new("ssh.worker_failed", e.to_string()))?
}

/// Adds or edits a manual host, or stores settings (auth method, key) for a config host.
#[tauri::command]
#[specta::specta]
pub fn ssh_host_save(state: tauri::State<'_, AppState>, input: SshHostInput) -> Result<SshHostInfo, AppError> {
    // Remote projects resolve hosts again after any change to the list (M10.2).
    tessera_git::remote::forget_hosts();
    let alias = input.alias.trim().to_owned();
    if alias.is_empty() || alias.contains(char::is_whitespace) {
        return Err(AppError::new("ssh.invalid", "Give the host a name without spaces."));
    }
    if input.host.trim().is_empty() {
        return Err(AppError::new("ssh.invalid", "Enter the host name or address."));
    }
    if !valid_auth(&input.auth) {
        return Err(AppError::new(
            "ssh.invalid",
            "Choose agent, key or password authentication.",
        ));
    }
    let from_config = input.id.as_deref().is_some_and(|id| id.starts_with("config:"));
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let existing = store.ssh_host_by_alias(&alias).map_err(store_error)?;
    let id = match input.id.as_deref() {
        Some(id) if !id.starts_with("config:") => Some(id.to_owned()),
        _ => existing.as_ref().map(|row| row.id.clone()),
    };
    if let Some(row) = &existing
        && Some(&row.id) != id.as_ref()
    {
        return Err(AppError::new(
            "ssh.duplicate",
            format!("A host named {alias} already exists."),
        ));
    }
    let row = store
        .ssh_host_save(&StoreInput {
            id,
            alias,
            host: input.host.trim().to_owned(),
            port: input.port,
            user: input.user.filter(|u| !u.trim().is_empty()),
            auth: input.auth,
            key_path: input.key_path.filter(|k| !k.trim().is_empty()),
            from_ssh_config: from_config,
        })
        .map_err(store_error)?;
    Ok(merge(
        Vec::new(),
        vec![SshHost {
            from_ssh_config: false,
            ..row
        }],
    )
    .remove(0))
}

/// Removes a manual host (or a config host's stored settings) and its saved password.
#[tauri::command]
#[specta::specta]
pub fn ssh_host_delete(state: tauri::State<'_, AppState>, id: String) -> Result<(), AppError> {
    // Remote projects resolve hosts again after any change to the list (M10.2).
    tessera_git::remote::forget_hosts();
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    if let Some(row) = store.ssh_host_get(&id).map_err(store_error)? {
        if row.keychain_ref.is_some() {
            forget_password(&row.alias)?;
        }
        store.ssh_host_delete(&id).map_err(store_error)?;
    }
    Ok(())
}

pub(crate) fn keychain(alias: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, alias)
        .map_err(|e| AppError::new("ssh.keychain", format!("The keychain is not available: {e}")))
}

pub(crate) fn forget_password(alias: &str) -> Result<(), AppError> {
    match keychain(alias)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::new(
            "ssh.keychain",
            format!("The saved password could not be removed: {e}"),
        )),
    }
}

/// Saves a host's password in the OS keychain (only on the user's request). A config host gets a settings row.
#[tauri::command]
#[specta::specta]
pub async fn ssh_password_save(app: tauri::AppHandle, alias: String, password: String) -> Result<(), AppError> {
    // Remote projects resolve hosts again after any change to the list (M10.2).
    tessera_git::remote::forget_hosts();
    if password.is_empty() {
        return Err(AppError::new("ssh.invalid", "Enter the password to save."));
    }
    let home = home(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        keychain(&alias)?
            .set_password(&password)
            .map_err(|e| AppError::new("ssh.keychain", format!("The password could not be saved: {e}")))?;
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        let row = match store.ssh_host_by_alias(&alias).map_err(store_error)? {
            Some(row) => row,
            None => {
                let config = read_ssh_config(&home)
                    .into_iter()
                    .find(|h| h.alias == alias)
                    .ok_or_else(|| AppError::new("ssh.unknown", format!("There is no host named {alias}.")))?;
                store
                    .ssh_host_save(&StoreInput {
                        id: None,
                        host: config.host_name.unwrap_or_else(|| alias.clone()),
                        alias: alias.clone(),
                        port: config.port,
                        user: config.user,
                        auth: "password".into(),
                        key_path: None,
                        from_ssh_config: true,
                    })
                    .map_err(store_error)?
            }
        };
        store
            .ssh_host_set_keychain(&row.id, Some(&format!("{KEYCHAIN_SERVICE}:{alias}")))
            .map_err(store_error)
    })
    .await
    .map_err(|e| AppError::new("ssh.worker_failed", e.to_string()))?
}

/// Removes a host's saved password.
#[tauri::command]
#[specta::specta]
pub fn ssh_password_forget(state: tauri::State<'_, AppState>, alias: String) -> Result<(), AppError> {
    // Remote projects resolve hosts again after any change to the list (M10.2).
    tessera_git::remote::forget_hosts();
    forget_password(&alias)?;
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    if let Some(row) = store.ssh_host_by_alias(&alias).map_err(store_error)? {
        store.ssh_host_set_keychain(&row.id, None).map_err(store_error)?;
    }
    Ok(())
}

/// The command line for a terminal on a host.
#[tauri::command]
#[specta::specta]
pub async fn ssh_connect_plan(app: tauri::AppHandle, id: String) -> Result<SshLaunch, AppError> {
    tauri::async_runtime::spawn_blocking(move || resolve_launch(&app, |h| h.id == id).map(|(_, launch)| launch))
        .await
        .map_err(|e| AppError::new("ssh.worker_failed", e.to_string()))?
}

/// Finds a host in the merged list and builds its launch (blocking: reads the store and runs `ssh -G`).
pub(crate) fn resolve_launch(
    app: &tauri::AppHandle,
    find: impl Fn(&SshHostInfo) -> bool,
) -> Result<(SshHostInfo, SshLaunch), AppError> {
    let saved = app
        .state::<AppState>()
        .store
        .lock()
        .map_err(|_| AppError::lock_failed())?
        .ssh_hosts()
        .map_err(store_error)?;
    resolve_launch_with(app, saved, find)
}

/// [`resolve_launch`] with the saved rows already read (callers that must not take the store lock).
pub(crate) fn resolve_launch_with(
    app: &tauri::AppHandle,
    saved: Vec<SshHost>,
    find: impl Fn(&SshHostInfo) -> bool,
) -> Result<(SshHostInfo, SshLaunch), AppError> {
    let home = home(app)?;
    let state = app.state::<AppState>();
    let host = merge(read_ssh_config(&home), saved)
        .into_iter()
        .find(|h| find(h))
        .ok_or_else(|| AppError::new("ssh.unknown", "That host is no longer in the list."))?;
    let env = state.pty.login_environment_snapshot();
    let ssh = tessera_pty::find_program(
        if cfg!(windows) { "ssh.exe" } else { "ssh" },
        &env,
        tessera_pty::Platform::current(),
    )
    .ok_or_else(|| {
        AppError::new(
            "ssh.not_installed",
            "OpenSSH (ssh) was not found. On Windows, add the OpenSSH Client in Settings, Optional features.",
        )
    })?;
    let cli = PathBuf::from(crate::hooks_commands::cli_path()?);
    let launch = plan(&host, &ssh, &cli, |target| known_host(&ssh, target));
    Ok((host, launch))
}

/// Builds the launch: `ssh <alias>` for config hosts (ssh applies the config), explicit flags for manual hosts; the
/// askpass hand-off only when a password is saved and `known(alias or host)` says the host key is already trusted.
pub fn plan(host: &SshHostInfo, ssh: &Path, cli: &Path, known: impl Fn(&str) -> bool) -> SshLaunch {
    let mut args = Vec::new();
    let target = if host.source == "config" {
        host.alias.clone()
    } else {
        if let Some(port) = host.port {
            args.extend(["-p".to_owned(), port.to_string()]);
        }
        if let Some(user) = &host.user {
            args.extend(["-l".to_owned(), user.clone()]);
        }
        if host.auth == "key"
            && let Some(key) = &host.key_path
        {
            args.extend(["-i".to_owned(), key.clone()]);
        }
        host.host.clone()
    };
    let mut env = BTreeMap::new();
    let mut notice = None;
    if host.password_saved {
        // ssh would also hand a new host key's yes/no question to askpass: only use it for trusted hosts.
        let probe = if host.source == "config" {
            host.alias.clone()
        } else {
            match host.port {
                Some(port) => format!("{}:{port}", host.host),
                None => host.host.clone(),
            }
        };
        if known(&probe) && cli.is_file() {
            env.insert("SSH_ASKPASS".into(), cli.to_string_lossy().into_owned());
            env.insert("SSH_ASKPASS_REQUIRE".into(), "force".into());
            env.insert("TESSERA_ASKPASS_ALIAS".into(), host.alias.clone());
            env.entry("DISPLAY".into()).or_insert_with(|| "tessera:0".into());
        } else {
            notice = Some(
                "This host's key is not trusted yet: confirm it and type the password in the terminal once.".into(),
            );
        }
    }
    args.push(target);
    SshLaunch {
        program: ssh.to_string_lossy().into_owned(),
        args,
        env,
        title: host.alias.clone(),
        notice,
    }
}

/// Whether `target` (a config alias, or `host[:port]`) is in `known_hosts`: `ssh -G` resolves the real host and port
/// through the user's config, then `ssh-keygen -F` looks it up.
pub(crate) fn known_host(ssh: &Path, target: &str) -> bool {
    let (alias, port) = match target.rsplit_once(':') {
        Some((host, port)) if port.parse::<u16>().is_ok() => (host, Some(port)),
        _ => (target, None),
    };
    let mut command = std::process::Command::new(ssh);
    command.arg("-G");
    if let Some(port) = port {
        command.args(["-p", port]);
    }
    let Ok(output) = command.arg(alias).output() else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let value = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(key).map(|v| v.trim().to_owned()))
    };
    let Some(host) = value("hostname ") else { return false };
    let port = value("port ").unwrap_or_else(|| "22".into());
    let lookup = if port == "22" { host } else { format!("[{host}]:{port}") };
    let keygen = ssh.with_file_name(if cfg!(windows) { "ssh-keygen.exe" } else { "ssh-keygen" });
    let keygen = if keygen.is_file() {
        keygen
    } else {
        PathBuf::from("ssh-keygen")
    };
    std::process::Command::new(keygen)
        .args(["-F", &lookup])
        .output()
        .is_ok_and(|o| o.status.success() && !o.stdout.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(alias: &str) -> SshConfigHost {
        SshConfigHost {
            alias: alias.into(),
            host_name: Some(format!("{alias}.example.com")),
            user: Some("me".into()),
            port: Some(2222),
            identity_file: Some("/k/id".into()),
            proxy_jump: None,
        }
    }

    fn saved(alias: &str, from_config: bool, keychain: bool) -> SshHost {
        SshHost {
            id: format!("id-{alias}"),
            alias: alias.into(),
            host: "10.0.0.9".into(),
            port: Some(22),
            user: Some("root".into()),
            auth: "password".into(),
            key_path: None,
            from_ssh_config: from_config,
            keychain_ref: keychain.then(|| format!("{KEYCHAIN_SERVICE}:{alias}")),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn config_hosts_come_first_and_take_their_stored_settings() {
        let hosts = merge(
            vec![config("build"), config("db")],
            vec![
                saved("db", true, true),
                saved("manual", false, false),
                saved("gone", true, true),
            ],
        );
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(
            aliases,
            ["build", "db", "manual"],
            "settings of a removed config host are not a host"
        );
        assert_eq!(hosts[0].id, "config:build");
        assert_eq!(hosts[0].auth, "key");
        assert_eq!(hosts[1].id, "id-db");
        assert!(hosts[1].password_saved);
        assert_eq!(
            hosts[1].host, "db.example.com",
            "the config stays the source of the address"
        );
        assert_eq!(hosts[2].source, "manual");
    }

    #[test]
    fn plans_use_the_alias_for_config_hosts_and_flags_for_manual_ones() {
        let ssh = Path::new("/usr/bin/ssh");
        let cli = Path::new("/missing/tessera");
        let host = &merge(vec![config("build")], vec![])[0];
        let launch = plan(host, ssh, cli, |_| true);
        assert_eq!(launch.args, ["build"]);
        assert!(launch.env.is_empty());
        let mut manual = merge(vec![], vec![saved("box", false, false)]).remove(0);
        manual.auth = "key".into();
        manual.key_path = Some("/k/box".into());
        assert_eq!(
            plan(&manual, ssh, cli, |_| true).args,
            ["-p", "22", "-l", "root", "-i", "/k/box", "10.0.0.9"]
        );
    }

    #[test]
    fn a_saved_password_is_offered_only_for_hosts_whose_key_is_already_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("tessera");
        std::fs::write(&cli, b"").unwrap();
        let host = merge(vec![], vec![saved("box", false, true)]).remove(0);
        let trusted = plan(&host, Path::new("/usr/bin/ssh"), &cli, |target| {
            assert_eq!(target, "10.0.0.9:22");
            true
        });
        assert_eq!(
            trusted.env.get("SSH_ASKPASS_REQUIRE").map(String::as_str),
            Some("force")
        );
        assert_eq!(
            trusted.env.get("TESSERA_ASKPASS_ALIAS").map(String::as_str),
            Some("box")
        );
        assert!(trusted.notice.is_none());
        let unknown = plan(&host, Path::new("/usr/bin/ssh"), &cli, |_| false);
        assert!(unknown.env.is_empty(), "a new host key is never answered by askpass");
        assert!(unknown.notice.is_some());
    }

    /// A real login through the same plan the app uses, with `ssh` in a real PTY (ConPTY on Windows). Needs a running
    /// sshd: `TESSERA_SSH_LIVE_HOST`, `_PORT`, `_USER`, and either `_PASSWORD` (saved in the OS keychain for the run and
    /// answered through `SSH_ASKPASS` by the built `tessera` CLI; the host key must already be in `known_hosts`) or
    /// `_KEY` (a key file). `_OPTS` adds ssh options (space separated), `_CLI` overrides the CLI path. The Windows
    /// workflow `win-6-ssh.yml` and the lead's local macOS run use it.
    #[test]
    #[ignore = "needs a real sshd (TESSERA_SSH_LIVE_HOST and friends)"]
    fn live_login_in_a_pty() {
        use std::sync::{Arc, Mutex, mpsc};
        use std::time::{Duration, Instant};
        use tessera_pty::{EventSink, PtyEvent, PtyHost, SpawnSpec};

        let var = |name: &str| {
            std::env::var(format!("TESSERA_SSH_LIVE_{name}"))
                .ok()
                .filter(|v| !v.is_empty())
        };
        let host_name = var("HOST").expect("TESSERA_SSH_LIVE_HOST");
        let password = var("PASSWORD");
        let key = var("KEY");
        assert!(
            password.is_some() || key.is_some(),
            "set TESSERA_SSH_LIVE_PASSWORD or TESSERA_SSH_LIVE_KEY"
        );
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let ssh = tessera_pty::find_program(
            if cfg!(windows) { "ssh.exe" } else { "ssh" },
            &env,
            tessera_pty::Platform::current(),
        )
        .expect("ssh on PATH");
        let cli = var("CLI").map(PathBuf::from).unwrap_or_else(|| {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .expect("workspace root");
            root.join("target")
                .join("debug")
                .join(if cfg!(windows) { "tessera.exe" } else { "tessera" })
        });
        eprintln!("ssh: {}, cli: {}", ssh.display(), cli.display());

        let alias = format!("tessera-live-{}", std::process::id());
        if let Some(password) = &password {
            keychain(&alias)
                .unwrap()
                .set_password(password)
                .expect("save the password in the keychain");
        }
        let info = SshHostInfo {
            id: "live".into(),
            alias: alias.clone(),
            host: host_name,
            port: var("PORT").map(|p| p.parse().expect("TESSERA_SSH_LIVE_PORT")),
            user: var("USER"),
            auth: if password.is_some() { "password" } else { "key" }.into(),
            key_path: key,
            proxy_jump: None,
            source: "manual".into(),
            password_saved: password.is_some(),
        };
        let launch = plan(&info, &ssh, &cli, |target| known_host(&ssh, target));
        if password.is_some() {
            assert_eq!(
                launch.env.get("TESSERA_ASKPASS_ALIAS").map(String::as_str),
                Some(alias.as_str()),
                "the host key is in known_hosts, so the saved password is offered: {:?}",
                launch.notice
            );
        }
        assert!(
            !known_host(&ssh, "tessera-unknown.invalid:2"),
            "an unknown host is never trusted"
        );

        // The plan's options, the test's options, then the target and a remote command.
        let mut args = launch.args.clone();
        let target = args.pop().expect("target");
        if password.is_some() {
            args.extend(["-o".into(), "PubkeyAuthentication=no".into()]);
        }
        args.extend(
            var("OPTS")
                .map(|o| o.split_whitespace().map(String::from).collect::<Vec<_>>())
                .unwrap_or_default(),
        );
        args.extend([target, "echo".into(), "tessera-ssh-ok".into()]);

        let cwd = tempfile::tempdir().unwrap();
        let pty = PtyHost::new();
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let sink: EventSink = Arc::new(move |event| {
            let _ = sender.lock().unwrap().send(event);
        });
        let mut spec = SpawnSpec::new(cwd.path());
        spec.program = Some(launch.program.clone());
        spec.args = args;
        spec.env = launch.env.clone();
        let id = pty.spawn_with_sink(spec, Some(sink)).expect("spawn ssh in a pty");
        let mut output = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(60);
        let code = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "ssh did not finish; output: {}",
                String::from_utf8_lossy(&output)
            );
            match events.recv_timeout(remaining.min(Duration::from_millis(250))) {
                Ok(PtyEvent::Data(bytes)) => {
                    pty.ack(&id, bytes.len()).unwrap();
                    // ConPTY waits for an answer to its cursor query; a real terminal answers it.
                    if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                        let _ = pty.write(&id, b"\x1b[1;1R");
                    }
                    output.extend(bytes);
                }
                Ok(PtyEvent::Exit { code }) => break code,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => panic!("the pty closed"),
            }
        };
        if password.is_some() {
            forget_password(&alias).unwrap();
        }
        let text = String::from_utf8_lossy(&output);
        eprintln!("ssh output: {text}");
        assert!(
            text.contains("tessera-ssh-ok"),
            "the remote command ran; output: {text}"
        );
        assert!(
            !text.to_lowercase().contains("password:"),
            "the password prompt was answered by askpass, not shown"
        );
        assert_eq!(code, 0, "ssh exit code; output: {text}");
    }
}
