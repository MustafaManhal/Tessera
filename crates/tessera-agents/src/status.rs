//! The agent status state machine (TRD §4.6, FR-37): `starting → working ⇄ needs_input → idle`, plus `error` and
//! `exited`. Inputs arrive in priority order — hook events, OSC notifications/progress, screen patterns, silence,
//! exit — and a lower-priority input never overrides a higher-priority one seen within the last 3 s, so a pattern
//! cannot flip a hook-reported `needs_input` back to `working`.
//!
//! The module is pure: callers feed it observations and persist the returned [`Transition`]. Timestamps are
//! milliseconds, like the store's.
use serde::{Deserialize, Serialize};

/// The persisted `agent_sessions.status` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Starting,
    Working,
    NeedsInput,
    Idle,
    Error,
    Exited,
}
impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Working => "working",
            Self::NeedsInput => "needs_input",
            Self::Idle => "idle",
            Self::Error => "error",
            Self::Exited => "exited",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "starting" => Self::Starting,
            "working" => Self::Working,
            "needs_input" => Self::NeedsInput,
            "idle" => Self::Idle,
            "error" => Self::Error,
            "exited" => Self::Exited,
            _ => return None,
        })
    }
    /// Terminal states never leave; every other state can still move.
    fn is_terminal(self) -> bool {
        matches!(self, Self::Exited)
    }
}

/// Where a transition came from; persisted as `agent_sessions.status_source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// PTY attached / session created.
    Launch,
    /// A vendor hook event (`hook.event` on the local API).
    Hook,
    /// OSC 9/99/777 notification or OSC 9;4 progress.
    Osc,
    /// A `status-patterns` or `ready-pattern` regex on the visible screen.
    Pattern,
    /// No output for a while and the screen is not at a prompt.
    Silence,
    /// The PTY process exited.
    Exit,
}
impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Hook => "hook",
            Self::Osc => "osc",
            Self::Pattern => "pattern",
            Self::Silence => "silence",
            Self::Exit => "exit",
        }
    }
    /// Higher wins; exit is handled separately because it is terminal.
    fn priority(self) -> u8 {
        match self {
            Self::Hook => 4,
            Self::Osc => 3,
            Self::Pattern => 2,
            Self::Silence => 1,
            Self::Launch | Self::Exit => 0,
        }
    }
}

/// One observation for the engine. `message` becomes the session's `status_message` when the input produces a
/// transition (or refreshes one).
#[derive(Debug, Clone)]
pub enum Input {
    /// A vendor hook event name (`Notification`, `agent-turn-complete`, `AfterAgent`, …) plus the agent's hook kind
    /// (`claude-settings`, `codex-config`, `gemini-settings`) so the mapping stays per-adapter.
    Hook {
        kind: String,
        event: String,
        message: Option<String>,
    },
    /// OSC 9/99/777 notification text.
    OscNotification { text: String },
    /// OSC 9;4 progress: the state code (0 remove, 1 set, 2 error, 3 indeterminate, 4 warning) and optional value.
    OscProgress { state: u8, value: Option<f64> },
    /// The screen matched the definition's `status-patterns` (or the ready pattern → at prompt).
    Screen {
        status: Option<Status>,
        at_prompt: bool,
        message: Option<String>,
    },
    /// No output for `seconds`; meaningful only above the silence threshold.
    Silence { seconds: f64 },
    /// The PTY exited; `code` 0 → exited, anything else → error.
    Exit { code: Option<i32> },
}

impl Input {
    fn source(&self) -> Source {
        match self {
            Self::Hook { .. } => Source::Hook,
            Self::OscNotification { .. } | Self::OscProgress { .. } => Source::Osc,
            Self::Screen { .. } => Source::Pattern,
            Self::Silence { .. } => Source::Silence,
            Self::Exit { .. } => Source::Exit,
        }
    }
}

/// What the engine decided: the new state and where it came from, plus the message to show.
#[derive(Debug, Clone, PartialEq)]
pub struct Transition {
    pub from: Status,
    pub to: Status,
    pub source: Source,
    /// Latest message for `status_message`; `None` keeps the previous one.
    pub message: Option<String>,
}

