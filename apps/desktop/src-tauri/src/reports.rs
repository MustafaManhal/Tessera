//! Automatic error reports and usage events (on by default; told once in the tour and the update notes; Settings,
//! Privacy turns it off).
//!
//! What is collected: Rust panics (with a backtrace), an unclean exit of the previous run (a native crash, a force
//! quit, a power cut), warnings and errors the app logs, errors the window reports (exceptions, failed commands, with
//! the app actions just before them), usage counts of app actions, and the tail of Tessera's own log with each error.
//! Never terminal output, typed text, file contents or environment values. Everything passes through the secret
//! redactor and the home folder becomes `~` before it is written.
//!
//! Events are appended to `<data>/reports/queue.jsonl` at once (a crash cannot lose them) and a background thread
//! sends them in batches every minute to the Worker's `POST /v1/reports`. Turning reports off deletes what is queued.
use serde::Deserialize;
use serde_json::{Value, json};
use specta::Type;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tessera_store::redact::redact;
use tessera_sync::reports::{ReportBatch, ReportError, ReportEvent};

/// Queue file cap: past it only crashes are still written.
const QUEUE_CAP: u64 = 4 << 20;
/// Events per batch.
const BATCH: usize = 250;
/// The same warning or error is reported at most once in this window.
const REPEAT_MS: i64 = 10 * 60 * 1000;
const LOG_LINES: usize = 300;
const LOG_CHARS: usize = 180_000;

pub struct Reporter {
    dir: PathBuf,
    logs: PathBuf,
    install_id: String,
    session: String,
    version: String,
    home: Option<String>,
    enabled: AtomicBool,
    write: Mutex<()>,
    recent: Mutex<HashMap<String, i64>>,
}

static REPORTER: OnceLock<Arc<Reporter>> = OnceLock::new();

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

impl Reporter {
    /// Secrets out, the home folder (and the user name in it) as `~`.
    pub fn clean(&self, text: &str) -> String {
        let mut out = redact(text).into_owned();
        if let Some(home) = &self.home {
            out = out.replace(home.as_str(), "~");
            if cfg!(windows) {
                out = out.replace(&home.replace('\\', "/"), "~");
            }
        }
        out
    }

    fn clean_value(&self, value: Value) -> Value {
        match value {
            Value::String(s) => Value::String(truncate(&self.clean(&s), 8_000)),
            Value::Array(items) => Value::Array(items.into_iter().take(200).map(|v| self.clean_value(v)).collect()),
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .take(200)
                    .map(|(k, v)| (truncate(&k, 200), self.clean_value(v)))
                    .collect(),
            ),
            other => other,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Turns reports on or off; off deletes everything not sent yet.
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        let off = self.dir.join("off");
        if enabled {
            let _ = fs::remove_file(off);
        } else {
            let _ = fs::write(off, "off\n");
            let _guard = self.write.lock();
            let _ = fs::remove_file(self.dir.join("queue.jsonl"));
            let _ = fs::remove_file(self.dir.join("sending.jsonl"));
        }
    }

    /// Queues one event. Repeats of the same warning or error within ten minutes are dropped.
    pub fn record(&self, kind: &str, name: &str, message: &str, data: Value) {
        if !self.enabled() {
            return;
        }
        let at = now_ms();
        if matches!(kind, "error" | "warning") {
            let key = format!("{kind}|{name}|{}", truncate(message, 200));
            if let Ok(mut recent) = self.recent.lock() {
                if recent.get(&key).is_some_and(|last| at - last < REPEAT_MS) {
                    return;
                }
                if recent.len() > 2_000 {
                    recent.clear();
                }
                recent.insert(key, at);
            }
        }
        let event = ReportEvent {
            at,
            kind: kind.to_owned(),
            name: truncate(&self.clean(name), 190),
            message: truncate(&self.clean(message), 7_500),
            data: self.clean_value(data),
        };
        let Ok(line) = serde_json::to_string(&event) else {
            return;
        };
        let Ok(_guard) = self.write.lock() else { return };
        let path = self.dir.join("queue.jsonl");
        if kind != "crash" && fs::metadata(&path).is_ok_and(|m| m.len() > QUEUE_CAP) {
            return;
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(file, "{line}");
            let _ = file.sync_data();
        }
    }

