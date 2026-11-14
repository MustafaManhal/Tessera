//! Catalog and profiles. All filesystem, CLI and SQLite work uses the blocking pool.
use crate::{agent_types::*, error::AppError, project_commands::with_store, state::AppState};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{ffi::OsStr, path::Path, sync::Mutex};
use tauri::Manager;
use tauri_specta::Event;
use tessera_agents::{AgentDefinition, Catalog, Detector, command_line};
use tessera_store::{
    Store,
    agents::{AgentInstall, now_millis},
};

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "agents:changed")]
pub struct AgentsChanged;
/// Separate locks let cached catalog reads finish even during a rescan.
pub struct Agents {
    catalog: Mutex<Option<Vec<AgentInfo>>>,
    detector: Mutex<Detector>,
    scan: Mutex<()>,
}
impl Default for Agents {
    fn default() -> Self {
        Self {
            catalog: Mutex::default(),
            detector: Mutex::new(Detector::wide()),
            scan: Mutex::default(),
        }
    }
}
pub(crate) fn env_value<'a>(env: &'a std::collections::BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}
fn invalid_definition(message: impl Into<String>) -> AppError {
    AppError::new("agent.definition_invalid", message)
}
fn profile_missing() -> AppError {
    AppError::new("agent.profile_not_found", "The agent profile could not be found.")
}
pub(crate) fn definition(config: &Path, id: &str) -> Result<AgentDefinition, AppError> {
    let catalog = Catalog::load(config);
    if let Some(entry) = catalog.entries.into_iter().find(|e| e.definition.id == id) {
        return Ok(entry.definition);
    }
    if let Some(error) = catalog.rejected_ids.get(id) {
        return Err(invalid_definition(error.message.clone()));
    }
    Err(AppError::new(
        "agent.unknown",
        "The agent definition could not be found.",
    ))
}
fn changed(app: &tauri::AppHandle) -> Result<(), AppError> {
    AgentsChanged.emit(app).map_err(|e| {
        AppError::new(
            "agent.event_failed",
            format!("The agent change event could not be sent: {e}."),
        )
    })
}
/// Pure backend operation also used by fake-PATH acceptance tests.
fn scan_catalog(
    store: &Store,
    config: &Path,
    path: &OsStr,
    pathext: &str,
    detector: &mut Detector,
    rescan: bool,
) -> Result<Vec<AgentInfo>, AppError> {
    let catalog = Catalog::load(config);
    let mut result = Vec::new();
    for entry in &catalog.entries {
        let def = &entry.definition;
        let detection = detector.detect(def, path, pathext, rescan);
        let previous = store.agent_install_get(&def.id)?;
        let installed = detection.binary_path.is_some();
        if installed && previous.as_ref().is_none_or(|p| p.binary_path.is_none()) {
            store.agent_profiles().ensure_default(&def.id)?;
        }
        let hooks_state = if def.hooks == "none" {
            "unsupported".into()
        } else {
            previous
                .as_ref()
                .map(|p| p.hooks_state.clone())
                .unwrap_or("none".into())
        };
        let at = now_millis();
        let binary_path = detection.binary_path.map(|p| p.to_string_lossy().into_owned());
        if installed || previous.is_some() {
            store.agent_install_save(&AgentInstall {
                agent_id: def.id.clone(),
                binary_path: binary_path.clone(),
                version: detection.version.clone(),
                detected_at: at,
                hooks_state: hooks_state.clone(),
            })?;
        }
        let mut diagnostics: Vec<_> = entry
            .errors
            .iter()
            .map(|e| {
                format!(
                    "{}{}: {}",
                    e.file.display(),
                    e.line.map(|n| format!(":{n}")).unwrap_or_default(),
                    e.message
                )
            })
            .collect();
        if let Some(error) = detection.error {
            diagnostics.push(error);
        }
        result.push(AgentInfo {
            id: def.id.clone(),
            name: def.name.clone(),
            icon: def.icon.clone(),
            installed,
            binary_path,
            version: detection.version,
            install_url: def.install_url.clone(),
            docs_url: def.docs_url.clone(),
            prompt_mode: def.prompt_mode.clone(),
            supports_resume: !def.resume.is_empty(),
            hooks: def.hooks.clone(),
            hooks_state,
            has_skip_permissions: !def.yolo_flags.is_empty(),
            source: entry.source.clone(),
            definition_error: (!diagnostics.is_empty()).then(|| diagnostics.join("\n")),
            detected_at: installed.then_some(at),
        });
    }
    // Files without a usable definition still need a UI-visible diagnostic row.
    for error in &catalog.errors {
        if catalog
            .entries
            .iter()
            .any(|e| e.errors.iter().any(|d| d.file == error.file))
        {
            continue;
        }
        let id = error
            .file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("invalid-definition")
            .to_string();
        if let Some(row) = result.iter_mut().find(|r| r.id == id) {
            let message = format!("{}: {}", error.file.display(), error.message);
            row.definition_error = Some(match row.definition_error.take() {
                Some(previous) => format!("{previous}\n{message}"),
                None => message,
            });
            continue;
        }
        result.push(AgentInfo {
            name: format!("Invalid definition ({id})"),
            id,
            icon: "triangle-alert".into(),
            installed: false,
            binary_path: None,
            version: None,
            install_url: String::new(),
            docs_url: String::new(),
            prompt_mode: "type".into(),
            supports_resume: false,
            hooks: "none".into(),
            hooks_state: "unsupported".into(),
            has_skip_permissions: false,
            source: "user".into(),
            definition_error: Some(format!("{}: {}", error.file.display(), error.message)),
            detected_at: None,
        });
    }
    Ok(result)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_catalog(app: tauri::AppHandle, rescan: bool) -> Result<Vec<AgentInfo>, AppError> {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let agents = handle.state::<Agents>();
        let cached = if !rescan {
            agents.catalog.lock().map_err(|_| AppError::lock_failed())?.clone()
        } else {
            None
        };
        let had_cached = cached.is_some();
        let _scan = if had_cached {
            None
        } else {
            Some(agents.scan.lock().map_err(|_| AppError::lock_failed())?)
        };
        let state = handle.state::<AppState>();
        let env = state.pty.login_environment_snapshot();
        let path = env_value(&env, "PATH").unwrap_or_default().to_string();
        let pathext = env_value(&env, "PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD");
        // Do not hold the database lock while waiting on CLI version processes.
        let store = Store::open(&state.dirs)?;
        let home = crate::hooks_commands::home(&handle)?;
        let cli = crate::hooks_commands::cli_path()?;
        let mut rows = if let Some(rows) = cached {
            rows
        } else {
            let mut detector = agents.detector.lock().map_err(|_| AppError::lock_failed())?;
            scan_catalog(
                &store,
                state.dirs.config_dir(),
                OsStr::new(&path),
                pathext,
                &mut detector,
                rescan,
            )?
        };
        handle
            .state::<crate::hooks_commands::Hooks>()
            .refresh(&store, &mut rows, &home, &cli)?;
        if !had_cached {
            *agents.catalog.lock().map_err(|_| AppError::lock_failed())? = Some(rows.clone());
        }
        Ok::<_, AppError>(rows)
    })
    .await
    .map_err(|e| invalid_definition(format!("The catalog worker failed: {e}.")))??;
    if rescan {
        changed(&app)?;
    }
    Ok(result)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_profiles_list(
    app: tauri::AppHandle,
    agent_id: Option<String>,
) -> Result<Vec<AgentProfile>, AppError> {
    with_store(app, move |store| {
        store
            .agent_profiles()
            .list(agent_id.as_deref())?
            .into_iter()
            .map(AgentProfile::try_from)
            .collect()
    })
    .await
}
fn validate_profile(profile: &AgentProfileInput) -> Result<(), AppError> {
    let valid_env = profile.env.keys().all(|key| {
        let mut chars = key.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    });
    if profile.name.trim().is_empty() || !valid_env {
        return Err(AppError::new(
            "agent.profile_invalid",
            "The profile needs a name and valid environment variable names.",
        ));
    }
    if profile.extra_args.iter().any(|s| s.contains('\0'))
        || profile.env.values().any(|s| s.contains('\0'))
        || profile.model.as_ref().is_some_and(|s| s.contains('\0'))
    {
        return Err(AppError::new(
            "agent.profile_invalid",
            "Profile arguments and environment values must not contain NUL characters.",
        ));
    }
    Ok(())
}
fn save_profile(store: &Store, config: &Path, profile: AgentProfileInput) -> Result<AgentProfile, AppError> {
    validate_profile(&profile)?;
    let def = definition(config, &profile.agent_id)?;
    command_line(
        &def,
        &tessera_agents::LaunchProfile {
            model: profile.model.clone(),
            extra_args: profile.extra_args.clone(),
            env: profile.env.clone(),
            skip_permissions: profile.skip_permissions,
        },
        None,
    )
    .map_err(|e| AppError::new("agent.profile_invalid", e))?;
    let input = tessera_store::agents::AgentProfileInput {
        id: profile.id,
        agent_id: profile.agent_id,
        name: profile.name,
        model: profile.model,
        extra_args: serde_json::to_string(&profile.extra_args).map_err(|e| {
            AppError::new(
                "agent.profile_invalid",
                format!("The profile arguments could not be encoded: {e}."),
            )
        })?,
        env: serde_json::to_string(&profile.env).map_err(|e| {
            AppError::new(
                "agent.profile_invalid",
                format!("The profile environment could not be encoded: {e}."),
            )
        })?,
        skip_permissions: profile.skip_permissions,
        is_default: profile.is_default,
    };
    store
        .agent_profiles()
        .save(input)?
        .ok_or_else(profile_missing)?
        .try_into()
}
#[tauri::command]
#[specta::specta]
pub async fn agent_profile_save(app: tauri::AppHandle, profile: AgentProfileInput) -> Result<AgentProfile, AppError> {
    let config = app.state::<AppState>().dirs.root.clone();
    let saved = with_store(app.clone(), move |store| save_profile(store, &config, profile)).await?;
    changed(&app)?;
    Ok(saved)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_profile_delete(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    with_store(app.clone(), move |store| {
        if !store.agent_profiles().delete(&id)? {
            return Err(profile_missing());
        }
        Ok(())
    })
    .await?;
    changed(&app)
}
fn preview(
    store: &Store,
    config: &Path,
    profile_id: &str,
    prompt: Option<&str>,
    path: &OsStr,
    pathext: &str,
) -> Result<CommandPreview, AppError> {
    let profile = AgentProfile::try_from(store.agent_profiles().get(profile_id)?.ok_or_else(profile_missing)?)?;
    let def = definition(config, &profile.agent_id)?;
    let mut command =
        command_line(&def, &profile.launch_profile(), prompt).map_err(|e| AppError::new("agent.profile_invalid", e))?;
    if let Some(binary) = tessera_agents::detection::find_binary_wide(&def.binaries, path, cfg!(windows), pathext) {
        command.program = binary.to_string_lossy().into_owned();
    }
    Ok(CommandPreview {
        program: command.program,
        args: command.args,
        env_keys: command.env.into_keys().collect(),
        prompt_mode: def.prompt_mode,
        skip_permissions: profile.skip_permissions,
    })
}
#[tauri::command]
#[specta::specta]
pub async fn agent_command_preview(
    app: tauri::AppHandle,
    profile_id: String,
    prompt: Option<String>,
) -> Result<CommandPreview, AppError> {
    let state = app.state::<AppState>();
    let config = state.dirs.root.clone();
    let env = state.pty.login_environment_snapshot();
    with_store(app, move |store| {
        preview(
            store,
            &config,
            &profile_id,
            prompt.as_deref(),
            OsStr::new(env_value(&env, "PATH").unwrap_or("")),
            env_value(&env, "PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD"),
        )
    })
    .await
}

// --- Custom agent definitions (FR-34): user files under `<config>/agents/`. -------------------------

/// Everything the custom-agent dialog edits. `status-patterns` and `usage` stay in the file on a
/// re-save (the dialog does not expose them) and `hooks` is always "none" for a custom CLI.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentDefinitionInput {
    pub id: String,
    pub name: String,
    pub binaries: Vec<String>,
    pub version_cmd: Vec<String>,
    pub prompt_mode: String,
    pub model_flag: Option<String>,
    pub resume: Vec<String>,
    pub yolo_flags: Vec<String>,
    pub hooks: String,
    pub ready_pattern: Option<String>,
    pub install_url: String,
    pub docs_url: String,
    pub icon: String,
    /// Explicit consent to reuse a bundled id; without it the save is refused as a duplicate.
    pub allow_override: bool,
}
/// What `agent_definition_test` reports: detection on the login PATH, version command only.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentDefinitionTest {
    pub found: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}