/// Per-session engine memory: the current status, the last screen verdict (for the silence rule) and when each
/// priority class last reported, for the 3-second shield.
pub struct Tracker {
    pub status: Status,
    pub status_message: Option<String>,
    at_prompt: bool,
    /// Last observation time per source class (ms). Launch/exit do not shield.
    last_seen: [i64; 5],
}

/// How long a higher-priority input shields against lower ones (TRD: 3 s).
pub const SHIELD_MS: i64 = 3_000;
/// Silence only counts after this long without output (TRD: > 5 s).
pub const SILENCE_MS: i64 = 5_000;

impl Tracker {
    pub fn new(status: Status) -> Self {
        Self {
            status,
            status_message: None,
            at_prompt: false,
            last_seen: [i64::MIN; 5],
        }
    }
    /// Rebuild a tracker from a persisted session (restart-safe): the shield windows restart empty.
    pub fn restore(status: Status, message: Option<String>) -> Self {
        Self {
            status,
            status_message: message,
            at_prompt: false,
            last_seen: [i64::MIN; 5],
        }
    }

    /// Feed one observation. Returns `Some(transition)` only when the status actually changes; a repeated
    /// observation of the same state is a no-op (the store does not write either).
    pub fn next(&mut self, input: Input, now: i64) -> Option<Transition> {
        if self.status.is_terminal() {
            return None;
        }
        let source = input.source();
        let priority = source.priority();
        // A lower-priority input never overrides a higher one seen within the shield window.
        if priority > 0 {
            let shielded = self.last_seen.iter().enumerate().any(|(i, at)| {
                i as u8 != priority
                    && Source::from_index(i as u8).priority() > priority
                    && now.saturating_sub(*at) < SHIELD_MS
            });
            if shielded {
                // Still remember weaker evidence? No: ignored entirely, like the spec's priority order.
                return None;
            }
        }
        self.last_seen[priority as usize] = now;
        let to = match input {
            Input::Hook { kind, event, message } => {
                let mapped = hook_status(&kind, &event);
                if let Some(message) = message {
                    self.status_message = Some(message);
                }
                mapped.unwrap_or(self.status)
            }
            Input::OscNotification { text } => {
                self.status_message = Some(text.clone());
                if says_done(&text) {
                    Status::Idle
                } else {
                    Status::NeedsInput
                }
            }
            Input::OscProgress { state, .. } => match state {
                0 => self.status,             // progress removed: no information
                1 | 3 | 4 => Status::Working, // set / indeterminate / warning: work is happening
                2 => Status::Error,           // error state
                _ => self.status,
            },
            Input::Screen {
                status,
                at_prompt,
                message,
            } => {
                self.at_prompt = at_prompt;
                if let Some(message) = message {
                    self.status_message = Some(message);
                }
                match status {
                    // "Not busy" only ends work; it never clears a question the agent is waiting on.
                    Some(Status::Idle) if !matches!(self.status, Status::Working | Status::Starting) => self.status,
                    Some(found) => found,
                    None => self.status,
                }
            }
            Input::Silence { seconds } => {
                if seconds * 1_000.0 >= SILENCE_MS as f64 && !self.at_prompt {
                    Status::Idle
                } else {
                    self.status
                }
            }
            Input::Exit { code } => {
                if code == Some(0) {
                    Status::Exited
                } else {
                    Status::Error
                }
            }
        };
        if to == self.status {
            return None;
        }
        let transition = Transition {
            from: self.status,
            to,
            source,
            message: self.status_message.clone(),
        };
        self.status = to;
        Some(transition)
    }
}

impl Source {
    fn from_index(index: u8) -> Self {
        match index {
            1 => Self::Silence,
            2 => Self::Pattern,
            3 => Self::Osc,
            4 => Self::Hook,
            _ => Self::Launch,
        }
    }
}

