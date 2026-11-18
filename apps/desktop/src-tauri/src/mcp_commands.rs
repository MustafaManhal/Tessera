//! MCP/skills manager boundary. Secrets stay in keyring (memory-only in disposable debug runs).
use crate::{error::AppError, state::AppState};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
use tessera_agents::{
    mcp_config::{self, Plan, Spec},
    mcp_probe,
};
use tessera_store::{
    Store,
    mcp::{Install, Server, Skill},
    repositories::new_id,
};
struct Pending {
    plan: Plan,
    record: Record,
    at: Instant,
}
enum Record {
    Mcp(Install, bool),
    Skill(String, String, bool),
}
#[derive(Default)]
struct Runtime {
    pending: BTreeMap<String, Pending>,
    secrets: BTreeMap<String, String>,
}
fn runtime() -> &'static Mutex<Runtime> {
    static STATE: OnceLock<Mutex<Runtime>> = OnceLock::new();
    STATE.get_or_init(Mutex::default)
}
fn err(message: impl Into<String>) -> AppError {
    AppError::new("manager.failed", message)
}
fn with_store<T>(app: &tauri::AppHandle, work: impl FnOnce(&Store) -> Result<T, String>) -> Result<T, AppError> {
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    work(&store).map_err(err)
}
fn isolated() -> bool {
    cfg!(debug_assertions) && std::env::var_os("TESSERA_BENCH_ROOT").is_some()
}
fn home(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    if isolated() && std::env::var_os("TESSERA_HOOKS_HOME").is_none() {
        return Err(err("Disposable runs require a temporary TESSERA_HOOKS_HOME."));
    }
    crate::hooks_commands::home(app)
}
fn secret(id: &str, key: &str, value: Option<Option<&str>>) -> Result<Option<String>, AppError> {
    let account = format!("{id}/{key}");
    if isolated() {
        let mut r = runtime().lock().map_err(|_| AppError::lock_failed())?;
        if let Some(value) = value {
            if let Some(value) = value {
                r.secrets.insert(account.clone(), value.into());
            } else {
                r.secrets.remove(&account);
            }
        }
        return Ok(r.secrets.get(&account).cloned());
    }
    let entry = keyring::Entry::new("tessera/mcp", &account).map_err(|_| err("Could not access the MCP keychain."))?;
    if let Some(value) = value {
        if let Some(value) = value {
            entry
                .set_password(value)
                .map_err(|_| err("Could not save the MCP secret."))?;
        } else {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(_) => return Err(err("Could not remove the MCP secret.")),
            }
        }
    }
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(err("Could not read the MCP secret.")),
    }
}
fn values(row: &Server) -> Result<BTreeMap<String, String>, AppError> {
    row.env_keys
        .iter()
        .filter_map(|k| match secret(&row.id, k, None) {
            Ok(Some(v)) => Some(Ok((k.clone(), v))),
            Ok(None) => None,
            Err(e) => Some(Err(e)),
        })
        .collect()
}
fn server(app: &tauri::AppHandle, id: &str) -> Result<Server, AppError> {
    with_store(app, |s| {
        s.mcp_list()?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("Server not found.".into())
    })
}
fn skill(app: &tauri::AppHandle, id: &str) -> Result<Skill, AppError> {
    with_store(app, |s| {
        s.skills_list()?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("Skill not found.".into())
    })
}
fn root(app: &tauri::AppHandle, target: &str) -> Result<(PathBuf, bool), AppError> {
    if target == "home" {
        return Ok((home(app)?, true));
    }
    let path = with_store(app, |s| {
        let task = s
            .tasks()
            .list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|t| t.id == target)
            .ok_or("Task not found.")?;
        task.worktree_path.ok_or("This task has no worktree.".into())
    })?;
    if path.starts_with("ssh:") {
        return Err(err("Remote worktree installs are not supported yet."));
    }
    Ok((PathBuf::from(path), false))
}
fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, AppError> {
    serde_json::from_value(v).map_err(|_| err("Invalid manager input."))
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, AppError> {
    v[key].as_str().ok_or_else(|| err(format!("Missing {key}.")))
}
fn cache(plan: Plan, record: Record) -> Result<Value, AppError> {
    let token = new_id();
    let result = json!({"token":token,"path":plan.path.to_string_lossy(),"preview":plan.preview});
    let mut r = runtime().lock().map_err(|_| AppError::lock_failed())?;
    r.pending.retain(|_, p| p.at.elapsed() < Duration::from_secs(600));
    if r.pending.len() >= 32 {
        r.pending.pop_first();
    }
    r.pending.insert(
        token,
        Pending {
            plan,
            record,
            at: Instant::now(),
        },
    );
    Ok(result)
}
// A user may delete a worktree or config outside the manager. Forget only confirmed missing files;
// permission errors and symlinks remain recorded. No agent file is modified by this reconciliation.
fn missing_file(path: &str) -> bool {
    matches!(std::fs::symlink_metadata(path), Err(e) if e.kind()==std::io::ErrorKind::NotFound)
}
fn reconcile_missing(app: &tauri::AppHandle) -> Result<(), AppError> {
    let (installs, skills) = with_store(app, |s| Ok((s.mcp_installs()?, s.skills_list()?)))?;
    let missing = installs
        .into_iter()
        .filter(|i| missing_file(&i.config_path))
        .collect::<Vec<_>>();
    let skills = skills
        .into_iter()
        .filter_map(|mut s| {
            let old = s.install_targets.len();
            s.install_targets.retain(|p| !missing_file(p));
            (old != s.install_targets.len()).then_some(s)
        })
        .collect::<Vec<_>>();
    with_store(app, |s| {
        for row in &missing {
            s.mcp_install_record(row, true)?;
        }
        for row in &skills {
            s.skill_targets(&row.id, &row.install_targets)?;
        }
        Ok(())
    })
}
pub(crate) fn dispatch(app: &tauri::AppHandle, operation: &str, input: Value) -> Result<Value, AppError> {
    static OPERATIONS: Mutex<()> = Mutex::new(());
    let _operation = OPERATIONS.lock().map_err(|_| AppError::lock_failed())?;
    if matches!(operation, "list" | "delete_server" | "delete_skill") {
        reconcile_missing(app)?;
    }
    match operation {
        "list" => {
            let (servers, installs, skills, tasks) = with_store(app, |s| {
                Ok((
                    s.mcp_list()?,
                    s.mcp_installs()?,
                    s.skills_list()?,
                    s.tasks().list().map_err(|e| e.to_string())?,
                ))
            })?;
            let agents = tessera_agents::Catalog::load(&app.state::<AppState>().dirs.root)
                .entries
                .into_iter()
                .map(|e| e.definition)
                .collect::<Vec<_>>();
            Ok(
                json!({"servers":servers,"installs":installs,"skills":skills,"tasks":tasks.iter().map(|t|json!({"id":t.id,"name":t.name,"remote":t.worktree_path.as_ref().is_some_and(|p|p.starts_with("ssh:"))})).collect::<Vec<_>>(),"agents":agents.iter().map(|a|json!({"id":a.id,"name":a.name,"manual":!matches!(a.id.as_str(),"claude"|"codex"|"gemini"|"opencode")})).collect::<Vec<_>>()}),
            )
        }
        "save_server" => {
            let row: Server = parse(input["server"].clone())?;
            row.validate().map_err(err)?;
            let old = if row.id.is_empty() {
                None
            } else {
                Some(server(app, &row.id)?)
            };
            let supplied: BTreeMap<String, String> = parse(input.get("values").cloned().unwrap_or(json!({})))?;
            if supplied
                .iter()
                .any(|(k, v)| !row.env_keys.contains(k) || v.len() > 65536)
            {
                return Err(err(
                    "Secrets must match the declared environment names and be at most 64 KiB.",
                ));
            }
            let row = with_store(app, |s| s.mcp_save(row))?;
            runtime().lock().map_err(|_| AppError::lock_failed())?.pending.clear();
            for (k, v) in supplied {
                secret(&row.id, &k, Some(if v.is_empty() { None } else { Some(&v) }))?;
            }
            if let Some(old) = old {
                for key in old.env_keys.iter().filter(|k| !row.env_keys.contains(k)) {
                    secret(&row.id, key, Some(None))?;
                }
            }
            Ok(json!(row))
        }
        "delete_server" => {
            let row = server(app, field(&input, "id")?)?;
            with_store(app, |s| {
                if s.mcp_installs()?.iter().any(|i| i.mcp_server_id == row.id) {
                    Err("Uninstall this server from its agent configs before deleting it.".into())
                } else {
                    Ok(())
                }
            })?;
            // Keep metadata available for retry if the keychain is locked or a credential deletion fails.
            for key in &row.env_keys {
                secret(&row.id, key, Some(None))?;
            }
            with_store(app, |s| s.mcp_delete(&row.id))?;
            runtime().lock().map_err(|_| AppError::lock_failed())?.pending.clear();
            Ok(Value::Null)
        }
        "save_skill" => {
            let row: Skill = parse(input)?;
            runtime().lock().map_err(|_| AppError::lock_failed())?.pending.clear();
            with_store(app, |s| s.skill_save(row)).map(|r| json!(r))
        }
        "delete_skill" => {
            runtime().lock().map_err(|_| AppError::lock_failed())?.pending.clear();
            with_store(app, |s| {
                s.skill_delete(field(&input, "id").map_err(|e| e.message)?.as_ref())
            })?;
            Ok(Value::Null)
        }
        "test" => {
            let row = server(app, field(&input, "id")?)?;
            let values = values(&row)?;
            let result = if row.transport == "stdio" {
                mcp_probe::stdio(&row.command, &row.args, &values, Duration::from_secs(10))
            } else {
                mcp_probe::http(&row.url, Duration::from_secs(10))
            };
            let mut tools = result.map_err(err)?;
            for name in &mut tools {
                for value in values.values().filter(|s| !s.is_empty()) {
                    *name = name.replace(value, "<redacted>");
                }
            }
            Ok(json!({"tools":tools}))
        }
        "preview_server" => {
            let row = server(app, field(&input, "id")?)?;
            let agent = field(&input, "agent")?;
            let spec: Spec = parse(json!(row))?;
            let target = field(&input, "target")?;
            let (root, is_home) = root(app, target)?;
            let remove = input["remove"] == true;
            if !matches!(agent, "claude" | "codex" | "gemini" | "opencode") || (agent == "codex" && !is_home) {
                return Ok(json!({"manual":true,"preview":mcp_config::snippet(&spec,agent)}));
            }
            let write_values = input["write_values"] == true && !remove;
            let values = if write_values { values(&row)? } else { BTreeMap::new() };
            if write_values && row.env_keys.iter().any(|k| !values.contains_key(k)) {
                return Err(err(
                    "Save a keychain value for each environment name before writing values.",
                ));
            }
            let home = home(app)?;
            let plan = mcp_config::plan_mcp(
                &home,
                if is_home { None } else { Some(&root) },
                agent,
                &spec,
                &values,
                write_values,
                remove,
            )
            .map_err(err)?;
            let path = plan.path.to_string_lossy().to_string();
            cache(
                plan,
                Record::Mcp(
                    Install {
                        mcp_server_id: row.id,
                        agent_id: agent.into(),
                        config_path: path,
                    },
                    remove,
                ),
            )
        }
        "preview_skill" => {
            let row = skill(app, field(&input, "id")?)?;
            let (root, is_home) = root(app, field(&input, "target")?)?;
            let remove = input["remove"] == true;
            let plan = mcp_config::plan_skill(&root, &row.id, &row.name, &row.kind, &row.body, remove, is_home)
                .map_err(err)?;
            let path = plan.path.to_string_lossy().to_string();
            cache(plan, Record::Skill(row.id, path, remove))
        }
        "apply" => {
            let token = field(&input, "token")?;
            let pending = runtime()
                .lock()
                .map_err(|_| AppError::lock_failed())?
                .pending
                .remove(token)
                .ok_or_else(|| err("Preview expired. Preview this change again."))?;
            if pending.at.elapsed() > Duration::from_secs(600) {
                return Err(err("Preview expired. Preview again."));
            }
            let backup = pending.plan.apply().map_err(err)?;
            match pending.record {
                Record::Mcp(record, remove) => with_store(app, |s| s.mcp_install_record(&record, remove))?,
                Record::Skill(id, path, remove) => {
                    let mut row = skill(app, &id)?;
                    row.install_targets.retain(|p| p != &path);
                    if !remove {
                        row.install_targets.push(path)
                    }
                    with_store(app, |s| s.skill_targets(&id, &row.install_targets))?;
                }
            }
            Ok(json!({"backup":backup.to_string_lossy()}))
        }
        _ => Err(err("Unknown manager operation.")),
    }
}
#[tauri::command]
#[specta::specta]
pub async fn manager_call(app: tauri::AppHandle, operation: String, input: String) -> Result<String, AppError> {
    if input.len() > 1024 * 1024 {
        return Err(err("Manager request exceeds 1 MiB."));
    }
    let input: Value = parse_json(&input)?;
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, &operation, input).map(|v| v.to_string()))
        .await
        .map_err(|_| err("The manager worker failed."))?
}
fn parse_json(text: &str) -> Result<Value, AppError> {
    serde_json::from_str(text).map_err(|_| err("Invalid manager JSON."))
}

