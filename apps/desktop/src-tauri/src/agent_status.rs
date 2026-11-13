//! The status engine wiring (brief 31, TRD §4.6): hook events, OSC observations, screen patterns and silence feed
//! the pure state machine in `tessera_agents::status`; transitions persist through `agent_sessions` +
//! `agent_events` and emit `agent:session_changed`.
use crate::{
    agent_commands::definition, agent_launch_commands::AgentSessionChanged, agent_types::AgentSession, error::AppError,
    state::AppState,
};
use serde::Deserialize;
use specta::Type;
use std::{collections::HashMap, path::Path, sync::Mutex};
use tauri::Manager;
use tauri_specta::Event;
use tessera_agents::status::{self, Input, Status, Tracker};
use tessera_store::{Store, agents::now_millis};

/// Per-session engine memory, rebuilt from the persisted status after a restart.
#[derive(Default)]
pub struct AgentEngines(pub Mutex<HashMap<String, Tracker>>);

/// What the front end observed in an agent pane.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentObservation {
    /// OSC 9/99/777 notification text.
    OscNotification { text: String },
    /// OSC 9;4 progress: state code (0 remove, 1 set, 2 error, 3 indeterminate, 4 warning), optional value.
    OscProgress { state: u8, value: Option<f64> },
    /// The last visible screen lines; Rust matches the definition's `status-patterns` and `ready-pattern`.
    Screen { lines: Vec<String> },
    /// Seconds since the last output.
    Silence { seconds: f64 },
}

/// Feed one observation through the engine and persist any transition. Returns the (possibly unchanged) session
/// and whether it changed. Message-only updates persist without a timeline entry, inside the store.
pub fn observe(
    app: &tauri::AppHandle,
    session_id: &str,
    input: Input,
    event_name: Option<&str>,
) -> Result<(AgentSession, bool), AppError> {
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let engines_state = app.state::<AgentEngines>();
    let mut engines = engines_state.0.lock().unwrap_or_else(|e| e.into_inner());
    let (row, changed) = apply(&store, &mut engines, session_id, input, event_name)?;
    Ok((row.into(), changed))
}

/// The store-level core, testable without an app handle.
pub fn apply(
    store: &Store,
    engines: &mut HashMap<String, Tracker>,
    session_id: &str,
    input: Input,
    event_name: Option<&str>,
) -> Result<(tessera_store::agent_sessions::AgentSession, bool), AppError> {
    let row = store
        .agent_sessions()
        .get(session_id)?
        .ok_or_else(|| AppError::new("agent.missing", "The agent session does not exist."))?;
    if row.ended_at.is_some() {
        return Ok((row, false));
    }
    let tracker = engines.entry(row.id.clone()).or_insert_with(|| {
        Tracker::restore(
            Status::parse(&row.status).unwrap_or(Status::Starting),
            row.status_message.clone(),
        )
    });
    let now = now_millis();
    let Some(transition) = tracker.next(input.clone(), now) else {
        // No status change: still persist a newer message when the input carried one.
        if let Some(message) = input_message(&input)
            && row.status_message.as_deref() != Some(message.as_str())
        {
            let updated = store
                .agent_sessions()
                .set_status_detail(
                    &row.id,
                    &row.status,
                    &row.status_source,
                    Some(&message),
                    event_name,
                    now,
                )?
                .unwrap_or(row.clone());
            return Ok((updated, true));
        }
        return Ok((row, false));
    };
    let updated = store
        .agent_sessions()
        .set_status_detail(
            &row.id,
            transition.to.as_str(),
            transition.source.as_str(),
            transition.message.as_deref(),
            event_name,
            now,
        )?
        .ok_or_else(|| AppError::new("agent.missing", "The agent session does not exist."))?;
    Ok((updated, true))
}

fn input_message(input: &Input) -> Option<String> {
    match input {
        Input::Hook { message, .. } => message.clone(),
        Input::OscNotification { text } => Some(text.clone()),
        Input::Screen { message, .. } => message.clone(),
        _ => None,
    }
}

