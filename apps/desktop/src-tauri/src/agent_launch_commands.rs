//! Agent launch planning and durable lifecycle. No production PTY spawning happens here.
use crate::{
    agent_commands::{definition, env_value},
    agent_status::{self, AgentObservation},
    agent_types::*,
    error::AppError,
    project_commands::with_store,
    state::AppState,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::BTreeMap, ffi::OsStr, path::PathBuf};
use tauri::Manager;
use tauri_specta::Event;
use tessera_agents::transcripts::{self, Claim, Roots};
use tessera_store::{Store, agents::now_millis};

/// Payload is the session itself, without an extra wrapper object.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(transparent)]
#[tauri_specta(event_name = "agent:session_changed")]
pub struct AgentSessionChanged(pub AgentSession);

struct LaunchContext {
    config: PathBuf,
    home: PathBuf,
    env: BTreeMap<String, String>,
    /// `claude --settings <file>` with Tessera's SessionStart hook, so every launched Claude reports its conversation
    /// id (None when the bundled CLI is missing, as in plain `cargo` builds).
    claude_settings: Option<String>,
    /// Where agents keep their transcripts (None in tests that do not look).
    roots: Option<Roots>,
}
impl LaunchContext {
    fn from_app(app: &tauri::AppHandle) -> Result<Self, AppError> {
        let state = app.state::<AppState>();
        Ok(Self {
            config: state.dirs.root.clone(),
            home: app.path().home_dir().map_err(|e| {
                AppError::new(
                    "agent.start_failed",
                    format!("The home directory could not be resolved: {e}."),
                )
            })?,
            env: state.pty.login_environment_snapshot(),
            claude_settings: claude_settings_file(&state.dirs.root),
            roots: crate::pane_agent_commands::roots(app),
        })
    }
}
/// Writes the launch-only Claude settings next to the database (only when they changed) and returns the path.
fn claude_settings_file(root: &std::path::Path) -> Option<String> {
    let cli = crate::hooks_commands::cli_path().ok()?;
    if !std::path::Path::new(&cli).is_file() {
        return None;
    }
    let path = root.join("agent-hooks").join("claude-launch.json");
    let text = serde_json::to_string_pretty(&tessera_agents::hooks::claude_launch_settings(&cli)).ok()?;
    if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(&path, &text).ok()?;
    }
    Some(path.to_string_lossy().into_owned())
}
/// Adds `--settings <file>` to a local Claude launch unless the profile already passes its own settings.
fn add_claude_settings(agent_id: &str, cwd: &std::path::Path, args: &mut Vec<String>, settings: Option<&String>) {
    if agent_id != "claude" || tessera_git::remote::is_remote(cwd) {
        return;
    }
    let Some(settings) = settings else { return };
    if args
        .iter()
        .any(|arg| arg == "--settings" || arg.starts_with("--settings="))
    {
        return;
    }
    args.splice(0..0, ["--settings".to_owned(), settings.clone()]);
}
fn session_missing() -> AppError {
    AppError::new("agent.session_not_found", "The agent session could not be found.")
}
fn session(store: &Store, id: &str) -> Result<AgentSession, AppError> {
    Ok(store.agent_sessions().get(id)?.ok_or_else(session_missing)?.into())
}
fn emit(app: &tauri::AppHandle, session: AgentSession) -> Result<(), AppError> {
    AgentSessionChanged(session).emit(app).map_err(|e| {
        AppError::new(
            "agent.event_failed",
            format!("The agent session change event could not be sent: {e}."),
        )
    })
}
fn task_cwd(store: &Store, task_id: &str) -> Result<PathBuf, AppError> {
    let task = store.task_get(task_id)?;
    if let Some(path) = task.worktree_path {
        return Ok(path.into());
    }
    if task.uses_main_checkout == Some(1)
        && let Some(project_id) = task.project_id
        && let Some(project) = store.projects().get(&project_id)?
    {
        return Ok(project.path.into());
    }
    Err(AppError::new(
        "task.not_found",
        "The task does not have an available checkout.",
    ))
}
/// Validate and resolve everything before mutating session state, including on restart.
fn prepare_launch(store: &Store, context: &LaunchContext, input: &AgentStartInput) -> Result<AgentLaunch, AppError> {
    let profile = AgentProfile::try_from(
        store
            .agent_profiles()
            .get(&input.profile_id)?
            .ok_or_else(|| AppError::new("agent.profile_not_found", "The agent profile could not be found."))?,
    )?;
    let def = definition(&context.config, &profile.agent_id)?;
    let cwd = match &input.task_id {
        Some(id) => task_cwd(store, id)?,
        None => input
            .cwd
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| context.home.clone()),
    };
    let path = OsStr::new(env_value(&context.env, "PATH").unwrap_or_default());
    let pathext = env_value(&context.env, "PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD");
    // On an SSH host the agent is looked up on the host's PATH (M10.2).
    let binary = if tessera_git::remote::is_remote(&cwd) {
        def.binaries.first().map(PathBuf::from)
    } else {
        tessera_agents::detection::find_binary_wide(&def.binaries, path, cfg!(windows), pathext)
    }
    .ok_or_else(|| {
        AppError::new(
            "agent.not_installed",
            "The agent executable could not be found in the login PATH.",
        )
    })?;
    let command = tessera_agents::command_line(&def, &profile.launch_profile(), input.prompt.as_deref())
        .map_err(|message| AppError::new("agent.profile_invalid", message))?;
    let mut args = command.args;
    add_claude_settings(&def.id, &cwd, &mut args, context.claude_settings.as_ref());
    let mut env = command.env;
    // Reserve these names even when a Windows profile uses a different case.
    env.retain(|key, _| {
        ![
            "TESSERA_AGENT_SESSION_ID",
            "TESSERA_AGENT",
            "TESSERA_TASK_ID",
            "TESSERA_SESSION_ID",
        ]
        .iter()
        .any(|reserved| key.eq_ignore_ascii_case(reserved))
    });
    env.insert("TESSERA_AGENT".into(), def.id.clone());
    if let Some(task_id) = &input.task_id {
        env.insert("TESSERA_TASK_ID".into(), task_id.clone());
    }
    Ok(AgentLaunch {
        agent_session_id: String::new(),
        agent_id: def.id,
        agent_name: def.name,
        icon: def.icon,
        profile_id: profile.id,
        profile_name: profile.name,
        task_id: input.task_id.clone(),
        cwd: cwd.to_string_lossy().into_owned(),
        program: binary.to_string_lossy().into_owned(),
        args,
        env,
        stdin: command.stdin,
        type_after_ready: command.type_after_ready,
        ready_pattern: def.ready_pattern,
        skip_permissions: profile.skip_permissions,
    })
}
fn bind_session(mut plan: AgentLaunch, row: &AgentSession) -> AgentLaunch {
    plan.agent_session_id = row.id.clone();
    plan.env.insert("TESSERA_AGENT_SESSION_ID".into(), row.id.clone());
    plan
}
fn start(
    store: &Store,
    context: &LaunchContext,
    input: AgentStartInput,
) -> Result<(AgentLaunch, AgentSession), AppError> {
    let plan = prepare_launch(store, context, &input)?;
    let row: AgentSession = store
        .agent_sessions()
        .create(
            input.task_id.as_deref(),
            &plan.agent_id,
            &plan.profile_id,
            input.prompt.as_deref(),
        )?
        .into();
    store.agent_sessions().set_launch_cwd(&row.id, &plan.cwd)?;
    Ok((bind_session(plan, &row), row))
}
fn restart(
    store: &Store,
    context: &LaunchContext,
    id: &str,
) -> Result<(AgentLaunch, AgentSession, AgentSession), AppError> {
    let old = session(store, id)?;
    let plan = prepare_launch(
        store,
        context,
        &AgentStartInput {
            task_id: old.task_id,
            profile_id: old.profile_id,
            prompt: old.prompt,
            cwd: None,
        },
    )?;
    let (old, new) = store
        .agent_sessions()
        .restart(id, now_millis())?
        .ok_or_else(session_missing)?;
    let (old, new) = (old.into(), new.into());
    Ok((bind_session(plan, &new), old, new))
}
#[tauri::command]
#[specta::specta]
pub async fn agent_start(app: tauri::AppHandle, input: AgentStartInput) -> Result<AgentLaunch, AppError> {
    let context = LaunchContext::from_app(&app)?;
    let (plan, row) = with_store(app.clone(), move |store| start(store, &context, input)).await?;
    emit(&app, row)?;
    Ok(plan)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_session_attach(
    app: tauri::AppHandle,
    agent_session_id: String,
    pane_session_id: String,
    pane_id: String,
) -> Result<AgentSession, AppError> {
    let (row, changed) = with_store(app.clone(), move |store| {
        let before = session(store, &agent_session_id)?;
        let row: AgentSession = store
            .agent_sessions()
            .set_pane_session(&agent_session_id, &pane_session_id, &pane_id, now_millis())?
            .ok_or_else(session_missing)?
            .into();
        let changed = before != row;
        Ok((row, changed))
    })
    .await?;
    if changed {
        emit(&app, row.clone())?;
    }
    Ok(row)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_session_exited(
    app: tauri::AppHandle,
    agent_session_id: String,
    exit_code: i32,
) -> Result<AgentSession, AppError> {
    // Agents stopped by the quit itself are not "ended by the user": the next start continues them.
    let quitting = crate::pane_agent_commands::is_quitting(&app);
    let (row, changed) = with_store(app.clone(), move |store| {
        let before = session(store, &agent_session_id)?;
        if quitting {
            return Ok((before, false));
        }
        let row: AgentSession = store
            .agent_sessions()
            .mark_exited(&agent_session_id, exit_code, now_millis())?
            .ok_or_else(session_missing)?
            .into();
        let changed = before != row;
        Ok((row, changed))
    })
    .await?;
    if changed {
        emit(&app, row.clone())?;
    }
    Ok(row)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_restart(app: tauri::AppHandle, agent_session_id: String) -> Result<AgentLaunch, AppError> {
    let context = LaunchContext::from_app(&app)?;
    let (plan, old, new) = with_store(app.clone(), move |store| restart(store, &context, &agent_session_id)).await?;
    emit(&app, old)?;
    emit(&app, new)?;
    Ok(plan)
}
/// The command that continues the most recent conversation in the current folder, for agents whose transcripts
/// Tessera cannot read (so it cannot find the id itself). Claude and Codex never use it: "the latest conversation of
/// the folder" is the wrong one as soon as two agents share a worktree, and without a transcript there is nothing to
/// continue.
fn continue_latest(agent_id: &str) -> Vec<String> {
    let parts: &[&str] = match agent_id {
        "opencode" => &["opencode", "--continue"],
        _ => &[],
    };
    parts.iter().map(|part| (*part).to_string()).collect()
}
/// The conversation id of a launched agent that a resume can use: the stored one while its transcript exists, else
/// the transcript the agent wrote in its folder after it started.
fn usable_id(
    store: &Store,
    context: &LaunchContext,
    old: &tessera_store::agent_sessions::AgentSession,
) -> Option<String> {
    let stored = old.external_session_id.clone().filter(|id| !id.is_empty());
    let cwd = old.launch_cwd.clone().unwrap_or_default();
    let Some(roots) = context.roots.as_ref().filter(|_| !tessera_git::remote::is_remote(&cwd)) else {
        return stored;
    };
    if !matches!(old.agent_id.as_str(), "claude" | "codex") {
        return stored;
    }
    if let Some(id) = stored.filter(|id| transcripts::exists(&old.agent_id, roots, id)) {
        return Some(id);
    }
    if cwd.is_empty() {
        return None;
    }
    // Ids held by the other sessions of the folder are not this one's.
    let others = store.agent_sessions().list(None).unwrap_or_default();
    let mut claims: Vec<Claim> = others
        .iter()
        .filter(|row| {
            row.id != old.id && row.agent_id == old.agent_id && row.launch_cwd.as_deref() == Some(cwd.as_str())
        })
        .filter_map(|row| {
            Some(Claim {
                agent: row.agent_id.clone(),
                cwd: cwd.clone(),
                started: std::time::UNIX_EPOCH + std::time::Duration::from_millis(u64::try_from(row.started_at).ok()?),
                current: Some(row.external_session_id.clone().filter(|id| !id.is_empty())?),
            })
        })
        .collect();
    claims.push(Claim {
        agent: old.agent_id.clone(),
        cwd,
        started: std::time::UNIX_EPOCH + std::time::Duration::from_millis(u64::try_from(old.started_at).unwrap_or(0)),
        current: None,
    });
    transcripts::assign(&claims, roots).pop().flatten()
}
fn resume(
    store: &Store,
    context: &LaunchContext,
    agent_session_id: &str,
) -> Result<(AgentLaunch, AgentSession), AppError> {
    let old = store
        .agent_sessions()
        .get(agent_session_id)?
        .ok_or_else(session_missing)?;
    let def = definition(&context.config, &old.agent_id)?;
    // The conversation id comes from the agent's SessionStart hook or its transcript files; it is checked against
    // the transcript before use. Without one, only agents Tessera cannot read continue "the latest one here".
    let external_owned = usable_id(store, context, &old);
    let external = external_owned.as_deref();
    let template: Vec<String> = match external {
        Some(_) => def.resume.clone(),
        None => continue_latest(&def.id),
    };
    if template.is_empty() {
        return Err(AppError::new(
            "agent.resume_unsupported",
            "This session has no conversation to continue: its conversation was not found.",
        ));
    }
    let mut plan = prepare_launch(
        store,
        context,
        &AgentStartInput {
            task_id: old.task_id.clone(),
            profile_id: old.profile_id.clone(),
            prompt: None,
            cwd: old.launch_cwd.clone(),
        },
    )?;
    plan.program = tessera_agents::detection::find_binary_wide(
        &template[..1],
        OsStr::new(env_value(&context.env, "PATH").unwrap_or_default()),
        cfg!(windows),
        env_value(&context.env, "PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD"),
    )
    .ok_or_else(|| {
        AppError::new(
            "agent.not_installed",
            "The resume executable could not be found in the login PATH.",
        )
    })?
    .to_string_lossy()
    .into_owned();
    // The profile's flags (model, permissions) stay; its prompt does not.
    let kept = transcripts::kept_flags(&def.id, &plan.args);
    plan.args = template
        .iter()
        .skip(1)
        .map(|arg| arg.replace("{external_session_id}", external.unwrap_or_default()))
        .collect();
    if transcripts::RESUMABLE.contains(&def.id.as_str()) {
        let insert_at = usize::from(def.id == "codex" && plan.args.first().is_some_and(|a| a == "resume"));
        plan.args.splice(insert_at..insert_at, kept);
    }
    plan.stdin = None;
    plan.type_after_ready = None;
    let row: AgentSession = store
        .agent_sessions()
        .create(old.task_id.as_deref(), &old.agent_id, &old.profile_id, None)?
        .into();
    store.agent_sessions().set_launch_cwd(&row.id, &plan.cwd)?;
    if let Some(external) = external {
        store.agent_sessions().set_external_session_id(&row.id, external)?;
    }
    // The old run is over; ending it keeps it from claiming the conversation the new one continues.
    if old.ended_at.is_none() {
        store.agent_sessions().mark_exited(&old.id, -1, now_millis())?;
    }
    let row = session(store, &row.id)?;
    Ok((bind_session(plan, &row), row))
}
#[tauri::command]
#[specta::specta]
pub async fn agent_resume(app: tauri::AppHandle, agent_session_id: String) -> Result<AgentLaunch, AppError> {
    let context = LaunchContext::from_app(&app)?;
    let (plan, row) = with_store(app.clone(), move |store| resume(store, &context, &agent_session_id)).await?;
    emit(&app, row)?;
    Ok(plan)
}
#[tauri::command]
#[specta::specta]
pub async fn agent_sessions_list(
    app: tauri::AppHandle,
    task_id: Option<String>,
) -> Result<Vec<AgentSession>, AppError> {
    with_store(app, move |store| {
        Ok(store
            .agent_sessions()
            .list(task_id.as_deref())?
            .into_iter()
            .map(Into::into)
            .collect())
    })
    .await
}

#[cfg(test)]
#[path = "agent_launch_tests.rs"]
mod tests;

/// Front-end observations for the status engine: OSC notifications/progress, the visible screen, silence.
#[tauri::command]
#[specta::specta]
pub async fn agent_observe(
    app: tauri::AppHandle,
    agent_session_id: String,
    observation: AgentObservation,
) -> Result<AgentSession, AppError> {
    let config = app.state::<AppState>().dirs.root.clone();
    let input = match observation {
        AgentObservation::OscNotification { text } => tessera_agents::status::Input::OscNotification { text },
        AgentObservation::OscProgress { state, value } => tessera_agents::status::Input::OscProgress { state, value },
        AgentObservation::Silence { seconds } => tessera_agents::status::Input::Silence { seconds },
        AgentObservation::Screen { lines } => {
            let id = agent_session_id.clone();
            let agent_id = with_store(app.clone(), move |store| {
                store
                    .agent_sessions()
                    .get(&id)?
                    .map(|row| row.agent_id)
                    .ok_or_else(session_missing)
            })
            .await?;
            let def = definition(&config, &agent_id)?;
            agent_status::screen_input(&def, &lines)
        }
    };
    agent_status::apply_and_emit(&app, &agent_session_id, input, None)
}
