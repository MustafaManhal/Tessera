//! Native local API. Handler threads work without a focused WebView; startup failure is nonfatal.
use crate::{
    agent_launch_commands::AgentSessionChanged,
    agent_types::AgentSession,
    error::AppError,
    project_types::{Project, TaskSummary},
    state::AppState,
    task_commands::{TaskChanged, reconcile_watchers},
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;
use tauri_specta::Event;
use tessera_api::{Endpoint, Handler, RpcError, Server};
use tessera_pty::{EventSink, PtyEvent, SessionId, SpawnSpec};
use tessera_store::{
    Store, agent_sessions::AgentSession as StoredAgentSession, repositories::Task as StoredTask, tasks::CreateTask,
};

pub struct LocalApi(Mutex<Option<Server>>);
struct DesktopHandler(tauri::AppHandle);
#[derive(Deserialize)]
struct Notification {
    title: String,
    body: String,
}
#[derive(Deserialize)]
struct Hook {
    tessera_session_id: String,
    event: String,
    payload: Value,
    at: i64,
}
#[derive(Deserialize)]
struct ProjectAdd {
    path: String,
}
#[derive(Deserialize)]
struct TaskListParams {
    project: Option<String>,
    status: Option<String>,
}
#[derive(Deserialize)]
struct TaskCreateParams {
    project: String,
    prompt: Option<String>,
    #[serde(default)]
    agents: Vec<String>,
    base: Option<String>,
    name: Option<String>,
}
#[derive(Deserialize)]
struct TaskRef {
    task: String,
    #[serde(default)]
    confirm_lost_commits: bool,
}
#[derive(Deserialize)]
struct AgentWaitParams {
    task: String,
    statuses: Vec<String>,
    timeout_ms: Option<u64>,
}
#[derive(Deserialize)]
struct AgentSendParams {
    task: String,
    text: String,
}
#[derive(Deserialize)]
struct PaneReadParams {
    task: Option<String>,
    session: Option<String>,
    lines: Option<usize>,
}
#[derive(Deserialize)]
struct ReviewDiffParams {
    task: String,
}

fn invalid_params() -> RpcError {
    RpcError::new(-32602, "Invalid params")
}
fn invalid_state(message: impl Into<String>) -> RpcError {
    RpcError::new(-32003, message)
}
fn store_error(error: impl std::fmt::Display) -> RpcError {
    invalid_state(error.to_string())
}
fn parse_params<T: DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(|_| invalid_params())
}
fn app_error(error: AppError) -> RpcError {
    invalid_state(format!("{}: {}", error.code, error.message))
}
/// Task lifecycle failures: unknown rows are NotFound, everything else is an invalid state for the caller.
fn task_error(error: tessera_store::tasks::TaskError) -> RpcError {
    use tessera_store::tasks::TaskError as E;
    match error {
        E::NotFound => RpcError::not_found(),
        other => invalid_state(other.to_string()),
    }
}
fn project_error(error: tessera_store::projects::ProjectError) -> RpcError {
    use tessera_store::projects::ProjectError as E;
    match error {
        E::NotFound => RpcError::not_found(),
        other => invalid_state(other.to_string()),
    }
}
/// A task reference is its id; the slug or name is accepted when it is unique.
fn resolve_task(store: &Store, reference: &str) -> Result<StoredTask, RpcError> {
    match store.task_get(reference) {
        Ok(task) => return Ok(task),
        Err(tessera_store::tasks::TaskError::NotFound) => {}
        Err(error) => return Err(task_error(error)),
    }
    let tasks = store.tasks().list().map_err(store_error)?;
    let mut matches = tasks.iter().filter(|t| t.slug == reference || t.name == reference);
    match (matches.next(), matches.next()) {
        (Some(task), None) => Ok(task.clone()),
        (None, _) => Err(RpcError::not_found()),
        _ => Err(invalid_params()),
    }
}
/// A project reference is its id or its registered path.
fn resolve_project(store: &Store, reference: &str) -> Result<tessera_store::repositories::Project, RpcError> {
    if let Some(project) = store.projects().get(reference).map_err(store_error)? {
        return Ok(project);
    }
    let wanted = Path::new(reference);
    let projects = store.projects().list().map_err(store_error)?;
    let mut matches = projects.iter().filter(|p| {
        Path::new(&p.path) == wanted || std::fs::canonicalize(&p.path).ok() == std::fs::canonicalize(wanted).ok()
    });
    match (matches.next(), matches.next()) {
        (Some(project), None) => Ok(project.clone()),
        (None, _) => Err(RpcError::not_found()),
        _ => Err(invalid_params()),
    }
}
/// The checkout a task's commands run in: its worktree, or the project's main checkout.
fn task_checkout(store: &Store, task: &StoredTask) -> Option<PathBuf> {
    if let Some(path) = &task.worktree_path {
        return Some(PathBuf::from(path));
    }
    if task.uses_main_checkout != Some(1) {
        return None;
    }
    Some(PathBuf::from(
        store.projects().get(task.project_id.as_deref()?).ok()??.path,
    ))
}
/// Best-effort git facts for one task, identical in spirit to the task list command's cache-free path.
fn git_facts(path: &Path, base: &str) -> (Option<u32>, Option<u32>, Option<u32>) {
    let counts = tessera_git::ahead_behind(path, base).ok();
    let status = tessera_git::status(path).ok();
    let changes = tessera_git::changed_files(path, base).ok();
    let changed = changes.as_ref().zip(status.as_ref()).map(|(changes, status)| {
        let mut names: std::collections::BTreeSet<_> = changes.iter().map(|f| f.path.clone()).collect();
        names.extend(status.files.iter().map(|f| f.path.clone()));
        u32::try_from(names.len()).unwrap_or(u32::MAX)
    });
    (
        counts.map(|(a, _)| u32::try_from(a).unwrap_or(u32::MAX)),
        counts.map(|(_, b)| u32::try_from(b).unwrap_or(u32::MAX)),
        changed,
    )
}
fn task_summary(app: &tauri::AppHandle, task: StoredTask) -> TaskSummary {
    let path = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else {
            return TaskSummary {
                task: task.into(),
                ahead: None,
                behind: None,
                changed_files: None,
                ports: vec![],
            };
        };
        task_checkout(&store, &task)
    };
    let (ahead, behind, changed_files) = path
        .as_deref()
        .map(|p| git_facts(p, &task.base_branch))
        .unwrap_or((None, None, None));
    TaskSummary {
        task: task.into(),
        ahead,
        behind,
        changed_files,
        ports: vec![],
    }
}
fn emit_task(app: &tauri::AppHandle, task: &StoredTask) {
    let payload = TaskChanged {
        task_id: task.id.clone(),
        summary: task_summary(app, task.clone()),
    };
    if let Err(error) = payload.emit(app) {
        tracing::warn!(%error, "could not emit task change");
    }
}
fn emit_session(app: &tauri::AppHandle, session: &AgentSession) {
    if let Err(error) = AgentSessionChanged(session.clone()).emit(app) {
        tracing::warn!(%error, "could not emit agent session change");
    }
}
fn latest_session(store: &Store, task_id: &str) -> Result<Option<StoredAgentSession>, RpcError> {
    Ok(store
        .agent_sessions()
        .list(Some(task_id))
        .map_err(store_error)?
        .into_iter()
        .next())
}
/// The newest session of a task that is bound to a live PTY.
fn pane_session(store: &Store, task_id: &str) -> Result<Option<StoredAgentSession>, RpcError> {
    Ok(store
        .agent_sessions()
        .list(Some(task_id))
        .map_err(store_error)?
        .into_iter()
        .find(|s| !s.pane_session_id.is_empty()))
}
/// Poll `status_of` until it reports one of `wanted` or `timeout` elapses. The closure must not hold the store
/// lock while sleeping; the caller re-locks on every poll.
fn wait_status(
    mut status_of: impl FnMut() -> Result<String, RpcError>,
    wanted: &[String],
    timeout: Duration,
) -> Result<(String, bool), RpcError> {
    let deadline = Instant::now() + timeout;
    loop {
        let status = status_of()?;
        if wanted.iter().any(|w| w == &status) {
            return Ok((status, false));
        }
        if Instant::now() >= deadline {
            return Ok((status, true));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}
/// CSI, OSC and single-byte escapes removed, matching the front end's `stripEscapes`.
fn strip_escapes(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            match bytes.get(i + 1) {
                Some(b'[') => {
                    // CSI: parameters/intermediates then a final byte in @-~.
                    let mut j = i + 2;
                    while j < bytes.len() && !(0x40..=0x7e).contains(&bytes[j]) {
                        j += 1;
                    }
                    i = (j + 1).min(bytes.len());
                    continue;
                }
                Some(b']') => {
                    // OSC: runs to BEL or ST (ESC \).
                    let mut j = i + 2;
                    while j < bytes.len() {
                        if bytes[j] == 0x07 {
                            j += 1;
                            break;
                        }
                        if bytes[j] == 0x1b && bytes.get(j + 1) == Some(&b'\\') {
                            j += 2;
                            break;
                        }
                        j += 1;
                    }
                    i = j.min(bytes.len());
                    continue;
                }
                Some(_) => {
                    // ESC plus one byte (@-_ per the front-end regex).
                    i = (i + 2).min(bytes.len());
                    continue;
                }
                None => break,
            }
        }
        // Copy one full UTF-8 sequence.
        let width = utf8_width(bytes[i]);
        let end = (i + width).min(bytes.len());
        out.push_str(&input[i..end]);
        i = end;
    }
    out
}
fn utf8_width(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first >> 5 == 0b110 {
        2
    } else if first >> 4 == 0b1110 {
        3
    } else {
        4
    }
}
/// The last `lines` lines of `text`, joined with newlines.
fn tail_lines(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}
const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// Deliver a launch plan's prompt the way the front end does: stdin is written after spawn; a typed prompt waits for
/// the agent's ready pattern (at most [`READY_TIMEOUT`], then is sent anyway) inside bracketed paste plus Enter.
fn deliver_prompt(
    sessions: &Arc<crate::sessions::Sessions>,
    pty: SessionId,
    stdin: Option<String>,
    typed: Option<String>,
    ready_pattern: Option<String>,
) {
    if let Some(input) = stdin {
        if !input.is_empty() {
            let _ = sessions.write(&pty, input.as_bytes());
        }
        return;
    }
    let Some(text) = typed else { return };
    let payload = format!("{PASTE_START}{text}{PASTE_END}\r");
    let pattern = ready_pattern.and_then(|p| regex::Regex::new(&p).ok());
    let Some(pattern) = pattern else {
        let _ = sessions.write(&pty, payload.as_bytes());
        return;
    };
    let sessions = Arc::clone(sessions);
    let fallback = (Arc::clone(&sessions), payload.clone());
    if std::thread::Builder::new()
        .name("tessera-api-prompt".into())
        .spawn(move || {
            let deadline = Instant::now() + READY_TIMEOUT;
            let mut seen = String::new();
            loop {
                if let Ok(bytes) = sessions.snapshot(&pty) {
                    seen.push_str(&strip_escapes(&String::from_utf8_lossy(&bytes)));
                    if seen.len() > 64 * 1024 {
                        let tail: String = seen
                            .chars()
                            .rev()
                            .take(4096)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect();
                        seen = tail;
                    }
                    if pattern.is_match(&seen) {
                        break;
                    }
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            let _ = sessions.write(&pty, payload.as_bytes());
        })
        .is_err()
    {
        let _ = fallback.0.write(&pty, fallback.1.as_bytes());
    }
}
/// Resolve an agent reference (agent id) to its default profile and build + spawn the launch plan headlessly.
/// The returned value is the wire session plus, on success, nothing else; failures are JSON-RPC errors.
fn launch_agent(
    app: &tauri::AppHandle,
    task_id: &str,
    agent_ref: &str,
    prompt: Option<&str>,
) -> Result<Value, RpcError> {
    let state = app.state::<AppState>();
    let (profile, task, project) = {
        let store = state
            .store
            .lock()
            .map_err(|_| invalid_state("The store is unavailable."))?;
        store.agent_profiles().ensure_default(agent_ref).map_err(store_error)?;
        let profiles = store.agent_profiles().list(Some(agent_ref)).map_err(store_error)?;
        let stored_profile = profiles
            .iter()
            .find(|p| p.is_default)
            .or_else(|| profiles.first())
            .ok_or_else(RpcError::not_found)?;
        let task = store.task_get(task_id).map_err(task_error)?;
        let project = store
            .projects()
            .get(task.project_id.as_deref().unwrap_or_default())
            .map_err(store_error)?
            .ok_or_else(RpcError::not_found)?;
        (
            crate::agent_types::AgentProfile::try_from(stored_profile.clone()).map_err(app_error)?,
            task,
            project,
        )
    };
    let config = state.dirs.root.clone();
    let def = crate::agent_commands::definition(&config, &profile.agent_id).map_err(app_error)?;
    let cwd = if let Some(path) = &task.worktree_path {
        PathBuf::from(path)
    } else if task.uses_main_checkout == Some(1) {
        PathBuf::from(&project.path)
    } else {
        return Err(invalid_state("The task does not have an available checkout."));
    };
    let env = state.pty.login_environment_snapshot();
    let path = OsStr::new(crate::agent_commands::env_value(&env, "PATH").unwrap_or_default());
    let pathext = crate::agent_commands::env_value(&env, "PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD");
    let binary = if tessera_git::remote::is_remote(&cwd) {
        def.binaries.first().map(PathBuf::from)
    } else {
        tessera_agents::detection::find_binary_wide(&def.binaries, path, cfg!(windows), pathext)
    }
    .ok_or_else(|| invalid_state("The agent executable could not be found in the login PATH."))?;
    let command =
        tessera_agents::command_line(&def, &profile.launch_profile(), prompt).map_err(|_| invalid_params())?;
    let mut spawn_env = command.env;
    spawn_env.retain(|key, _| {
        ![
            "TESSERA_AGENT_SESSION_ID",
            "TESSERA_AGENT",
            "TESSERA_TASK_ID",
            "TESSERA_SESSION_ID",
        ]
        .iter()
        .any(|reserved| key.eq_ignore_ascii_case(reserved))
    });
    spawn_env.insert("TESSERA_AGENT".into(), def.id.clone());
    spawn_env.insert("TESSERA_TASK_ID".into(), task_id.to_string());
    let row = {
        let store = state
            .store
            .lock()
            .map_err(|_| invalid_state("The store is unavailable."))?;
        let row: AgentSession = store
            .agent_sessions()
            .create(Some(task_id), &def.id, &profile.id, prompt)
            .map_err(store_error)?
            .into();
        store
            .agent_sessions()
            .set_launch_cwd(&row.id, cwd.to_string_lossy().as_ref())
            .map_err(store_error)?;
        row
    };
    emit_session(app, &row);
    let pane_id = format!("api-{}", row.id);
    let pty_id = SessionId::new();
    let row_id = row.id.clone();
    let app_for_exit = app.clone();
    let sink: EventSink = Arc::new(move |event| {
        if let PtyEvent::Exit { code } = event {
            let state = app_for_exit.state::<AppState>();
            if let Ok(store) = state.store.lock()
                && let Ok(Some(updated)) = store.agent_sessions().mark_exited(
                    &row_id,
                    i32::try_from(code).unwrap_or(-1),
                    tessera_store::agents::now_millis(),
                )
            {
                emit_session(&app_for_exit, &updated.into());
            }
        }
    });
    let mut spec = SpawnSpec::new(cwd);
    spec.program = Some(binary.to_string_lossy().into_owned());
    spec.args = command.args;
    spec.env = spawn_env;
    spec.cols = 120;
    spec.rows = 30;
    spec.task_id = Some(task_id.to_string());
    spec.pane_id = Some(pane_id.clone());
    spec.session_id = Some(pty_id);
    let spawned = state.sessions.spawn(spec, sink, Arc::new(|_| {}));
    let pty = match spawned {
        Ok(id) => id,
        Err(error) => {
            if let Ok(store) = state.store.lock() {
                let _ =
                    store
                        .agent_sessions()
                        .set_status(&row.id, "error", "launch", tessera_store::agents::now_millis());
            }
            return Err(app_error(error));
        }
    };
    let bound = {
        let store = state
            .store
            .lock()
            .map_err(|_| invalid_state("The store is unavailable."))?;
        store
            .agent_sessions()
            .set_pane_session(&row.id, &pty.as_string(), &pane_id, tessera_store::agents::now_millis())
            .map_err(store_error)?
            .map(AgentSession::from)
            .ok_or_else(RpcError::not_found)?
    };
    emit_session(app, &bound);
    deliver_prompt(
        &state.sessions,
        pty,
        command.stdin,
        command.type_after_ready,
        def.ready_pattern,
    );
    Ok(json!({
        "id": bound.id,
        "task_id": bound.task_id,
        "agent_id": bound.agent_id,
        "profile_id": bound.profile_id,
        "status": bound.status,
        "pane_session_id": bound.pane_session_id,
    }))
}
/// A unified patch of the task's checkout against the merge base with its base branch. Untracked files are
/// included through `git add -N`, and the index is always restored afterwards. Git runs through the SSH-aware
/// runner, so `ssh://` worktrees work too.
fn review_patch(root: &Path, base: &str) -> Result<String, RpcError> {
    let git = |args: &[&str]| -> Result<Vec<u8>, RpcError> {
        tessera_git::run_with_timeout(root, args, Duration::from_secs(30)).map_err(store_error)
    };
    let merge_base = String::from_utf8_lossy(&git(&["merge-base", base, "HEAD"])?)
        .trim()
        .to_string();
    if merge_base.is_empty() {
        return Err(invalid_state("The task has no merge base with its base branch."));
    }
    let untracked = git(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    let paths: Vec<String> = untracked
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect();
    let mut intent_added = Vec::new();
    for chunk in paths.chunks(100) {
        let mut args = vec!["add", "-N", "--"];
        args.extend(chunk.iter().map(String::as_str));
        if git(&args).is_ok() {
            intent_added.extend(chunk.iter().cloned());
        }
    }
    let diff = git(&["diff", "--find-renames", "--no-ext-diff", &merge_base]);
    for chunk in intent_added.chunks(100) {
        let mut args = vec!["reset", "-q", "--"];
        args.extend(chunk.iter().map(String::as_str));
        let _ = git(&args);
    }
    let mut patch = String::from_utf8_lossy(&diff?).into_owned();
    const CAP: usize = 768 * 1024;
    if patch.len() > CAP {
        patch.truncate(CAP);
        patch.push_str("\n[patch truncated]\n");
    }
    Ok(patch)
}
fn hook_event(store: &Store, params: Value) -> Result<AgentSession, RpcError> {
    let hook: Hook = serde_json::from_value(params.clone()).map_err(|_| RpcError::new(-32602, "Invalid params"))?;
    if hook.event.is_empty() || hook.tessera_session_id.is_empty() {
        return Err(RpcError::new(-32602, "Invalid params"));
    }
    let row = store
        .agent_sessions()
        .find_by_pane(&hook.tessera_session_id)
        .map_err(|_| RpcError::invalid_state())?
        .ok_or_else(RpcError::not_found)?;
    // Preserve the event discriminator and original vendor JSON together for later status consumers.
    store
        .agent_sessions()
        .append_event(&row.id, "hook", &params.to_string(), hook.at)
        .map_err(|_| RpcError::invalid_state())?;
    let key = match row.agent_id.as_str() {
        "claude" | "gemini" => Some("session_id"),
        "codex" => Some("thread-id"),
        _ => None,
    };
    if let Some(external) = key.and_then(|key| hook.payload.get(key)).and_then(Value::as_str) {
        store
            .agent_sessions()
            .set_external_session_id(&row.id, external)
            .map_err(|_| RpcError::invalid_state())?;
    }
    Ok(store
        .agent_sessions()
        .get(&row.id)
        .map_err(|_| RpcError::invalid_state())?
        .ok_or_else(RpcError::not_found)?
        .into())
}
impl Handler for DesktopHandler {
    fn handle(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "app.info" => {
                // Expose only this opt-in flag so the MCP CLI can use the same authenticated endpoint,
                // including disposable/overridden roots, without reading or guessing a config path.
                let config = crate::settings_commands::settings_get(self.0.state())
                    .map_err(|e| RpcError::new(-32603, e.message))?;
                Ok(json!({"version":env!("CARGO_PKG_VERSION"),"api_version":1,"mcp_server":config.api.mcp_server}))
            }
            "app.notify" => {
                let input: Notification = parse_params(params)?;
                self.0
                    .notification()
                    .builder()
                    .title(input.title)
                    .body(input.body)
                    .show()
                    .map_err(|_| RpcError::invalid_state())?;
                Ok(Value::Null)
            }
            "hook.event" => {
                // Append the vendor payload (kind "hook"), then feed the status engine so the sidebar and pane
                // reflect the event within the same request.
                let (row, hook) = {
                    let state = self.0.state::<AppState>();
                    let store = state.store.lock().map_err(|_| RpcError::invalid_state())?;
                    let row = hook_event(&store, params.clone())?;
                    let hook: Hook =
                        serde_json::from_value(params).map_err(|_| RpcError::new(-32602, "Invalid params"))?;
                    (row, hook)
                };
                let config = self.0.state::<AppState>().dirs.root.clone();
                let input = crate::agent_status::hook_input(&config, &row.agent_id, &hook.event, &hook.payload)
                    .map_err(|_| RpcError::invalid_state())?;
                let event = hook.event.clone();
                let updated = crate::agent_status::apply_and_emit(&self.0, &row.id, input, Some(&event))
                    .map_err(|_| RpcError::invalid_state())?;
                AgentSessionChanged(updated)
                    .emit(&self.0)
                    .map_err(|_| RpcError::invalid_state())?;
                Ok(Value::Null)
            }
            "project.list" => {
                let state = self.0.state::<AppState>();
                let store = state
                    .store
                    .lock()
                    .map_err(|_| invalid_state("The store is unavailable."))?;
                let mut rows = store.projects().list().map_err(store_error)?;
                rows.sort_by_key(|p| (p.sort.unwrap_or(0), p.id.clone()));
                let projects: Result<Vec<Value>, _> = rows
                    .into_iter()
                    .map(|p| {
                        serde_json::to_value(Project::try_from(p).map_err(app_error)?)
                            .map_err(|e| invalid_state(e.to_string()))
                    })
                    .collect();
                Ok(Value::Array(projects?))
            }
            "project.add" => {
                let input: ProjectAdd = parse_params(params)?;
                if input.path.trim().is_empty() {
                    return Err(invalid_params());
                }
                let state = self.0.state::<AppState>();
                let root = state.dirs.root.clone();
                let store = state
                    .store
                    .lock()
                    .map_err(|_| invalid_state("The store is unavailable."))?;
                let project = store
                    .project_add_local(Path::new(&input.path), &root)
                    .map_err(project_error)?;
                serde_json::to_value(Project::try_from(project).map_err(app_error)?)
                    .map_err(|e| invalid_state(e.to_string()))
            }
            "task.list" => {
                let input: TaskListParams = parse_params(params)?;
                let state = self.0.state::<AppState>();
                let tasks = {
                    let store = state
                        .store
                        .lock()
                        .map_err(|_| invalid_state("The store is unavailable."))?;
                    store.tasks().list().map_err(store_error)?
                };
                let mut summaries = Vec::new();
                for stored in tasks {
                    if stored.state.as_deref() == Some("deleted") {
                        continue;
                    }
                    if let Some(status) = &input.status
                        && stored.state.as_deref() != Some(status.as_str())
                    {
                        continue;
                    }
                    if let Some(project) = &input.project {
                        // Resolve under a short lock; the task's project id is compared to id, slug or path.
                        let matches = {
                            let store = state
                                .store
                                .lock()
                                .map_err(|_| invalid_state("The store is unavailable."))?;
                            let resolved = resolve_project(&store, project);
                            match resolved {
                                Ok(p) => stored.project_id.as_deref() == Some(p.id.as_str()),
                                Err(_) => false,
                            }
                        };
                        if !matches {
                            continue;
                        }
                    }
                    summaries.push(
                        serde_json::to_value(task_summary(&self.0, stored))
                            .map_err(|e| invalid_state(e.to_string()))?,
                    );
                }
                Ok(Value::Array(summaries))
            }
            "task.create" => {
                let input: TaskCreateParams = parse_params(params)?;
                let state = self.0.state::<AppState>();
                let task = {
                    let store = state
                        .store
                        .lock()
                        .map_err(|_| invalid_state("The store is unavailable."))?;
                    let project = resolve_project(&store, &input.project)?;
                    let base = input.base.clone().unwrap_or_else(|| project.default_branch.clone());
                    store
                        .task_create_record(
                            CreateTask {
                                project_id: project.id,
                                name: input.name.clone(),
                                prompt: input.prompt.clone(),
                                base_branch: base,
                                existing_branch: None,
                                use_main_checkout: false,
                                run_setup: false,
                            },
                            |_| {},
                        )
                        .map_err(task_error)?
                };
                emit_task(&self.0, &task);
                reconcile_watchers(&self.0);
                let mut agents = Vec::new();
                for agent in &input.agents {
                    match launch_agent(&self.0, &task.id, agent, input.prompt.as_deref()) {
                        Ok(session) => agents.push(session),
                        Err(error) => agents.push(json!({"agent": agent, "error": error.message})),
                    }
                }
                Ok(json!({
                    "tasks": [serde_json::to_value(task_summary(&self.0, task)).map_err(|e| invalid_state(e.to_string()))?],
                    "agents": agents,
                }))
            }
            "task.archive" | "task.delete" => {
                let input: TaskRef = parse_params(params)?;
                let state = self.0.state::<AppState>();
                let task_id = {
                    let store = state
                        .store
                        .lock()
                        .map_err(|_| invalid_state("The store is unavailable."))?;
                    resolve_task(&store, &input.task)?.id
                };
                if method == "task.delete" {
                    // The watcher holds the worktree folder open on Windows; drop it before the store work.
                    crate::task_commands::drop_task_watcher(&self.0, &task_id);
                }
                let (stored, worktree) = {
                    let store = state
                        .store
                        .lock()
                        .map_err(|_| invalid_state("The store is unavailable."))?;
                    let prior = store.task_get(&task_id).map_err(task_error)?;
                    let worktree = if method == "task.delete" && prior.uses_main_checkout == Some(0) {
                        prior.worktree_path.clone().map(PathBuf::from)
                    } else {
                        None
                    };
                    let stored = if method == "task.archive" {
                        store.task_archive_record(&task_id, |_| {}).map_err(task_error)?
                    } else {
                        let host = Arc::clone(&state.sessions);
                        store
                            .task_delete_record_with(
                                &task_id,
                                input.confirm_lost_commits,
                                |_| {},
                                |path| {
                                    host.kill_task_sessions(&task_id, path, Duration::from_secs(5));
                                },
                            )
                            .map_err(task_error)?;
                        prior
                    };
                    (stored, worktree)
                };
                emit_task(&self.0, &stored);
                reconcile_watchers(&self.0);
                if let Some(worktree) = worktree {
                    let app = self.0.clone();
                    let id = task_id.clone();
                    std::thread::Builder::new()
                        .name("tessera-api-worktree-cleanup".into())
                        .spawn(move || {
                            if !worktree.exists() {
                                return;
                            }
                            let host = Arc::clone(&app.state::<AppState>().sessions);
                            host.kill_task_sessions(&id, &worktree, Duration::from_secs(5));
                            for _ in 0..25 {
                                match std::fs::remove_dir_all(&worktree) {
                                    Ok(()) => return,
                                    Err(_) if !worktree.exists() => return,
                                    Err(_) => std::thread::sleep(Duration::from_millis(200)),
                                }
                            }
                            tracing::warn!(task = %id, "the task worktree folder could not be removed after its shells were stopped");
                        })
                        .ok();
                }
                Ok(Value::Null)
            }
            "agent.status" => {
                let input: TaskRef = parse_params(params)?;
                let state = self.0.state::<AppState>();
                let store = state
                    .store
                    .lock()
                    .map_err(|_| invalid_state("The store is unavailable."))?;
                let task = resolve_task(&store, &input.task)?;
                let row = latest_session(&store, &task.id)?.ok_or_else(RpcError::not_found)?;
                Ok(json!({
                    "status": row.status,
                    "since": row.status_at,
                    "message": row.status_message,
                    "session": row.id,
                    "agent": row.agent_id,
                }))
            }
            "agent.wait" => {
                let input: AgentWaitParams = parse_params(params)?;
                if input.statuses.is_empty() {
                    return Err(invalid_params());
                }
                let wanted: Vec<String> = input.statuses;
                let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(300_000).min(86_400_000));
                let state = self.0.state::<AppState>();
                {
                    let store = state
                        .store
                        .lock()
                        .map_err(|_| invalid_state("The store is unavailable."))?;
                    resolve_task(&store, &input.task)?;
                }
                let task_id = input.task.clone();
                let (status, timed_out) = wait_status(
                    || {
                        let store = state
                            .store
                            .lock()
                            .map_err(|_| invalid_state("The store is unavailable."))?;
                        let task = resolve_task(&store, &task_id)?;
                        Ok(latest_session(&store, &task.id)?
                            .map(|s| s.status)
                            .unwrap_or_else(|| "none".to_string()))
                    },
                    &wanted,
                    timeout,
                )?;
                Ok(json!({"status": status, "timed_out": timed_out}))
            }
            "agent.send" => {
                let input: AgentSendParams = parse_params(params)?;
                if input.text.is_empty() {
                    return Err(invalid_params());
                }
                let state = self.0.state::<AppState>();
                let pty = {
                    let store = state
                        .store
                        .lock()
                        .map_err(|_| invalid_state("The store is unavailable."))?;
                    let task = resolve_task(&store, &input.task)?;
                    let row = pane_session(&store, &task.id)?
                        .ok_or_else(|| invalid_state("The task's newest agent has no running pane."))?;
                    row.pane_session_id
                        .parse::<SessionId>()
                        .map_err(|_| invalid_state("The agent pane session is unavailable."))?
                };
                // A trailing Enter submits the text, matching how the prompt bar delivers messages.
                let mut bytes = input.text.into_bytes();
                bytes.extend_from_slice(b"\r");
                state.sessions.write(&pty, &bytes).map_err(app_error)?;
                Ok(Value::Null)
            }
            "pane.read" => {
                let input: PaneReadParams = parse_params(params)?;
                if input.task.is_some() == input.session.is_some() {
                    return Err(invalid_params());
                }
                let lines = input.lines.unwrap_or(200).clamp(1, 5000);
                let state = self.0.state::<AppState>();
                let pty = {
                    let store = state
                        .store
                        .lock()
                        .map_err(|_| invalid_state("The store is unavailable."))?;
                    let candidate = if let Some(reference) = &input.session {
                        // A PTY session id directly, or an agent session id that resolves to its pane.
                        match reference.parse::<SessionId>() {
                            Ok(id) => Some(id),
                            Err(_) => store
                                .agent_sessions()
                                .get(reference)
                                .map_err(store_error)?
                                .filter(|s| !s.pane_session_id.is_empty())
                                .and_then(|s| s.pane_session_id.parse::<SessionId>().ok()),
                        }
                    } else {
                        let task = resolve_task(&store, input.task.as_deref().unwrap_or_default())?;
                        pane_session(&store, &task.id)?.and_then(|s| s.pane_session_id.parse::<SessionId>().ok())
                    };
                    candidate.ok_or_else(RpcError::not_found)?
                };
                let bytes = state.sessions.snapshot(&pty).map_err(app_error)?;
                let text = strip_escapes(&String::from_utf8_lossy(&bytes));
                Ok(json!({"text": tail_lines(&text, lines)}))
            }
            "review.diff" => {
                let input: ReviewDiffParams = parse_params(params)?;
                let state = self.0.state::<AppState>();
                let (root, base) = {
                    let store = state
                        .store
                        .lock()
                        .map_err(|_| invalid_state("The store is unavailable."))?;
                    let task = resolve_task(&store, &input.task)?;
                    let root = if let Some(path) = &task.worktree_path {
                        PathBuf::from(path)
                    } else if task.uses_main_checkout == Some(1) {
                        PathBuf::from(
                            store
                                .projects()
                                .get(task.project_id.as_deref().unwrap_or_default())
                                .map_err(store_error)?
                                .ok_or_else(RpcError::not_found)?
                                .path,
                        )
                    } else {
                        return Err(invalid_state("The task has no checkout."));
                    };
                    (root, task.base_branch)
                };
                Ok(json!({"patch": review_patch(&root, &base)?}))
            }
            _ => Err(RpcError::method_not_found()),
        }
    }
}
pub fn start(app: &tauri::AppHandle) {
    let root = app.state::<AppState>().dirs.root.clone();
    let handle = app.clone();
    app.manage(LocalApi(Mutex::new(None)));
    let enabled = crate::settings_commands::settings_get(app.state())
        .map(|c| c.api.socket)
        .unwrap_or(true);
    if !enabled {
        return;
    }
    if let Err(error) = std::thread::Builder::new()
        .name("tessera-api-start".into())
        .spawn(
            move || match Server::start(Endpoint::new(root), Arc::new(DesktopHandler(handle.clone()))) {
                Ok(server) => {
                    if let Ok(mut state) = handle.state::<LocalApi>().0.lock() {
                        *state = Some(server);
                    }
                }
                Err(_) => tracing::warn!("The local API could not start; the app will continue without it."),
            },
        )
    {
        tracing::warn!(%error,"The local API startup thread could not start.");
    }
}
pub fn stop(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<LocalApi>()
        && let Ok(mut server) = state.0.lock()
    {
        server.take();
    }
}

#[cfg(test)]
pub(crate) fn hook_event_for_test(store: &Store, params: Value) -> Result<AgentSession, RpcError> {
    hook_event(store, params)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vendor_session_ids_are_captured_without_trusting_the_request_agent() {
        for (agent, key) in [
            ("claude", "session_id"),
            ("gemini", "session_id"),
            ("codex", "thread-id"),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let store = Store::open(&tessera_store::DataDirs::from_root(tmp.path())).unwrap();
            store.agent_profiles().ensure_default(agent).unwrap();
            let profile = store.agent_profiles().list(Some(agent)).unwrap()[0].id.clone();
            let row = store.agent_sessions().create(None, agent, &profile, None).unwrap();
            store
                .agent_sessions()
                .set_pane_session(&row.id, "fixture-pane", "pane", 1)
                .unwrap();
            let params = json!({"tessera_session_id":"fixture-pane","agent":"untrusted","event":"SessionStart","payload":{key:"vendor-session"},"at":2});
            let captured = hook_event(&store, params).unwrap();
            assert_eq!(captured.external_session_id.as_deref(), Some("vendor-session"));
        }
    }
    #[test]
    fn hooks_resolve_pane_append_vendor_payload_and_reject_unknown_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&tessera_store::DataDirs::from_root(tmp.path())).unwrap();
        store.agent_profiles().ensure_default("fake").unwrap();
        let profile = store.agent_profiles().list(None).unwrap()[0].id.clone();
        let row = store.agent_sessions().create(None, "fake", &profile, None).unwrap();
        store
            .agent_sessions()
            .set_pane_session(&row.id, "pty-fixture", "pane-fixture", 10)
            .unwrap();
        let params = json!({"tessera_session_id":"pty-fixture","agent":"fake","event":"Notification","payload":{"original":true},"at":20});
        let changed = hook_event(&store, params.clone()).unwrap();
        assert_eq!(changed.id, row.id);
        let events = store.agent_sessions().events(&row.id).unwrap();
        let event = events.iter().find(|e| e.kind == "hook").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&event.payload).unwrap(), params);
        assert_eq!(event.at, 20);
        assert_eq!(
            hook_event(
                &store,
                json!({"tessera_session_id":"unknown","event":"Stop","payload":{},"at":1})
            )
            .unwrap_err()
            .code,
            -32002
        );
        assert_eq!(hook_event(&store, json!({})).unwrap_err().code, -32602);
    }
    fn fixture_task(id: &str, name: &str, slug: &str) -> tessera_store::repositories::Task {
        tessera_store::repositories::Task {
            id: id.into(),
            project_id: Some("p".into()),
            group_id: None,
            name: name.into(),
            slug: slug.into(),
            branch: format!("tessera/{slug}"),
            base_branch: "main".into(),
            worktree_path: None,
            uses_main_checkout: Some(1),
            board_column: None,
            state: Some("active".into()),
            prompt: None,
            issue_ref: None,
            port_start: None,
            port_count: None,
            pr_number: None,
            pr_url: None,
            pr_state: None,
            ci_state: None,
            last_message: None,
            tags: None,
            created_at: None,
            updated_at: None,
            archived_at: None,
        }
    }
    fn store_with_task() -> (tempfile::TempDir, Store, StoredTask) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&tessera_store::DataDirs::from_root(tmp.path())).unwrap();
        store
            .projects()
            .insert(&tessera_store::repositories::Project {
                id: "p".into(),
                name: "p".into(),
                path: "/fixture".into(),
                remote_url: None,
                default_branch: "main".into(),
                worktree_dir: None,
                setup_script: None,
                setup_shell: None,
                setup_approved_hash: None,
                copy_files: None,
                port_base: None,
                default_profile_id: None,
                is_muted: None,
                sort: None,
                ssh_host_id: None,
                work_mode: "worktrees".into(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        store
            .tasks()
            .insert(&fixture_task("t", "Task One", "task-one"))
            .unwrap();
        let task = store.task_get("t").unwrap();
        (tmp, store, task)
    }
    #[test]
    fn tasks_resolve_by_id_slug_and_name_and_reject_unknown_or_ambiguous() {
        let (_tmp, store, _task) = store_with_task();
        assert_eq!(resolve_task(&store, "t").unwrap().id, "t");
        assert_eq!(resolve_task(&store, "task-one").unwrap().id, "t");
        assert_eq!(resolve_task(&store, "Task One").unwrap().id, "t");
        assert_eq!(resolve_task(&store, "missing").unwrap_err().code, -32002);
        store
            .tasks()
            .insert(&fixture_task("t2", "Task One", "task-two"))
            .unwrap();
        assert_eq!(resolve_task(&store, "Task One").unwrap_err().code, -32602);
    }
    #[test]
    fn wait_status_reports_match_and_timeout() {
        let mut calls = 0;
        let (status, timed_out) = wait_status(
            || {
                calls += 1;
                Ok(if calls < 3 { "working".into() } else { "idle".into() })
            },
            &["idle".to_string()],
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!((status.as_str(), timed_out), ("idle", false));
        let (status, timed_out) = wait_status(
            || Ok("working".to_string()),
            &["idle".to_string()],
            Duration::from_millis(300),
        )
        .unwrap();
        assert_eq!((status.as_str(), timed_out), ("working", true));
    }
    #[test]
    fn escapes_are_stripped_and_tail_lines_keeps_the_last_n() {
        let raw = "one\x1b[31mred\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07 \x1b[2Jtwo\nthree\nfour";
        assert_eq!(strip_escapes(raw), "onered link two\nthree\nfour");
        assert_eq!(tail_lines("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail_lines("a\nb", 10), "a\nb");
        assert_eq!(tail_lines("", 5), "");
    }
    #[test]
    fn review_patch_covers_tracked_untracked_and_restores_the_index() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.name", "Fixture"]);
        git(&["config", "user.email", "fixture@example.invalid"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "base"]);
        git(&["checkout", "-b", "task"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("new.txt"), "fresh\n").unwrap();
        let patch = review_patch(root, "main").unwrap();
        assert!(patch.contains("diff --git a/a.txt b/a.txt"), "{patch}");
        assert!(patch.contains("+two"), "{patch}");
        assert!(patch.contains("diff --git a/new.txt b/new.txt"), "{patch}");
        assert!(patch.contains("+fresh"), "{patch}");
        // The intent-to-add entries were rolled back: the file is untracked again.
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        let status = String::from_utf8_lossy(&status.stdout);
        assert!(status.contains("?? new.txt"), "{status}");
        assert!(!status.contains("A  new.txt"), "{status}");
    }
}