/// The verdict a screen observation produces: a status (if a `status-patterns` regex matched), whether the
/// `ready-pattern` matches the last visible line ("at prompt"), and the matched line for `status_message`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScreenVerdict {
    pub status: Option<Status>,
    pub at_prompt: bool,
    pub message: Option<String>,
}

/// Match a definition's `status-patterns` and `ready-pattern` against the visible screen. Lines inside fenced
/// code blocks and unified-diff hunks never match: a prompt-looking line inside a quoted diff or code sample must
/// not flip the status (brief 31 Part D).
pub fn screen_verdict(definition: &crate::AgentDefinition, lines: &[String]) -> ScreenVerdict {
    let visible = strip_code_and_diffs(lines);
    let mut matched: Option<(Status, String)> = None;
    for (key, status) in [
        ("needs-input", Status::NeedsInput),
        ("error", Status::Error),
        ("working", Status::Working),
    ] {
        let Some(patterns) = definition.status_patterns.get(key) else {
            continue;
        };
        for pattern in patterns {
            let Ok(regex) = regex::Regex::new(pattern) else {
                continue;
            };
            if let Some(line) = visible.iter().find(|line| regex.is_match(line)) {
                matched = Some((status, line.clone()));
                break;
            }
        }
        if matched.is_some() {
            break;
        }
    }
    let at_prompt = definition
        .ready_pattern
        .as_deref()
        .and_then(|p| regex::Regex::new(p).ok())
        .is_some_and(|re| visible.last().is_some_and(|line| re.is_match(line)));
    // An agent that says when it is busy ("esc to interrupt") is idle when the screen no longer says so.
    let can_tell_busy = definition
        .status_patterns
        .get("working")
        .is_some_and(|patterns| !patterns.is_empty());
    ScreenVerdict {
        status: matched
            .as_ref()
            .map(|(status, _)| *status)
            .or(can_tell_busy.then_some(Status::Idle)),
        at_prompt,
        message: matched.map(|(_, line)| line.chars().take(500).collect()),
    }
}

/// Drop fenced code blocks and unified-diff content so quoted prompts/diffs cannot match status patterns.
fn strip_code_and_diffs(lines: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(lines.len());
    let mut in_fence = false;
    let mut in_diff = false;
    for line in lines {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if line.starts_with("diff --git") || line.starts_with("@@") {
            in_diff = true;
            continue;
        }
        if in_diff {
            if line.starts_with(['+', '-', ' ']) || trimmed.starts_with("\\") {
                continue;
            }
            in_diff = false;
        }
        out.push(line.clone());
    }
    out
}

/// Hook event → status, per adapter kind (research/agents.md "Hooks" section, 2026-11-11).
/// Unknown events keep the current state: hooks are evidence, not commands.
pub fn hook_status(kind: &str, event: &str) -> Option<Status> {
    let status = match (kind, event) {
        // Claude Code: lifecycle hooks. SessionStart only means the agent is alive and waiting for input: it is
        // working once a prompt is submitted, and idle again at Stop.
        ("claude-settings", "SessionStart") => Status::Idle,
        ("claude-settings", "UserPromptSubmit") | ("claude-settings", "PreToolUse") => Status::Working,
        ("claude-settings", "PermissionRequest") | ("claude-settings", "Notification") => Status::NeedsInput,
        ("claude-settings", "Stop") => Status::Idle,
        ("claude-settings", "SessionEnd") => Status::Exited,
        // Codex `notify` is a single program; its event is `agent-turn-complete`.
        ("codex-config", "agent-turn-complete") => Status::Idle,
        // Gemini lifecycle hooks; Notification with ToolPermission reports approval attention.
        ("gemini-settings", "SessionStart") => Status::Idle,
        ("gemini-settings", "BeforeAgent") | ("gemini-settings", "BeforeTool") => Status::Working,
        ("gemini-settings", "Notification") => Status::NeedsInput,
        ("gemini-settings", "AfterAgent") => Status::Idle,
        ("gemini-settings", "SessionEnd") => Status::Exited,
        _ => return None,
    };
    Some(status)
}