fn definition_input(def: &AgentDefinition) -> AgentDefinitionInput {
    AgentDefinitionInput {
        id: def.id.clone(),
        name: def.name.clone(),
        binaries: def.binaries.clone(),
        version_cmd: def.version_cmd.clone(),
        prompt_mode: def.prompt_mode.clone(),
        model_flag: def.model_flag.clone(),
        resume: def.resume.clone(),
        yolo_flags: def.yolo_flags.clone(),
        hooks: def.hooks.clone(),
        ready_pattern: def.ready_pattern.clone(),
        install_url: def.install_url.clone(),
        docs_url: def.docs_url.clone(),
        icon: def.icon.clone(),
        allow_override: false,
    }
}
/// Drops the cached catalog and tells the front end to reload, like a rescan does.
fn catalog_changed(app: &tauri::AppHandle) -> Result<(), AppError> {
    *app.state::<Agents>()
        .catalog
        .lock()
        .map_err(|_| AppError::lock_failed())? = None;
    changed(app)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_definition_get(app: tauri::AppHandle, id: String) -> Result<AgentDefinitionInput, AppError> {
    let config = app.state::<AppState>().dirs.root.clone();
    tauri::async_runtime::spawn_blocking(move || definition(&config, &id).map(|d| definition_input(&d)))
        .await
        .map_err(|e| invalid_definition(format!("The definition worker failed: {e}.")))?
}
/// Validates and writes one custom definition; bundled ids need `allow_override`.
fn save_definition_input(config: &Path, input: AgentDefinitionInput) -> Result<(), AppError> {
    if tessera_agents::is_bundled_id(&input.id) && !input.allow_override {
        return Err(AppError::new(
            "agent.definition_duplicate",
            format!(
                "The id {:?} belongs to a bundled agent; confirm the override to replace its fields.",
                input.id
            ),
        ));
    }
    let def = AgentDefinition {
        id: input.id,
        name: input.name,
        binaries: input.binaries,
        version_cmd: input.version_cmd,
        prompt_mode: input.prompt_mode,
        model_flag: input.model_flag,
        resume: input.resume,
        yolo_flags: input.yolo_flags,
        hooks: input.hooks,
        ready_pattern: input.ready_pattern,
        status_patterns: Default::default(),
        usage: Default::default(),
        install_url: input.install_url,
        docs_url: input.docs_url,
        icon: input.icon,
    };
    tessera_agents::save_definition(config, &def)
        .map_err(invalid_definition)
        .map(|_| ())
}
/// Deletes a custom definition once no profile still uses its agent.
fn delete_definition_checked(store: &Store, config: &Path, id: &str) -> Result<(), AppError> {
    if !tessera_agents::valid_id(id) {
        return Err(invalid_definition(format!(
            "The id {id:?} may only use lower-case letters, digits and dashes."
        )));
    }
    if !config.join("agents").join(format!("{id}.toml")).is_file() {
        return Err(AppError::new(
            "agent.definition_not_found",
            "The custom agent definition could not be found.",
        ));
    }
    let profiles = store.agent_profiles().list(Some(id))?;
    if !profiles.is_empty() {
        let names = profiles.iter().map(|p| p.name.clone()).collect::<Vec<_>>().join(", ");
        return Err(AppError::new(
            "agent.definition_in_use",
            format!("Delete or reassign these profiles first: {names}."),
        ));
    }
    tessera_agents::delete_definition(config, id)
        .map_err(invalid_definition)
        .map(|_| ())
}
/// Detection for the dialog's Test button: the version command on the login PATH, never a prompt.
fn test_definition(
    path: &OsStr,
    pathext: &str,
    binaries: Vec<String>,
    version_cmd: Vec<String>,
) -> Result<AgentDefinitionTest, AppError> {
    let def = AgentDefinition {
        id: "definition-test".into(),
        name: "Definition test".into(),
        binaries,
        version_cmd,
        prompt_mode: "type".into(),
        model_flag: None,
        resume: vec![],
        yolo_flags: vec![],
        hooks: "none".into(),
        ready_pattern: None,
        status_patterns: Default::default(),
        usage: Default::default(),
        install_url: "https://".into(),
        docs_url: "https://".into(),
        icon: "bot".into(),
    };
    def.validate().map_err(invalid_definition)?;
    let mut detector = Detector::wide();
    let detection = detector.detect(&def, path, pathext, true);
    Ok(AgentDefinitionTest {
        found: detection.binary_path.is_some(),
        binary_path: detection.binary_path.map(|p| p.to_string_lossy().into_owned()),
        version: detection.version,
        error: detection.error,
    })
}
#[tauri::command]
#[specta::specta]
pub async fn agent_definition_save(app: tauri::AppHandle, input: AgentDefinitionInput) -> Result<(), AppError> {
    let config = app.state::<AppState>().dirs.root.clone();
    tauri::async_runtime::spawn_blocking(move || save_definition_input(&config, input))
        .await
        .map_err(|e| invalid_definition(format!("The definition worker failed: {e}.")))??;
    catalog_changed(&app)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_definition_delete(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    let config = app.state::<AppState>().dirs.root.clone();
    with_store(app.clone(), move |store| delete_definition_checked(store, &config, &id)).await?;
    catalog_changed(&app)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_definition_test(
    app: tauri::AppHandle,
    binaries: Vec<String>,
    version_cmd: Vec<String>,
) -> Result<AgentDefinitionTest, AppError> {
    let state = app.state::<AppState>();
    let env = state.pty.login_environment_snapshot();
    let path = env_value(&env, "PATH").unwrap_or_default().to_string();
    let pathext = env_value(&env, "PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD").to_string();
    tauri::async_runtime::spawn_blocking(move || test_definition(OsStr::new(&path), &pathext, binaries, version_cmd))
        .await
        .map_err(|e| invalid_definition(format!("The detection worker failed: {e}.")))?
}

#[cfg(test)]
pub(crate) fn scan_catalog_for_hooks_test(store: &Store, config: &Path) -> Vec<AgentInfo> {
    scan_catalog(store, config, OsStr::new(""), "", &mut Detector::default(), true).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> AgentProfileInput {
        AgentProfileInput {
            id: None,
            agent_id: "claude".into(),
            name: "Work".into(),
            model: None,
            extra_args: vec![],
            env: Default::default(),
            skip_permissions: false,
            is_default: true,
        }
    }
    #[test]
    fn windows_environment_casing_and_invalid_file_diagnostics() {
        let env = [
            ("Path".into(), "fixture-path".into()),
            ("PathExt".into(), ".EXE;.CMD".into()),
        ]
        .into();
        assert_eq!(env_value(&env, "PATH"), Some("fixture-path"));
        assert_eq!(env_value(&env, "PATHEXT"), Some(".EXE;.CMD"));
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("agents")).unwrap();
        std::fs::write(tmp.path().join("agents/claude.toml"), "id = [").unwrap();
        let store = Store::open(&tessera_store::DataDirs::from_root(tmp.path().join("data"))).unwrap();
        let rows = scan_catalog(&store, tmp.path(), OsStr::new(""), "", &mut Detector::default(), true).unwrap();
        assert_eq!(rows.len(), 10);
        assert!(
            rows[0]
                .definition_error
                .as_ref()
                .unwrap()
                .contains("could not be parsed")
        );
        assert_eq!(rows[0].name, "Claude Code");
    }
    #[test]
    fn profile_command_errors_and_preview_redaction() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&tessera_store::DataDirs::from_root(tmp.path())).unwrap();
        let mut p = input();
        p.name = " ".into();
        assert_eq!(
            save_profile(&store, tmp.path(), p).unwrap_err().code,
            "agent.profile_invalid"
        );
        for key in ["", "1BAD", "BAD-NAME", "é"] {
            let mut p = input();
            p.env.insert(key.into(), "value".into());
            assert_eq!(
                save_profile(&store, tmp.path(), p).unwrap_err().code,
                "agent.profile_invalid"
            );
        }
        let mut p = input();
        p.agent_id = "missing".into();
        assert_eq!(save_profile(&store, tmp.path(), p).unwrap_err().code, "agent.unknown");
        let mut p = input();
        p.id = Some("missing".into());
        assert_eq!(
            save_profile(&store, tmp.path(), p).unwrap_err().code,
            "agent.profile_not_found"
        );
        assert_eq!(
            preview(&store, tmp.path(), "missing", None, OsStr::new(""), "")
                .unwrap_err()
                .code,
            "agent.profile_not_found"
        );
        std::fs::create_dir(tmp.path().join("agents")).unwrap();
        std::fs::write(tmp.path().join("agents/custom.toml"), "id='custom'\nname=''").unwrap();
        let mut p = input();
        p.agent_id = "custom".into();
        assert_eq!(
            save_profile(&store, tmp.path(), p).unwrap_err().code,
            "agent.definition_invalid"
        );
        let mut p = input();
        p.extra_args = vec!["--dangerously-skip-permissions".into()];
        assert_eq!(
            save_profile(&store, tmp.path(), p).unwrap_err().code,
            "agent.profile_invalid"
        );
        let mut p = input();
        p.env.insert("PLAIN_OPTION".into(), "do-not-show-value".into());
        let saved = save_profile(&store, tmp.path(), p).unwrap();
        assert!(saved.created_at > 1_000_000_000_000);
        let preview = preview(&store, tmp.path(), &saved.id, Some("hello"), OsStr::new(""), "").unwrap();
        assert_eq!(preview.env_keys, ["PLAIN_OPTION"]);
        assert!(!serde_json::to_string(&preview).unwrap().contains("do-not-show-value"));
        assert!(!preview.skip_permissions);
    }
    fn definition_input(id: &str) -> AgentDefinitionInput {
        AgentDefinitionInput {
            id: id.into(),
            name: "Custom CLI".into(),
            binaries: vec!["customcli".into()],
            version_cmd: vec!["customcli".into(), "--version".into()],
            prompt_mode: "arg".into(),
            model_flag: None,
            resume: vec![],
            yolo_flags: vec![],
            hooks: "none".into(),
            ready_pattern: None,
            install_url: "customcli".into(),
            docs_url: "https://".into(),
            icon: "bot".into(),
            allow_override: false,
        }
    }
    #[test]
    fn custom_definition_save_get_delete_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&tessera_store::DataDirs::from_root(tmp.path().join("data"))).unwrap();
        save_definition_input(tmp.path(), definition_input("mycli")).unwrap();
        // The catalog sees it as a user definition.
        let rows = scan_catalog(&store, tmp.path(), OsStr::new(""), "", &mut Detector::default(), true).unwrap();
        let row = rows.iter().find(|r| r.id == "mycli").unwrap();
        assert_eq!(row.source, "user");
        assert!(!row.installed);
        // Get returns the stored fields for the editor.
        let got = definition(tmp.path(), "mycli").unwrap();
        assert_eq!(got.name, "Custom CLI");
        assert_eq!(got.binaries, ["customcli"]);
        // A default profile can be created for it like any other agent.
        store.agent_profiles().ensure_default("mycli").unwrap();
        assert_eq!(store.agent_profiles().list(Some("mycli")).unwrap().len(), 1);
        // Delete is blocked while a profile uses it, then succeeds.
        let error = delete_definition_checked(&store, tmp.path(), "mycli").unwrap_err();
        assert_eq!(error.code, "agent.definition_in_use");
        assert!(error.message.contains("Default"));
        store
            .agent_profiles()
            .delete(&store.agent_profiles().list(Some("mycli")).unwrap()[0].id)
            .unwrap();
        delete_definition_checked(&store, tmp.path(), "mycli").unwrap();
        assert!(!tmp.path().join("agents/mycli.toml").exists());
        assert!(delete_definition_checked(&store, tmp.path(), "mycli").is_err());
    }
    #[test]
    fn custom_definition_save_refuses_bundled_duplicate_and_bad_regex() {
        let tmp = tempfile::tempdir().unwrap();
        let error = save_definition_input(tmp.path(), definition_input("claude")).unwrap_err();
        assert_eq!(error.code, "agent.definition_duplicate");
        assert!(!tmp.path().join("agents/claude.toml").exists());
        // Explicit override consent writes the file; the catalog reports source "override".
        let mut input = definition_input("claude");
        input.allow_override = true;
        input.name = "My Claude".into();
        save_definition_input(tmp.path(), input).unwrap();
        let catalog = Catalog::load(tmp.path());
        let entry = catalog.entries.iter().find(|e| e.definition.id == "claude").unwrap();
        assert_eq!(entry.source, "override");
        assert_eq!(entry.definition.name, "My Claude");
        // Invalid regex is refused before anything is written.
        let mut bad = definition_input("badregex");
        bad.ready_pattern = Some("[".into());
        let error = save_definition_input(tmp.path(), bad).unwrap_err();
        assert_eq!(error.code, "agent.definition_invalid");
        assert!(error.message.contains("ready-pattern"));
        assert!(!tmp.path().join("agents/badregex.toml").exists());
    }
    // The fixture is a /bin/sh script; Windows detection of `.cmd` shims is covered by the detection tests.
    #[cfg(unix)]
    #[test]
    fn definition_test_detects_binary_and_version_only() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let tool = bin.join("mytool");
        std::fs::write(&tool, "#!/bin/sh\necho 'mytool 2.0'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let found = test_definition(
            bin.as_os_str(),
            "",
            vec!["mytool".into(), "other".into()],
            vec!["mytool".into(), "--version".into()],
        )
        .unwrap();
        assert!(found.found);
        assert_eq!(found.version.as_deref(), Some("2.0"));
        let missing = test_definition(
            bin.as_os_str(),
            "",
            vec!["not-a-real-binary".into()],
            vec!["not-a-real-binary".into(), "--version".into()],
        )
        .unwrap();
        assert!(!missing.found);
        assert!(missing.binary_path.is_none());
        // An empty version command fails validation instead of running anything.
        let error = test_definition(bin.as_os_str(), "", vec!["mytool".into()], vec![]).unwrap_err();
        assert_eq!(error.code, "agent.definition_invalid");
    }
    #[test]
    fn catalog_with_fake_claude_creates_one_default_and_preserves_profiles() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let executable = bin.join(if cfg!(windows) { "claude.exe" } else { "claude" });
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../crates/tessera-agents/examples/fake_agent.rs");
        assert!(
            std::process::Command::new("rustc")
                .arg(source)
                .arg("-o")
                .arg(&executable)
                .status()
                .unwrap()
                .success()
        );
        let store = Store::open(&tessera_store::DataDirs::from_root(tmp.path().join("data"))).unwrap();
        let mut detector = Detector::default();
        for rescan in [true, false, true] {
            let rows = scan_catalog(&store, tmp.path(), bin.as_os_str(), ".EXE;.CMD", &mut detector, rescan).unwrap();
            let claude = rows.iter().find(|r| r.id == "claude").unwrap();
            assert!(claude.installed);
            assert_eq!(claude.version.as_deref(), Some("1.2.3"));
            assert_eq!(claude.source, "bundled");
            assert_eq!(rows.iter().filter(|r| r.installed).count(), 1);
            assert_eq!(store.agent_profiles().list(Some("claude")).unwrap().len(), 1);
        }
        assert!(store.agent_profiles().list(Some("claude")).unwrap()[0].is_default);
        assert!(!store.agent_profiles().list(Some("claude")).unwrap()[0].skip_permissions);
        std::fs::remove_file(executable).unwrap();
        let rows = scan_catalog(&store, tmp.path(), bin.as_os_str(), ".EXE", &mut detector, true).unwrap();
        assert!(!rows[0].installed);
        assert!(
            store
                .agent_install_get("claude")
                .unwrap()
                .unwrap()
                .binary_path
                .is_none()
        );
    }
}