    /// The previous run ended without a clean exit when its marker is still there.
    fn check_previous_run(&self) {
        let marker = self.dir.join("running");
        if let Ok(previous) = fs::read_to_string(&marker) {
            let mut parts = previous.lines();
            let session = parts.next().unwrap_or_default().to_owned();
            let version = parts.next().unwrap_or_default().to_owned();
            self.record(
                "crash",
                "unclean_exit",
                "The previous run ended without quitting (a crash, a force quit or the computer turning off).",
                json!({"previous_session": session, "previous_version": version}),
            );
        }
        let _ = fs::write(&marker, format!("{}\n{}\n", self.session, self.version));
    }

    /// The app quit normally.
    pub fn clean_exit(&self) {
        let _ = fs::remove_file(self.dir.join("running"));
    }

    fn log_tail(&self) -> String {
        let lines = crate::diagnostics_commands::log_tail(&self.logs, LOG_LINES);
        let text = self.clean(&lines.join("\n"));
        if text.len() <= LOG_CHARS {
            return text;
        }
        let mut start = text.len() - LOG_CHARS;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text[start..].to_owned()
    }

    /// Sends what is queued. Returns false when the server could not be reached (try again later).
    fn flush(&self, server: &str, os_version: &str) -> bool {
        let sending = self.dir.join("sending.jsonl");
        {
            let Ok(_guard) = self.write.lock() else { return false };
            let queue = self.dir.join("queue.jsonl");
            if !sending.exists() && queue.exists() && fs::rename(&queue, &sending).is_err() {
                return false;
            }
        }
        let Ok(file) = File::open(&sending) else { return true };
        let events: Vec<ReportEvent> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str(&line).ok())
            .collect();
        let mut sent = 0;
        for chunk in events.chunks(BATCH) {
            if !self.enabled() {
                break;
            }
            let serious = chunk.iter().any(|e| matches!(e.kind.as_str(), "crash" | "error"));
            let batch = ReportBatch {
                install_id: self.install_id.clone(),
                session: self.session.clone(),
                app_version: self.version.clone(),
                build: if cfg!(debug_assertions) { "debug" } else { "release" }.into(),
                os: std::env::consts::OS.into(),
                os_version: os_version.to_owned(),
                arch: std::env::consts::ARCH.into(),
                locale: String::new(),
                log_tail: if serious { self.log_tail() } else { String::new() },
                events: chunk.to_vec(),
            };
            match tauri::async_runtime::block_on(tessera_sync::reports::send(server, &batch)) {
                Ok(()) | Err(ReportError::Refused(_)) => sent += chunk.len(),
                Err(ReportError::Retry(_)) => break,
            }
        }
        if sent >= events.len() {
            let _ = fs::remove_file(&sending);
            return true;
        }
        // Keep what is left for the next round.
        let rest: Vec<String> = events[sent..]
            .iter()
            .filter_map(|e| serde_json::to_string(e).ok())
            .collect();
        let _ = fs::write(&sending, rest.join("\n") + "\n");
        false
    }
}

/// The reporter, once [`init`] ran.
pub fn reporter() -> Option<&'static Arc<Reporter>> {
    REPORTER.get()
}

/// Queues an event when reports are on (no-op before [`init`]).
pub fn record(kind: &str, name: &str, message: &str, data: Value) {
    if let Some(reporter) = reporter() {
        reporter.record(kind, name, message, data);
    }
}