/// A hook event from `hook.event`: the event name plus a best-effort message from the vendor payload.
pub fn hook_input(
    config_root: &Path,
    agent_id: &str,
    event: &str,
    payload: &serde_json::Value,
) -> Result<Input, AppError> {
    let def = definition(config_root, agent_id)?;
    Ok(Input::Hook {
        kind: def.hooks.clone(),
        event: event.to_string(),
        message: hook_message(payload),
    })
}

/// The human-readable bit of a hook payload: Claude `message`/`notification_message`, Codex
/// `last-assistant-message`, Gemini `message` — first hit wins, truncated downstream.
fn hook_message(payload: &serde_json::Value) -> Option<String> {
    for key in [
        "message",
        "notification_message",
        "last-assistant-message",
        "last_assistant_message",
    ] {
        if let Some(text) = payload.get(key).and_then(|v| v.as_str())
            && !text.trim().is_empty()
        {
            return Some(text.chars().take(500).collect());
        }
    }
    None
}

/// Screen lines → engine input via the pure matcher in `tessera_agents::status`.
pub fn screen_input(definition_: &tessera_agents::AgentDefinition, lines: &[String]) -> Input {
    let verdict = status::screen_verdict(definition_, lines);
    Input::Screen {
        status: verdict.status,
        at_prompt: verdict.at_prompt,
        message: verdict.message,
    }
}

/// Persist a transition and emit the session event. Shared by `agent_observe` and `hook.event`.
pub fn apply_and_emit(
    app: &tauri::AppHandle,
    session_id: &str,
    input: Input,
    event_name: Option<&str>,
) -> Result<AgentSession, AppError> {
    let (row, changed) = observe(app, session_id, input, event_name)?;
    if changed {
        AgentSessionChanged(row.clone())
            .emit(app)
            .map_err(|_| AppError::new("agent.emit_failed", "The session event could not be emitted."))?;
    }
    Ok(row)
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use tessera_agents::status::Input;
    use tessera_store::{DataDirs, Store};

    fn fixture() -> (tempfile::TempDir, Store, String) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&DataDirs::from_root(tmp.path())).unwrap();
        store.agent_profiles().ensure_default("claude").unwrap();
        let profile = store.agent_profiles().list(None).unwrap()[0].id.clone();
        let session = store.agent_sessions().create(None, "claude", &profile, None).unwrap();
        store
            .agent_sessions()
            .set_pane_session(&session.id, "pty-1", "pane-1", now_millis())
            .unwrap();
        (tmp, store, session.id)
    }

    #[test]
    fn hook_events_drive_status_events_and_messages_end_to_end() {
        let (_tmp, store, id) = fixture();
        let mut engines = HashMap::new();
        // PermissionRequest → needs_input with the hook's message.
        let (row, changed) = apply(
            &store,
            &mut engines,
            &id,
            Input::Hook {
                kind: "claude-settings".into(),
                event: "PermissionRequest".into(),
                message: Some("Allow bash?".into()),
            },
            Some("PermissionRequest"),
        )
        .unwrap();
        assert!(changed);
        assert_eq!(row.status, "needs_input");
        assert_eq!(row.status_source, "hook");
        assert_eq!(row.status_message.as_deref(), Some("Allow bash?"));
        // Stop → idle; a repeated identical hook writes nothing.
        let (row, changed) = apply(
            &store,
            &mut engines,
            &id,
            Input::Hook {
                kind: "claude-settings".into(),
                event: "Stop".into(),
                message: None,
            },
            Some("Stop"),
        )
        .unwrap();
        assert!(changed && row.status == "idle");
        let events = store.agent_sessions().events(&id).unwrap();
        let status_events: Vec<_> = events.iter().filter(|e| e.kind == "status").collect();
        // starting(launch) + working(attach) + needs_input + idle
        assert_eq!(status_events.len(), 4);
        let last = status_events.last().unwrap();
        assert!(last.payload.contains("\"from\":\"needs_input\""), "{}", last.payload);
        assert!(last.payload.contains("\"status\":\"idle\""), "{}", last.payload);
        assert!(last.payload.contains("\"event\":\"Stop\""), "{}", last.payload);
    }

    #[test]
    fn screen_and_silence_observations_update_status_and_message() {
        let (_tmp, store, id) = fixture();
        let mut engines = HashMap::new();
        // No status-patterns in the bundled claude definition: only at_prompt/ready matter, and silence still fires.
        let (row, _) = apply(&store, &mut engines, &id, Input::Silence { seconds: 6.0 }, None).unwrap();
        assert_eq!(row.status, "idle");
        assert_eq!(row.status_source, "silence");
        // OSC notification → needs_input with its text as the message.
        let (row, _) = apply(
            &store,
            &mut engines,
            &id,
            Input::OscNotification {
                text: "Claude needs your approval".into(),
            },
            None,
        )
        .unwrap();
        assert_eq!(row.status, "needs_input");
        assert_eq!(row.status_message.as_deref(), Some("Claude needs your approval"));
        // A second notification while already needs_input updates only the message, no timeline row.
        let before = store.agent_sessions().events(&id).unwrap().len();
        let (row, changed) = apply(
            &store,
            &mut engines,
            &id,
            Input::OscNotification {
                text: "Second notice".into(),
            },
            None,
        )
        .unwrap();
        assert!(changed);
        assert_eq!(row.status_message.as_deref(), Some("Second notice"));
        assert_eq!(store.agent_sessions().events(&id).unwrap().len(), before);
    }

    #[test]
    fn exited_sessions_ignore_every_observation() {
        let (_tmp, store, id) = fixture();
        let mut engines = HashMap::new();
        store.agent_sessions().mark_exited(&id, 0, now_millis()).unwrap();
        let (row, changed) = apply(
            &store,
            &mut engines,
            &id,
            Input::OscNotification {
                text: "too late".into(),
            },
            None,
        )
        .unwrap();
        assert!(!changed);
        assert_eq!(row.status, "exited");
    }
}