/// "The text says done": a notification that reports completion maps to idle, not needs_input.
fn says_done(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["done", "completed", "finished", "all set"]
        .iter()
        .any(|word| lower.contains(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker(status: Status) -> Tracker {
        Tracker::new(status)
    }
    fn hook(kind: &str, event: &str) -> Input {
        Input::Hook {
            kind: kind.into(),
            event: event.into(),
            message: None,
        }
    }
    fn osc(text: &str) -> Input {
        Input::OscNotification { text: text.into() }
    }
    fn screen(status: Option<Status>, at_prompt: bool) -> Input {
        Input::Screen {
            status,
            at_prompt,
            message: None,
        }
    }

    #[test]
    fn claude_hook_events_drive_the_state_machine() {
        let mut t = tracker(Status::Starting);
        // A started session is waiting for input, not working.
        assert_eq!(
            t.next(hook("claude-settings", "SessionStart"), 0).unwrap().to,
            Status::Idle
        );
        assert_eq!(
            t.next(hook("claude-settings", "UserPromptSubmit"), 50).unwrap().to,
            Status::Working
        );
        // Already working: a repeated hook is a no-op, no write.
        assert!(t.next(hook("claude-settings", "PreToolUse"), 100).is_none());
        assert_eq!(
            t.next(hook("claude-settings", "PermissionRequest"), 300).unwrap().to,
            Status::NeedsInput
        );
        assert_eq!(t.next(hook("claude-settings", "Stop"), 400).unwrap().to, Status::Idle);
        assert_eq!(
            t.next(hook("claude-settings", "UserPromptSubmit"), 500).unwrap().to,
            Status::Working
        );
        assert_eq!(
            t.next(hook("claude-settings", "SessionEnd"), 600).unwrap().to,
            Status::Exited
        );
        // Terminal: nothing moves it again.
        assert!(t.next(osc("still here?"), 700).is_none());
    }

    #[test]
    fn codex_and_gemini_events_map_to_their_documented_meanings() {
        let mut t = tracker(Status::Working);
        assert_eq!(
            t.next(hook("codex-config", "agent-turn-complete"), 0).unwrap().to,
            Status::Idle
        );
        let mut g = tracker(Status::Working);
        assert_eq!(
            g.next(hook("gemini-settings", "Notification"), 0).unwrap().to,
            Status::NeedsInput
        );
        assert_eq!(
            g.next(hook("gemini-settings", "AfterAgent"), 10).unwrap().to,
            Status::Idle
        );
        assert_eq!(
            g.next(hook("gemini-settings", "SessionEnd"), 20).unwrap().to,
            Status::Exited
        );
    }

    #[test]
    fn unknown_hook_events_and_kinds_are_ignored() {
        let mut t = tracker(Status::Working);
        assert!(t.next(hook("claude-settings", "TotallyUnknown"), 0).is_none());
        assert!(t.next(hook("none", "Stop"), 0).is_none());
        assert_eq!(t.status, Status::Working);
    }

    #[test]
    fn osc_notification_needs_input_unless_the_text_says_done() {
        let mut t = tracker(Status::Working);
        assert_eq!(
            t.next(osc("Permission needed for /etc/hosts"), 0).unwrap().to,
            Status::NeedsInput
        );
        let transition = t.next(osc("Build finished: 42 tests passed"), 100).unwrap();
        assert_eq!(transition.to, Status::Idle);
        assert_eq!(transition.source, Source::Osc);
        assert_eq!(t.status_message.as_deref(), Some("Build finished: 42 tests passed"));
    }

    #[test]
    fn osc_progress_marks_working_and_error() {
        let mut t = tracker(Status::Idle);
        assert_eq!(
            t.next(
                Input::OscProgress {
                    state: 1,
                    value: Some(0.5)
                },
                0
            )
            .unwrap()
            .to,
            Status::Working
        );
        assert_eq!(
            t.next(Input::OscProgress { state: 2, value: None }, 10).unwrap().to,
            Status::Error
        );
        // Progress removed (state 0) is no information: stays put.
        let mut u = tracker(Status::Working);
        assert!(u.next(Input::OscProgress { state: 0, value: None }, 0).is_none());
    }

    #[test]
    fn screen_patterns_set_status_and_track_the_prompt() {
        let mut t = tracker(Status::Working);
        assert!(t.next(screen(Some(Status::NeedsInput), false), 0).is_some());
        assert_eq!(t.status, Status::NeedsInput);
        // A screen observation without a pattern match keeps the status but records the prompt.
        assert!(t.next(screen(None, true), 10).is_none() || t.status == Status::NeedsInput);
        let mut s = tracker(Status::Working);
        assert!(s.next(screen(None, true), 0).is_none());
        assert!(s.next(Input::Silence { seconds: 30.0 }, 100).is_none());
    }

    #[test]
    fn silence_goes_idle_only_after_five_seconds_and_not_at_a_prompt() {
        let mut t = tracker(Status::Working);
        assert!(t.next(Input::Silence { seconds: 4.9 }, 0).is_none());
        let transition = t.next(Input::Silence { seconds: 6.0 }, 6_000).unwrap();
        assert_eq!(transition.to, Status::Idle);
        assert_eq!(transition.source, Source::Silence);
        // Once at a prompt again, silence is expected and does nothing.
        let mut p = tracker(Status::Working);
        p.next(screen(None, true), 0);
        assert!(p.next(Input::Silence { seconds: 60.0 }, 60_000).is_none());
        assert_eq!(p.status, Status::Working);
    }

    #[test]
    fn exit_maps_zero_to_exited_and_failures_to_error() {
        let mut ok = tracker(Status::Working);
        assert_eq!(ok.next(Input::Exit { code: Some(0) }, 0).unwrap().to, Status::Exited);
        let mut bad = tracker(Status::Working);
        assert_eq!(bad.next(Input::Exit { code: Some(1) }, 0).unwrap().to, Status::Error);
        let mut none = tracker(Status::Working);
        assert_eq!(none.next(Input::Exit { code: None }, 0).unwrap().to, Status::Error);
    }

    #[test]
    fn a_lower_priority_input_never_overrides_a_recent_higher_one() {
        // Hook says needs_input; a screen pattern saying "working" 1 s later must not flip it.
        let mut t = tracker(Status::Working);
        t.next(hook("claude-settings", "PermissionRequest"), 10_000).unwrap();
        assert!(t.next(screen(Some(Status::Working), false), 11_000).is_none());
        assert_eq!(t.status, Status::NeedsInput);
        // After the shield window the pattern may speak again.
        assert!(t.next(screen(Some(Status::Working), false), 14_000).is_some());
        // Same-priority inputs are never shielded by each other.
        let mut o = tracker(Status::Working);
        o.next(osc("attention please"), 0).unwrap();
        assert_eq!(o.next(osc("done, all finished"), 100).unwrap().to, Status::Idle);
        // A higher priority input is never shielded by a lower one.
        let mut h = tracker(Status::Working);
        h.next(Input::Silence { seconds: 9.0 }, 0).unwrap();
        assert_eq!(
            h.next(hook("claude-settings", "PreToolUse"), 100).unwrap().to,
            Status::Working
        );
    }

    #[test]
    fn idle_returns_to_working_on_new_input() {
        let mut t = tracker(Status::Idle);
        assert_eq!(
            t.next(hook("claude-settings", "UserPromptSubmit"), 0).unwrap().to,
            Status::Working
        );
        let mut s = tracker(Status::Idle);
        assert_eq!(
            s.next(screen(Some(Status::Working), false), 0).unwrap().to,
            Status::Working
        );
    }

    #[test]
    fn transitions_carry_the_source_and_message() {
        let mut t = tracker(Status::Working);
        let transition = t
            .next(
                Input::OscNotification {
                    text: "Claude needs your approval".into(),
                },
                0,
            )
            .unwrap();
        assert_eq!(transition.from, Status::Working);
        assert_eq!(transition.to, Status::NeedsInput);
        assert_eq!(transition.source, Source::Osc);
        assert_eq!(transition.message.as_deref(), Some("Claude needs your approval"));
        assert_eq!(t.status_message.as_deref(), Some("Claude needs your approval"));
        // Past the shield window a pattern may move it; a transition without a message keeps the previous one.
        let next = t.next(screen(Some(Status::Working), false), 4_000).unwrap();
        assert_eq!(next.message.as_deref(), Some("Claude needs your approval"));
    }

    #[test]
    fn a_quiet_screen_ends_work_but_never_clears_a_question() {
        let mut working = tracker(Status::Working);
        assert_eq!(
            working.next(screen(Some(Status::Idle), false), 0).unwrap().to,
            Status::Idle
        );
        let mut asking = tracker(Status::NeedsInput);
        assert!(asking.next(screen(Some(Status::Idle), false), 10_000).is_none());
        let mut starting = tracker(Status::Starting);
        assert_eq!(
            starting.next(screen(Some(Status::Idle), false), 0).unwrap().to,
            Status::Idle
        );
    }

    fn def(patterns: &[(&str, &str)], ready: Option<&str>) -> crate::AgentDefinition {
        crate::AgentDefinition {
            id: "fake".into(),
            name: "Fake".into(),
            binaries: vec!["fake".into()],
            version_cmd: vec!["fake".into()],
            prompt_mode: "stdin".into(),
            model_flag: None,
            resume: vec![],
            yolo_flags: vec![],
            hooks: "none".into(),
            ready_pattern: ready.map(Into::into),
            status_patterns: patterns
                .iter()
                .map(|(k, v)| (k.to_string(), vec![v.to_string()]))
                .collect(),
            usage: Default::default(),
            install_url: "https://example.com".into(),
            docs_url: "https://example.com".into(),
            icon: "x".into(),
        }
    }

    #[test]
    fn screen_verdict_matches_patterns_and_ready() {
        let d = def(
            &[("needs-input", "do you approve"), ("working", "working on it")],
            Some(">"),
        );
        let verdict = screen_verdict(&d, &["working on it".to_string(), "do you approve?".to_string()]);
        assert_eq!(verdict.status, Some(Status::NeedsInput));
        assert!(!verdict.at_prompt);
        assert_eq!(verdict.message.as_deref(), Some("do you approve?"));
        // needs-input beats working and error when several patterns match.
        let d2 = def(
            &[("working", "working"), ("needs-input", "approve"), ("error", "failed")],
            None,
        );
        let v2 = screen_verdict(
            &d2,
            &["working".to_string(), "approve?".to_string(), "failed".to_string()],
        );
        assert_eq!(v2.status, Some(Status::NeedsInput));
        let v3 = screen_verdict(&d, &["noise".to_string(), "user@host > $".to_string()]);
        assert!(v3.at_prompt);
        // This definition can tell when the agent is busy, and no line says so: it is idle.
        assert_eq!(v3.status, Some(Status::Idle));
        let quiet = def(&[("needs-input", "approve")], None);
        assert_eq!(screen_verdict(&quiet, &["noise".to_string()]).status, None);
    }

    #[test]
    fn screen_verdict_never_matches_inside_code_or_diffs() {
        let d = def(&[("needs-input", "do you approve")], None);
        let lines = vec![
            "```diff".to_string(),
            "+do you approve this change?".to_string(),
            "```".to_string(),
            "diff --git a/f b/f".to_string(),
            "@@ -1 +1 @@".to_string(),
            "-old".to_string(),
            "+do you approve".to_string(),
            "normal output".to_string(),
        ];
        assert_eq!(screen_verdict(&d, &lines).status, None);
        // The same text outside a fence/diff does match.
        assert_eq!(
            screen_verdict(&d, &["do you approve?".to_string()]).status,
            Some(Status::NeedsInput)
        );
    }

    #[test]
    fn restore_rebuilds_without_shield_memory() {
        let mut t = Tracker::restore(Status::NeedsInput, Some("waiting".into()));
        assert_eq!(t.status_message.as_deref(), Some("waiting"));
        // No recent higher-priority input is remembered, so a pattern may move it at once.
        assert!(t.next(screen(Some(Status::Working), false), 0).is_some());
    }
}
