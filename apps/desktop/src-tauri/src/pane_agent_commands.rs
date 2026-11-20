//! Keeping agent conversations across restarts (research: `.ai/research/agent-session-persistence.md`).
//!
//! Two kinds of agent panes:
//! - **Typed agents**: the user runs `claude` (or codex, opencode, gemini) in a shell pane. The pane sees the command
//!   through shell integration (OSC 133) and reports it here; the record lives in `pane_agents`.
//! - **Launched agents**: started from Tessera's agent menu, recorded in `agent_sessions`.
//!
//! For both, the agent's own conversation id is what lets a restored pane continue the right conversation:
//! `claude --resume <id>`, never `claude --continue`, which picks the newest conversation of the folder (wrong as soon
//! as two agents share a worktree). The id comes from the agent's `SessionStart` hook when it runs (launched Claude
//! agents always get one, see `agent_launch_commands`), and otherwise from the transcript files the agents write
//! themselves, matched by a background scan every few seconds. Everything is written as soon as it is known, so a
//! crash or a killed app loses nothing; quitting only sets a flag so the shutdown is not mistaken for the user
//! ending their agents.
use crate::{error::AppError, project_commands::with_store, state::AppState};
use serde::Serialize;
use specta::Type;
use std::{
    collections::HashSet,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tessera_agents::transcripts::{self, Claim, Roots};
use tessera_store::{Store, agents::now_millis};

/// How often running agents are matched to their transcripts.
const SCAN_EVERY: Duration = Duration::from_secs(4);
/// Launched agents older than this are not scanned (a crash can leave rows that never ended).
const LAUNCHED_WINDOW_MS: i64 = 3 * 24 * 3600 * 1000;

#[derive(Default)]
pub struct PaneAgentState {
    quitting: AtomicBool,
    /// Records whose id came from a hook (`pane:<id>`, `session:<agent session id>`): the hook is exact, so the scan
    /// leaves them alone.
    hooked: Mutex<HashSet<String>>,
}

impl PaneAgentState {
    /// The app is shutting down: agents that end from now on were stopped by the quit, not by the user.
    pub fn quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }
    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
    fn hooked(&self, key: &str) -> bool {
        self.hooked.lock().is_ok_and(|set| set.contains(key))
    }
    fn mark_hooked(&self, key: String) {
        if let Ok(mut set) = self.hooked.lock() {
            set.insert(key);
        }
    }
}

/// Marks the app as quitting (from the run loop).
pub fn quitting(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<PaneAgentState>() {
        state.quitting();
    }
}

pub fn is_quitting(app: &tauri::AppHandle) -> bool {
    app.try_state::<PaneAgentState>()
        .is_some_and(|state| state.is_quitting())
}

/// Where the agents keep their transcripts, from the login environment the panes get.
pub(crate) fn roots(app: &tauri::AppHandle) -> Option<Roots> {
    let home = crate::hooks_commands::home(app).ok()?;
    let env = app.state::<AppState>().pty.login_environment_snapshot();
    Some(Roots::new(&home, |name| env.get(name).cloned()))
}

fn millis_to_time(ms: i64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(u64::try_from(ms).unwrap_or(0))
}

fn local(cwd: &str) -> bool {
    !cwd.is_empty() && !tessera_git::remote::is_remote(Path::new(cwd))
}

/// A command line the pane's shell just started. Returns the agent id when it starts an interactive agent (the pane
/// then reports when the command finishes).
#[tauri::command]
#[specta::specta]
pub async fn pane_agent_started(
    app: tauri::AppHandle,
    pane_id: String,
    command: String,
    cwd: String,
) -> Result<Option<String>, AppError> {
    let Some(typed) = transcripts::typed_agent(&command) else {
        return Ok(None);
    };
    if !local(&cwd) {
        return Ok(None);
    }
    let agent = typed.agent.clone();
    let key = format!("pane:{pane_id}");
    if let Some(state) = app.try_state::<PaneAgentState>()
        && let Ok(mut set) = state.hooked.lock()
    {
        set.remove(&key);
    }
    with_store(app, move |store| {
        store.pane_agents().started(
            &pane_id,
            &typed.agent,
            &typed.program,
            &cwd,
            &typed.flags,
            typed.id.as_deref(),
            now_millis(),
        )?;
        Ok(())
    })
    .await?;
    Ok(Some(agent))
}