#[cfg(test)]
mod pty_tests {
    //! Scripted fake-agent output through the real PTY host and the engine pieces (brief 31 Part D).
    use super::*;
    use std::{
        path::PathBuf,
        process::Command,
        sync::{Arc, mpsc},
        time::{Duration, Instant},
    };
    use tessera_agents::AgentDefinition;

    fn fake_binary() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tessera-fake-agent-{}", std::process::id()));
        let binary = dir.join(if cfg!(windows) { "fake_agent.exe" } else { "fake_agent" });
        if !binary.is_file() {
            std::fs::create_dir_all(&dir).unwrap();
            let output = Command::new("rustc")
                .arg(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../../crates/tessera-agents/examples/fake_agent.rs"),
                )
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }
        binary
    }

    fn definition() -> AgentDefinition {
        AgentDefinition {
            id: "fake".into(),
            name: "Fake".into(),
            binaries: vec!["fake_agent".into()],
            version_cmd: vec!["fake_agent".into()],
            prompt_mode: "stdin".into(),
            model_flag: None,
            resume: vec![],
            yolo_flags: vec![],
            hooks: "none".into(),
            ready_pattern: Some("(?m)^>\\s*$".into()),
            status_patterns: [
                ("needs-input".to_string(), vec!["do you approve".to_string()]),
                ("working".to_string(), vec!["working on it".to_string()]),
            ]
            .into_iter()
            .collect(),
            usage: Default::default(),
            install_url: "https://example.invalid".into(),
            docs_url: "https://example.invalid".into(),
            icon: "bot".into(),
        }
    }

    /// Runs the fake agent in a real PTY and feeds everything it prints through the engine pieces.
    #[test]
    fn fake_agent_output_drives_screen_osc_and_exit_transitions() {
        let tmp = tempfile::tempdir().unwrap();
        let host = tessera_pty::PtyHost::new();
        let (tx, rx) = mpsc::channel();
        let sink: tessera_pty::EventSink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let mut spec = tessera_pty::SpawnSpec::new(tmp.path());
        spec.program = Some(fake_binary().to_string_lossy().into_owned());
        spec.env
            .insert("FAKE_AGENT_NEEDS_INPUT".into(), "do you approve this?".into());
        spec.env.insert("FAKE_AGENT_NOTIFY".into(), "attention please".into());
        spec.env.insert("FAKE_AGENT_WAIT_MS".into(), "50".into());
        let id = host.spawn_with_sink(spec, Some(sink)).unwrap();
        host.write(&id, b"\r").unwrap();
        let mut output = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut exit_code = None;
        while exit_code.is_none() {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("pty output");
            match event {
                tessera_pty::PtyEvent::Data(bytes) => {
                    host.ack(&id, bytes.len()).unwrap();
                    output.push_str(&String::from_utf8_lossy(&bytes));
                }
                tessera_pty::PtyEvent::Exit { code } => exit_code = Some(code),
            }
        }
        let _ = host.kill(&id);
        let lines: Vec<String> = output.lines().map(str::to_string).collect();
        // Screen: the needs-input line matches the pattern; the prompt line alone would only set at_prompt.
        let verdict = status::screen_verdict(&definition(), &lines);
        assert_eq!(verdict.status, Some(Status::NeedsInput), "{output}");
        assert_eq!(verdict.message.as_deref(), Some("do you approve this?"));
        // Without the scripted line the same screen is only at-prompt.
        let quiet = status::screen_verdict(&definition(), &[">".to_string()]);
        assert_eq!(quiet.status, None);
        assert!(quiet.at_prompt);
        // OSC 9 text feeds the engine as a notification.
        let mut tracker = Tracker::new(Status::Working);
        assert_eq!(
            tracker
                .next(
                    Input::OscNotification {
                        text: "attention please".into()
                    },
                    now_millis()
                )
                .unwrap()
                .to,
            Status::NeedsInput
        );
        // Exit maps through the engine too.
        let code = exit_code.map(|c| i32::try_from(c).unwrap_or(-1));
        assert_eq!(
            tracker.next(Input::Exit { code }, now_millis()).unwrap().to,
            if code == Some(0) { Status::Exited } else { Status::Error }
        );
    }
}