/// Starts the reporter: install id, the unclean-exit check and the panic hook. Call before logging starts.
pub fn init(root: &Path, logs: &Path, version: &str, home: Option<PathBuf>) -> Arc<Reporter> {
    let dir = root.join("reports");
    let _ = fs::create_dir_all(&dir);
    let id_file = dir.join("install-id");
    let install_id = fs::read_to_string(&id_file)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| s.len() >= 8 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .unwrap_or_else(|| {
            let id = tessera_store::repositories::new_id();
            let _ = fs::write(&id_file, &id);
            id
        });
    let reporter = Arc::new(Reporter {
        enabled: AtomicBool::new(!dir.join("off").exists()),
        dir,
        logs: logs.to_path_buf(),
        install_id,
        session: tessera_store::repositories::new_id(),
        version: version.to_owned(),
        home: home
            .map(|h| h.to_string_lossy().trim_end_matches(['/', '\\']).to_owned())
            .filter(|h| h.len() > 1),
        write: Mutex::new(()),
        recent: Mutex::new(HashMap::new()),
    });
    let _ = REPORTER.set(reporter.clone());
    reporter.check_previous_run();
    install_panic_hook();
    reporter
}

/// Writes a crash event (with a backtrace) before the previous panic hook runs.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let thread = std::thread::current().name().unwrap_or("unnamed").to_owned();
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        record(
            "crash",
            "panic",
            &message,
            json!({"location": location, "thread": thread, "backtrace": truncate(&backtrace, 24_000)}),
        );
        previous(info);
    }));
}

fn server() -> Option<String> {
    let custom = std::env::var("TESSERA_REPORTS_URL").ok().filter(|u| !u.is_empty());
    // Debug builds send only to a server named for the test; release builds to the sync Worker.
    if cfg!(debug_assertions) {
        return custom;
    }
    Some(custom.unwrap_or_else(|| crate::sync_commands::DEFAULT_SERVER.to_owned()))
}

/// The operating system version, for the reports (`15.1`, `10.0.22631.4317`).
fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        let plist = fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").unwrap_or_default();
        if let Some(rest) = plist.split("<key>ProductVersion</key>").nth(1)
            && let Some(value) = rest.split("<string>").nth(1).and_then(|v| v.split("</string>").next())
        {
            return value.trim().to_owned();
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(out) = std::process::Command::new("cmd")
            .args(["/c", "ver"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(version) = text.split("Version ").nth(1) {
                return version.trim().trim_end_matches(']').to_owned();
            }
        }
    }
    String::new()
}

/// Sends queued events every minute (the first time after 15 seconds).
pub fn start_sender() {
    let Some(reporter) = reporter().cloned() else { return };
    let Some(server) = server() else { return };
    let started = std::thread::Builder::new()
        .name("tessera-reports".into())
        .spawn(move || {
            let version = os_version();
            reporter.record(
                "event",
                "app_started",
                "",
                json!({"os_version": version, "arch": std::env::consts::ARCH}),
            );
            std::thread::sleep(Duration::from_secs(15));
            loop {
                if reporter.enabled() {
                    reporter.flush(&server, &version);
                }
                std::thread::sleep(Duration::from_secs(60));
            }
        });
    if let Err(error) = started {
        tracing::debug!(%error, "could not start the report sender");
    }
}

/// An event from the window.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct ReportInput {
    /// `error`, `warning`, `event` or `usage` (crashes come from the app itself).
    pub kind: String,
    pub name: String,
    pub message: String,
    /// JSON text: details, the app actions just before an error, usage counts.
    pub data: String,
}

/// Queues events the window reports.
#[tauri::command]
#[specta::specta]
pub fn reports_record(events: Vec<ReportInput>) {
    let Some(reporter) = reporter() else { return };
    for event in events.into_iter().take(100) {
        let kind = match event.kind.as_str() {
            "error" | "warning" | "event" | "usage" => event.kind.as_str(),
            _ => "event",
        };
        let data = serde_json::from_str(&event.data).unwrap_or_else(|_| Value::String(event.data.clone()));
        reporter.record(kind, &format!("ui.{}", event.name), &event.message, data);
    }
}