/// The agent's command finished while the app watched: the user ended it, so a restore will not continue it.
#[tauri::command]
#[specta::specta]
pub async fn pane_agent_finished(app: tauri::AppHandle, pane_id: String) -> Result<(), AppError> {
    if is_quitting(&app) {
        return Ok(());
    }
    with_store(app, move |store| {
        Ok(store.pane_agents().ended(&pane_id, now_millis())?)
    })
    .await
}

/// The pane was closed: forget its agent.
#[tauri::command]
#[specta::specta]
pub async fn pane_agent_forget(app: tauri::AppHandle, pane_id: String) -> Result<(), AppError> {
    if is_quitting(&app) {
        return Ok(());
    }
    with_store(app, move |store| Ok(store.pane_agents().forget(&pane_id)?)).await
}

/// What a restored shell pane types to continue its agent.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PaneAgentResume {
    pub agent_id: String,
    /// The command line, quoted for the pane's shell, without the final Enter.
    pub command: String,
}

/// The command that continues the agent that ran in a restored shell pane, or None (no agent ran there, the user
/// ended it, or its conversation cannot be found). A conversation id is only used when its transcript still exists.
#[tauri::command]
#[specta::specta]
pub async fn pane_agent_resume(app: tauri::AppHandle, pane_id: String) -> Result<Option<PaneAgentResume>, AppError> {
    let roots = roots(&app);
    let (row, others) = with_store(app.clone(), {
        let pane_id = pane_id.clone();
        move |store| {
            let row = store.pane_agents().get(&pane_id)?;
            let others = store.pane_agents().running()?;
            Ok((row, others))
        }
    })
    .await?;
    let Some(row) = row.filter(|row| row.running) else {
        return Ok(None);
    };
    let Some(roots) = roots else { return Ok(None) };
    let mut id = row
        .external_session_id
        .clone()
        .filter(|id| transcripts::exists(&row.agent_id, &roots, id));
    if id.is_none() {
        // The scan may not have run since the agent started: look now, leaving the ids of other panes alone.
        let mut claims: Vec<Claim> = others
            .iter()
            .filter(|other| other.pane_id != row.pane_id && other.agent_id == row.agent_id && other.cwd == row.cwd)
            .map(|other| Claim {
                agent: other.agent_id.clone(),
                cwd: other.cwd.clone(),
                started: millis_to_time(other.started_at),
                current: other.external_session_id.clone(),
            })
            .collect();
        claims.push(Claim {
            agent: row.agent_id.clone(),
            cwd: row.cwd.clone(),
            started: millis_to_time(row.started_at),
            current: None,
        });
        id = transcripts::assign(&claims, &roots).pop().flatten();
        if let Some(found) = &id {
            let (pane, found) = (row.pane_id.clone(), found.clone());
            let _ = with_store(app.clone(), move |store| {
                Ok(store
                    .pane_agents()
                    .set_external_session_id(&pane, &found, now_millis())?)
            })
            .await;
        }
    }
    // Without an id, "the latest conversation of this folder" is only safe when no other pane ran this agent here,
    // and only for agents whose transcripts Tessera cannot read (for the others, no transcript means nothing to
    // continue).
    if id.is_none() {
        let alone = !others
            .iter()
            .any(|other| other.pane_id != row.pane_id && other.agent_id == row.agent_id && other.cwd == row.cwd);
        if !(alone && row.agent_id == "opencode") {
            return Ok(None);
        }
    }
    let Some(words) = transcripts::resume_words(&row.agent_id, &row.program, &row.flags, id.as_deref()) else {
        return Ok(None);
    };
    let quote = if cfg!(windows) {
        transcripts::quote_powershell
    } else {
        transcripts::quote_posix
    };
    let mut command = words.iter().map(|w| quote(w)).collect::<Vec<_>>().join(" ");
    // PowerShell runs a quoted program only through the call operator.
    if cfg!(windows) && command.starts_with('\'') {
        command = format!("& {command}");
    }
    Ok(Some(PaneAgentResume {
        agent_id: row.agent_id,
        command,
    }))
}