/// Isolated native proof. Inert unless all explicit fixture roots/executable/output are supplied.
#[cfg(debug_assertions)]
pub(crate) fn start_smoke(app: &tauri::AppHandle) {
    if !isolated() || std::env::var_os("TESSERA_MANAGER_SMOKE").is_none() {
        return;
    }
    let Some(exe) = std::env::var_os("TESSERA_MCP_FIXTURE_EXE") else {
        return;
    };
    let Some(out) = std::env::var_os("TESSERA_SHOTS_DIR") else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<Value, AppError> {
            let home = home(&app)?;
            std::fs::create_dir_all(&home).map_err(|_| err("Cannot create fixture home."))?;
            let config = home.join(".claude.json");
            std::fs::write(
                &config,
                r#"{"foreign":true,"mcpServers":{"foreign":{"command":"kept"}}}"#,
            )
            .map_err(|_| err("Cannot seed fixture config."))?;
            let row = dispatch(
                &app,
                "save_server",
                json!({"server":{"id":"","name":"native-fixture","transport":"stdio","command":exe.to_string_lossy(),"args":[],"url":"","env_keys":["FIXTURE_SECRET"]},"values":{"FIXTURE_SECRET":"fixture-secret-never-persist"}}),
            )?;
            let tested = dispatch(&app, "test", json!({"id":row["id"]}))?;
            let before = std::fs::read_to_string(&config).map_err(|_| err("Cannot inspect fixture."))?;
            let preview = dispatch(
                &app,
                "preview_server",
                json!({"id":row["id"],"agent":"claude","target":"home","write_values":false}),
            )?;
            let preview_only = std::fs::read_to_string(&config).ok().as_deref() == Some(&before);
            let applied = dispatch(&app, "apply", json!({"token":preview["token"]}))?;
            let installed: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
            let installed_status = dispatch(&app, "list", json!({}))?;
            let remove = dispatch(
                &app,
                "preview_server",
                json!({"id":row["id"],"agent":"claude","target":"home","remove":true}),
            )?;
            dispatch(&app, "apply", json!({"token":remove["token"]}))?;
            let after: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
            let skill = dispatch(
                &app,
                "save_skill",
                json!({"id":"","name":"native-review","kind":"agents_md","body":"# Review carefully","install_targets":[]}),
            )?;
            let plan = dispatch(&app, "preview_skill", json!({"id":skill["id"],"target":"home"}))?;
            dispatch(&app, "apply", json!({"token":plan["token"]}))?;
            let undo = dispatch(
                &app,
                "preview_skill",
                json!({"id":skill["id"],"target":"home","remove":true}),
            )?;
            dispatch(&app, "apply", json!({"token":undo["token"]}))?;
            let absent = home.join("deleted-worktree/config.json").to_string_lossy().to_string();
            with_store(&app, |s| {
                s.mcp_install_record(
                    &Install {
                        mcp_server_id: row["id"].as_str().unwrap().into(),
                        agent_id: "claude".into(),
                        config_path: absent.clone(),
                    },
                    false,
                )?;
                s.skill_targets(skill["id"].as_str().unwrap(), std::slice::from_ref(&absent))
            })?;
            let reconciled = dispatch(&app, "list", json!({}))?;
            let missing_records_removed = reconciled["installs"].as_array().is_some_and(Vec::is_empty)
                && reconciled["skills"].as_array().is_some_and(|rows| {
                    rows.iter()
                        .all(|s| s["install_targets"].as_array().is_some_and(Vec::is_empty))
                });
            if !missing_records_removed {
                return Err(err("Missing target records were not reconciled."));
            }
            let serialized = serde_json::to_string(&dispatch(&app, "list", json!({}))?).unwrap();
            let ok = preview_only
                && tested["tools"][0] == "fixture_tool"
                && installed["foreign"] == true
                && after["mcpServers"]["foreign"]["command"] == "kept"
                && after["mcpServers"].as_object().unwrap().len() == 1
                && !serialized.contains("fixture-secret-never-persist")
                && !installed.to_string().contains("fixture-secret-never-persist");
            Ok(
                json!({"ok":ok,"source":"native debug manager, isolated memory vault and temporary home","tested":tested,"preview_only":preview_only,"preview":preview,"applied":applied,"installed":installed,"installs":installed_status["installs"],"after_uninstall":after,"missing_records_removed":missing_records_removed,"metadata_has_no_secret_values":!serialized.contains("fixture-secret-never-persist")}),
            )
        })();
        let evidence = match result {
            Ok(v) => v,
            Err(e) => json!({"ok":false,"error":e.message}),
        };
        let out = PathBuf::from(out);
        let _ = std::fs::create_dir_all(&out);
        let _ = std::fs::write(
            out.join("manager-native.json"),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_target_detection_does_not_claim_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("target");
        assert!(missing_file(path.to_str().unwrap()));
        std::fs::write(&path, "foreign").unwrap();
        assert!(!missing_file(path.to_str().unwrap()));
        assert!(!missing_file(tmp.path().to_str().unwrap()));
        #[cfg(target_os = "macos")]
        {
            let link = tmp.path().join("link");
            std::os::unix::fs::symlink(tmp.path().join("absent"), &link).unwrap();
            assert!(!missing_file(link.to_str().unwrap()));
        }
    }
}