/// The tracing layer that turns logged warnings and errors into report events.
pub struct ReportLayer;

#[derive(Default)]
struct Fields {
    message: String,
    rest: serde_json::Map<String, Value>,
}

impl tracing::field::Visit for Fields {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let text = format!("{value:?}");
        if field.name() == "message" {
            self.message = text;
        } else {
            self.rest.insert(field.name().to_owned(), Value::String(text));
        }
    }
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_owned();
        } else {
            self.rest
                .insert(field.name().to_owned(), Value::String(value.to_owned()));
        }
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for ReportLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        let level = *event.metadata().level();
        let kind = if level == tracing::Level::ERROR {
            "error"
        } else if level == tracing::Level::WARN {
            "warning"
        } else {
            return;
        };
        let target = event.metadata().target();
        // The panic hook already reports panics as crashes.
        let mut fields = Fields::default();
        event.record(&mut fields);
        if fields.rest.contains_key("panic") {
            return;
        }
        if let Some(file) = event.metadata().file() {
            fields.rest.insert(
                "source".into(),
                Value::String(format!("{file}:{}", event.metadata().line().unwrap_or(0))),
            );
        }
        record(kind, target, &fields.message, Value::Object(fields.rest));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reporter(dir: &Path) -> Reporter {
        Reporter {
            dir: dir.to_path_buf(),
            logs: dir.join("logs"),
            install_id: "install-1234".into(),
            session: "s1".into(),
            version: "0.1.20".into(),
            home: Some("/Users/alice".into()),
            enabled: AtomicBool::new(true),
            write: Mutex::new(()),
            recent: Mutex::new(HashMap::new()),
        }
    }

    fn queued(dir: &Path) -> Vec<ReportEvent> {
        fs::read_to_string(dir.join("queue.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn events_are_redacted_deduplicated_and_dropped_when_off() {
        let tmp = tempfile::tempdir().unwrap();
        let r = reporter(tmp.path());
        r.record(
            "error",
            "pty",
            "spawn failed in /Users/alice/code with token ghp_abcdefghijklmnopqrstuvwxyz0123456789", // scan:allow (fake token)
            json!({"cwd": "/Users/alice/code"}),
        );
        r.record(
            "error",
            "pty",
            "spawn failed in /Users/alice/code with token ghp_abcdefghijklmnopqrstuvwxyz0123456789", // scan:allow (fake token)
            json!({}),
        );
        r.record("crash", "panic", "boom", json!({}));
        let events = queued(tmp.path());
        assert_eq!(events.len(), 2, "the repeat is dropped");
        let text = serde_json::to_string(&events).unwrap();
        assert!(!text.contains("alice"), "{text}");
        assert!(!text.contains("ghp_abcdef"), "{text}");
        assert!(text.contains("~/code"));
        r.set_enabled(false);
        assert!(
            !tmp.path().join("queue.jsonl").exists(),
            "turning reports off deletes the queue"
        );
        r.record("crash", "panic", "after", json!({}));
        assert!(queued(tmp.path()).is_empty());
        r.set_enabled(true);
        assert!(!tmp.path().join("off").exists());
    }

    #[test]
    fn an_unclean_exit_is_reported_once_and_a_clean_one_is_not() {
        let tmp = tempfile::tempdir().unwrap();
        let r = reporter(tmp.path());
        r.check_previous_run();
        assert!(queued(tmp.path()).is_empty());
        // The app was killed: the marker stayed.
        r.check_previous_run();
        let events = queued(tmp.path());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].name, "unclean_exit");
        r.clean_exit();
        fs::remove_file(tmp.path().join("queue.jsonl")).unwrap();
        r.check_previous_run();
        assert!(queued(tmp.path()).is_empty());
    }
}