/// A hook event from a typed agent (its PTY has no launched-agent record): stores the conversation id it reports.
/// Returns whether a typed agent took it.
pub fn typed_hook(app: &tauri::AppHandle, store: &Store, pty_session: &str, payload: &serde_json::Value) -> bool {
    let Ok(session) = pty_session.parse() else {
        return false;
    };
    let pane = app.state::<AppState>().sessions.history_key(&session);
    let Ok(Some(row)) = store.pane_agents().get(&pane) else {
        return false;
    };
    let key = match row.agent_id.as_str() {
        "codex" => "thread-id",
        _ => "session_id",
    };
    if let Some(id) = payload.get(key).and_then(serde_json::Value::as_str)
        && transcripts::valid_id(id)
    {
        let _ = store.pane_agents().set_external_session_id(&pane, id, now_millis());
        app.state::<PaneAgentState>().mark_hooked(format!("pane:{pane}"));
    }
    true
}

/// A launched agent's hook reported its conversation id: the scan leaves it alone from now on.
pub fn launched_hooked(app: &tauri::AppHandle, agent_session_id: &str) {
    if let Some(state) = app.try_state::<PaneAgentState>() {
        state.mark_hooked(format!("session:{agent_session_id}"));
    }
}

/// One record the scan looks at.
enum Target {
    Pane(String),
    Launched(String),
}

/// Matches every running agent to its transcript and stores the ids that changed.
fn scan(app: &tauri::AppHandle, roots: &Roots) {
    let state = app.state::<AppState>();
    let agents = app.state::<PaneAgentState>();
    let (typed, launched) = {
        let Ok(store) = state.store.lock() else { return };
        let typed = store.pane_agents().running().unwrap_or_default();
        let since = now_millis() - LAUNCHED_WINDOW_MS;
        let launched: Vec<_> = store
            .agent_sessions()
            .list(None)
            .unwrap_or_default()
            .into_iter()
            .filter(|row| row.ended_at.is_none() && row.started_at >= since && !row.pane_session_id.is_empty())
            .collect();
        (typed, launched)
    };
    let mut targets = Vec::new();
    let mut claims = Vec::new();
    for row in typed {
        if !matches!(row.agent_id.as_str(), "claude" | "codex") || !local(&row.cwd) {
            continue;
        }
        let key = format!("pane:{}", row.pane_id);
        claims.push(Claim {
            agent: row.agent_id.clone(),
            cwd: row.cwd.clone(),
            started: millis_to_time(row.started_at),
            current: row.external_session_id.clone(),
        });
        targets.push((agents.hooked(&key), Target::Pane(row.pane_id)));
    }
    for row in launched {
        let Some(cwd) = row.launch_cwd.clone().filter(|cwd| local(cwd)) else {
            continue;
        };
        if !matches!(row.agent_id.as_str(), "claude" | "codex") {
            continue;
        }
        let key = format!("session:{}", row.id);
        claims.push(Claim {
            agent: row.agent_id.clone(),
            cwd,
            started: millis_to_time(row.started_at),
            current: row.external_session_id.clone().filter(|id| !id.is_empty()),
        });
        targets.push((agents.hooked(&key), Target::Launched(row.id)));
    }
    if claims.is_empty() {
        return;
    }
    // Hooked records keep their ids (they still hold them, so nobody else takes them), and are never moved.
    let found = transcripts::assign(&claims, roots);
    let updates: Vec<(Target, String)> = targets
        .into_iter()
        .zip(found)
        .filter_map(|((hooked, target), id)| (!hooked).then_some(()).and(id.map(|id| (target, id))))
        .collect();
    if updates.is_empty() {
        return;
    }
    let Ok(store) = state.store.lock() else { return };
    for (target, id) in updates {
        match target {
            Target::Pane(pane) => {
                let _ = store.pane_agents().set_external_session_id(&pane, &id, now_millis());
            }
            Target::Launched(session) => {
                let _ = store.agent_sessions().set_external_session_id(&session, &id);
            }
        }
    }
}

/// Starts the background scan.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    let started = std::thread::Builder::new()
        .name("tessera-agent-transcripts".into())
        .spawn(move || {
            loop {
                std::thread::sleep(SCAN_EVERY);
                if is_quitting(&app) {
                    return;
                }
                if let Some(roots) = roots(&app) {
                    scan(&app, &roots);
                }
            }
        });
    if let Err(error) = started {
        tracing::warn!(%error, "could not start the agent transcript scan");
    }
}