#[cfg(test)]
mod latency_tests {
    //! NFR-06: hook input → persisted session change. The socket hop and event emit are sub-millisecond IPC on
    //! the same machine; this measures the engine + SQLite half, which is the part that can regress.
    use super::*;
    use std::time::Instant;
    use tessera_store::DataDirs;

    #[test]
    fn hook_to_session_change_stays_under_one_second() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&DataDirs::from_root(tmp.path())).unwrap();
        store.agent_profiles().ensure_default("claude").unwrap();
        let profile = store.agent_profiles().list(None).unwrap()[0].id.clone();
        let mut engines = HashMap::new();
        let mut samples = Vec::new();
        for i in 0..20 {
            let session = store.agent_sessions().create(None, "claude", &profile, None).unwrap();
            store
                .agent_sessions()
                .set_pane_session(&session.id, &format!("pty-{i}"), "pane", now_millis())
                .unwrap();
            let start = Instant::now();
            apply(
                &store,
                &mut engines,
                &session.id,
                Input::Hook {
                    kind: "claude-settings".into(),
                    event: "PermissionRequest".into(),
                    message: Some("approve?".into()),
                },
                Some("PermissionRequest"),
            )
            .unwrap();
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let p50 = samples[10];
        let p95 = samples[18];
        println!("hook→session p50={p50:.3}ms p95={p95:.3}ms max={:.3}ms", samples[19]);
        assert!(p95 < 1_000.0, "p95 {p95}ms exceeds the NFR-06 one-second gate");
    }
}
