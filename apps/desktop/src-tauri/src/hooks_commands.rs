//! Hook commands and mtime-based catalog state. Config home is injected in tests and isolated smoke.
use crate::{agent_commands::definition, agent_types::AgentInfo, error::AppError, state::AppState};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};
use tauri::Manager;
use tauri_specta::Event;
use tessera_agents::hooks::{Action, HookError, HookFiles, Kind, State};
use tessera_store::{
    Store,
    agents::{AgentInstall, now_millis},
};
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HookChange {
    pub config_path: String,
    pub state: String,
    pub diff: String,
}
type Stamp = (Option<SystemTime>, u64, Option<SystemTime>, u64, String);
#[derive(Default)]
pub struct Hooks {
    cache: Mutex<BTreeMap<PathBuf, (Stamp, State)>>,
}
pub(crate) fn home(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    #[cfg(debug_assertions)]
    if std::env::var_os("TESSERA_BENCH_ROOT").is_some()
        && let Some(home) = std::env::var_os("TESSERA_HOOKS_HOME")
    {
        return Ok(home.into());
    }
    app.path()
        .home_dir()
        .map_err(|_| AppError::new("hooks.write_failed", "The user home folder could not be resolved."))
}
pub(crate) fn cli_path() -> Result<String, AppError> {
    let path = std::env::current_exe()
        .map_err(|_| AppError::new("hooks.unsupported", "The bundled CLI could not be located."))?;
    Ok(path
        .parent()
        .ok_or_else(|| AppError::new("hooks.unsupported", "The bundled CLI folder could not be located."))?
        .join(if cfg!(windows) { "tessera.exe" } else { "tessera" })
        .to_string_lossy()
        .into_owned())
}
fn files(home: &Path, kind: Kind, cli: &str) -> HookFiles {
    HookFiles {
        path: match kind {
            Kind::Claude => home.join(".claude/settings.json"),
            Kind::Codex => home.join(".codex/config.toml"),
            Kind::Gemini => home.join(".gemini/settings.json"),
        },
        kind,
        cli: cli.into(),
    }
}
fn error(path: &Path, error: HookError) -> AppError {
    AppError::new(error.code(), format!("{}: {error}", path.display()))
}
fn stamp(path: &Path, cli: &str) -> Stamp {
    let metadata = std::fs::symlink_metadata(path).ok();
    let mut journal = path.as_os_str().to_os_string();
    journal.push(".tessera-state.json");
    let record = std::fs::metadata(PathBuf::from(journal)).ok();
    (
        metadata.as_ref().and_then(|m| m.modified().ok()),
        metadata.map_or(0, |m| m.len()),
        record.as_ref().and_then(|m| m.modified().ok()),
        record.map_or(0, |m| m.len()),
        cli.into(),
    )
}
fn persist(store: &Store, id: &str, state: &str) -> Result<(), AppError> {
    let mut install = store.agent_install_get(id)?.unwrap_or(AgentInstall {
        agent_id: id.into(),
        binary_path: None,
        version: None,
        detected_at: now_millis(),
        hooks_state: "none".into(),
    });
    if install.hooks_state != state {
        install.hooks_state = state.into();
        store.agent_install_save(&install)?;
    }
    Ok(())
}
impl Hooks {
    fn read_state(&self, files: &HookFiles) -> Result<State, AppError> {
        let stamp = stamp(&files.path, &files.cli);
        let mut cache = self.cache.lock().map_err(|_| AppError::lock_failed())?;
        if let Some((old, state)) = cache.get(&files.path)
            && old == &stamp
        {
            return Ok(*state);
        }
        let state = files.state();
        cache.insert(files.path.clone(), (stamp, state));
        Ok(state)
    }
    pub(crate) fn refresh(
        &self,
        store: &Store,
        rows: &mut [AgentInfo],
        home: &Path,
        cli: &str,
    ) -> Result<(), AppError> {
        for row in rows {
            let state = match Kind::parse(&row.hooks) {
                Ok(kind) => self.read_state(&files(home, kind, cli))?.as_str(),
                Err(_) => "unsupported",
            };
            row.hooks_state = state.into();
            if row.hooks != "none" {
                persist(store, &row.id, state)?;
            }
        }
        Ok(())
    }
}
async fn change(app: tauri::AppHandle, agent_id: String, action: Option<Action>) -> Result<HookChange, AppError> {
    let home = home(&app)?;
    let cli = cli_path()?;
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let def = definition(&state.dirs.root, &agent_id)?;
        let kind = Kind::parse(&def.hooks).map_err(|e| AppError::new(e.code(), e.to_string()))?;
        let files = files(&home, kind, &cli);
        // A preview shows the change the current state calls for: removal when ours is installed, else install
        // (which also updates an outdated entry). The UI's review dialog shows exactly this diff.
        let plan = match action {
            None if matches!(files.state(), State::Installed) => files.preview(Action::Remove),
            None => files.preview(Action::Install),
            Some(action) => files.apply(action),
        };
        let current = files.state();
        let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
        persist(&store, &agent_id, current.as_str())?;
        drop(store);
        handle
            .state::<Hooks>()
            .cache
            .lock()
            .map_err(|_| AppError::lock_failed())?
            .remove(&files.path);
        let plan = plan.map_err(|e| error(&files.path, e))?;
        Ok::<_, AppError>(HookChange {
            config_path: files.path.to_string_lossy().into_owned(),
            state: current.as_str().into(),
            diff: plan.diff,
        })
    })
    .await
    .map_err(|_| AppError::new("hooks.write_failed", "The hook worker failed."))?;
    if action.is_some() {
        crate::agent_commands::AgentsChanged
            .emit(&app)
            .map_err(|_| AppError::new("hooks.write_failed", "The agent change event could not be emitted."))?;
    }
    result
}
#[tauri::command]
#[specta::specta]
pub async fn hooks_preview(app: tauri::AppHandle, agent_id: String) -> Result<HookChange, AppError> {
    change(app, agent_id, None).await
}
#[tauri::command]
#[specta::specta]
pub async fn hooks_install(app: tauri::AppHandle, agent_id: String) -> Result<HookChange, AppError> {
    change(app, agent_id, Some(Action::Install)).await
}
#[tauri::command]
#[specta::specta]
pub async fn hooks_remove(app: tauri::AppHandle, agent_id: String) -> Result<HookChange, AppError> {
    change(app, agent_id, Some(Action::Remove)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hooks_catalog_tracks_mtime_and_persists_real_conflict_and_parse_states() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&tessera_store::DataDirs::from_root(tmp.path().join("data"))).unwrap();
        let catalog = crate::agent_commands::scan_catalog_for_hooks_test(&store, tmp.path());
        let mut rows = catalog;
        let runtime = Hooks::default();
        let home = tmp.path().join("home");
        let cli = "/fixture/tessera";
        runtime.refresh(&store, &mut rows, &home, cli).unwrap();
        assert_eq!(rows.iter().find(|r| r.id == "claude").unwrap().hooks_state, "none");
        let claude = files(&home, Kind::Claude, cli);
        claude.apply(Action::Install).unwrap();
        runtime.refresh(&store, &mut rows, &home, cli).unwrap();
        assert_eq!(rows.iter().find(|r| r.id == "claude").unwrap().hooks_state, "installed");
        assert_eq!(
            store.agent_install_get("claude").unwrap().unwrap().hooks_state,
            "installed"
        );
        runtime.refresh(&store, &mut rows, &home, "/new/cli").unwrap();
        assert_eq!(rows.iter().find(|r| r.id == "claude").unwrap().hooks_state, "outdated");
        std::fs::write(&claude.path, "{bad").unwrap();
        runtime.refresh(&store, &mut rows, &home, cli).unwrap();
        assert_eq!(
            rows.iter().find(|r| r.id == "claude").unwrap().hooks_state,
            "unparseable"
        );
        let codex = files(&home, Kind::Codex, cli);
        std::fs::create_dir_all(codex.path.parent().unwrap()).unwrap();
        std::fs::write(&codex.path, "notify=['user-notifier']\n").unwrap();
        runtime.refresh(&store, &mut rows, &home, cli).unwrap();
        assert_eq!(rows.iter().find(|r| r.id == "codex").unwrap().hooks_state, "conflict");
        assert_eq!(
            store.agent_install_get("codex").unwrap().unwrap().hooks_state,
            "conflict"
        );
    }
    #[test]
    fn hooks_installed_claude_command_reaches_api_and_agent_events_in_temp_home() {
        use serde_json::{Value, json};
        use std::{
            io::Write,
            process::{Command, Stdio},
            sync::Arc,
        };
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let executable = std::env::current_exe().unwrap();
        let cli =
            executable
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join(if cfg!(windows) { "tessera.exe" } else { "tessera" });
        assert!(
            cli.is_file(),
            "Build tessera-cli before this focused desktop test (workspace tests build it)."
        );
        let bin = home.join("CLI with $literal and 'quotes'");
        std::fs::create_dir_all(&bin).unwrap();
        let copied = bin.join(cli.file_name().unwrap());
        std::fs::copy(cli, &copied).unwrap();
        let files = files(&home, Kind::Claude, &copied.to_string_lossy());
        files.apply(Action::Install).unwrap();
        let config: Value = serde_json::from_str(&std::fs::read_to_string(&files.path).unwrap()).unwrap();
        let hook = &config["hooks"]["Notification"][0]["hooks"][0];
        let line = hook["command"].as_str().unwrap();
        let dirs = tessera_store::DataDirs::from_root(tmp.path().join("store"));
        let store = Store::open(&dirs).unwrap();
        store.agent_profiles().ensure_default("claude").unwrap();
        let profile = store.agent_profiles().list(None).unwrap()[0].id.clone();
        let session = store.agent_sessions().create(None, "claude", &profile, None).unwrap();
        store
            .agent_sessions()
            .set_pane_session(&session.id, "fixture-pane-session", "fixture-pane", 1)
            .unwrap();
        drop(store);
        let endpoint = tessera_api::Endpoint::new(tmp.path().join("api"));
        let db_dirs = dirs.clone();
        let _server = tessera_api::Server::start(
            endpoint.clone(),
            Arc::new(move |method: &str, params: Value| {
                if method != "hook.event" {
                    return Err(tessera_api::RpcError::method_not_found());
                }
                let store = Store::open(&db_dirs).map_err(|_| tessera_api::RpcError::invalid_state())?;
                crate::local_api::hook_event_for_test(&store, params)?;
                Ok(json!(null))
            }),
        )
        .unwrap();
        let mut command = if cfg!(windows) {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-NonInteractive", "-Command", line]);
            c
        } else {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", line]);
            c
        };
        let mut child = command
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("TESSERA_SOCKET", &endpoint.address)
            .env("TESSERA_API_TOKEN_FILE", &endpoint.token_file)
            .env("TESSERA_SESSION_ID", "fixture-pane-session")
            .env("TESSERA_AGENT", "claude")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(include_bytes!("../../../../fixtures/hooks/claude/Notification.json"))
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(output.stdout.is_empty());
        let store = Store::open(&dirs).unwrap();
        let events = store.agent_sessions().events(&session.id).unwrap();
        let event = events.iter().find(|e| e.kind == "hook").unwrap();
        let payload: Value = serde_json::from_str(&event.payload).unwrap();
        assert_eq!(payload["event"], "Notification");
        assert_eq!(payload["payload"]["hook_event_name"], "Notification");
    }
}
