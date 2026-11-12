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
        })
    }
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
        tessera_agents::detection::find_binary(&def.binaries, path, cfg!(windows), pathext)
    }
    .ok_or_else(|| {
        AppError::new(
            "agent.not_installed",
            "The agent executable could not be found in the login PATH.",
        )
    })?;
    let command = tessera_agents::command_line(&def, &profile.launch_profile(), input.prompt.as_deref())
        .map_err(|message| AppError::new("agent.profile_invalid", message))?;
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
        args: command.args,
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
    let (row, changed) = with_store(app.clone(), move |store| {
        let before = session(store, &agent_session_id)?;
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
    let external = old.external_session_id.as_deref().filter(|id| !id.is_empty());
    if def.resume.is_empty() || external.is_none() {
        return Err(AppError::new(
            "agent.resume_unsupported",
            "This session has no supported resume command or captured session ID.",
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
    plan.program = tessera_agents::detection::find_binary(
        &def.resume[..1],
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
    plan.args = def
        .resume
        .iter()
        .skip(1)
        .map(|arg| arg.replace("{external_session_id}", external.unwrap()))
        .collect();
    plan.stdin = None;
    plan.type_after_ready = None;
    let row: AgentSession = store
        .agent_sessions()
        .create(old.task_id.as_deref(), &old.agent_id, &old.profile_id, None)?
        .into();
    store.agent_sessions().set_launch_cwd(&row.id, &plan.cwd)?;
    store
        .agent_sessions()
        .set_external_session_id(&row.id, external.unwrap())?;
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
