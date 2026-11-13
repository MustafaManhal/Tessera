//! Explicit opt-in benchmark telemetry. Normal launches perform no file writes or automation.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Manager;
use tessera_pty::PtyEvent;

/// One benchmark launch, isolated from both the production and development profiles.
pub struct Benchmark {
    start: Instant,
    root: Option<PathBuf>,
    offset_ms: f64,
    io_lock: Mutex<()>,
}
impl Benchmark {
    /// Captures the process entry time and optional harness directory.
    pub fn new() -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let epoch = std::env::var("TESSERA_BENCH_PROCESS_START_UNIX_MS")
            .ok()
            .and_then(|v| v.parse::<u128>().ok())
            .unwrap_or(now);
        let value = Self {
            start: Instant::now(),
            root: std::env::var_os("TESSERA_BENCH_ROOT").map(PathBuf::from),
            offset_ms: now.saturating_sub(epoch) as f64,
            io_lock: Mutex::new(()),
        };
        value.record("run_entry");
        value
    }
    /// The disposable app data root for an explicitly requested benchmark.
    pub fn data_root(&self) -> Option<PathBuf> {
        self.root.as_ref().map(|root| {
            std::env::var_os("TESSERA_BENCH_DATA_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join("data"))
        })
    }
    /// Records an event to a harness-owned JSONL file, never the normal app log.
    pub fn record(&self, event: &str) {
        let Some(root) = &self.root else {
            return;
        };
        let _guard = self.io_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let result = (|| -> std::io::Result<()> {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(root.join("events.jsonl"))?;
            writeln!(
                file,
                "{}",
                serde_json::json!({"event":event,"ms":self.offset_ms+self.start.elapsed().as_secs_f64()*1000.0,"pid":std::process::id()})
            )
        })();
        if let Err(error) = result {
            tracing::error!(%error, "benchmark telemetry failed");
        }
    }
    /// Collects first-output and complete OSC 133 B prompt marks, including split frames.
    pub fn observer(self: &Arc<Self>) -> Option<OutputObserver> {
        self.root.as_ref()?;
        Some(OutputObserver {
            bench: Arc::clone(self),
            state: Mutex::new(OutputState::default()),
        })
    }
    /// Starts a file-triggered split action for the memory harness. This has no effect without the opt-in env var.
    pub fn start(&self, app: &tauri::AppHandle) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let app = app.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + std::time::Duration::from_secs(120);
            while Instant::now() < deadline && root.exists() {
                // `panes` holds how many panes to open (the 50-pane scale scenario); `four-panes` is the memory scenario.
                let wanted = std::fs::read_to_string(root.join("panes"))
                    .ok()
                    .and_then(|text| text.trim().parse::<u32>().ok())
                    .or_else(|| root.join("four-panes").exists().then_some(4));
                if let Some(wanted) = wanted {
                    if let Some(window) = app.get_webview_window("main") {
                        // Exercise the existing shortcut path and mount real terminal engines and PTYs.
                        let script = r#"(() => {
                            let attempts = 0;
                            const timer = setInterval(() => {
                                const count = document.querySelectorAll('.xterm').length;
                                if (count >= __WANTED__ || ++attempts > 1500) { clearInterval(timer); return; }
                                const mac = navigator.platform.toLowerCase().includes('mac');
                                document.dispatchEvent(new KeyboardEvent('keydown', {key:'d', code:'KeyD', metaKey:mac, ctrlKey:!mac, shiftKey:!mac, bubbles:true, cancelable:true}));
                            },100);
                        })()"#
                        .replace("__WANTED__", &wanted.to_string());
                        if let Err(error) = window.eval(script) {
                            tracing::error!(%error,"benchmark split automation failed");
                        }
                    }
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        });
    }
}
#[derive(Default)]
struct OutputState {
    first: bool,
    prompt: bool,
    tail: Vec<u8>,
}
/// Per-terminal output observer; only allocated in benchmark launches.
pub struct OutputObserver {
    bench: Arc<Benchmark>,
    state: Mutex<OutputState>,
}
impl OutputObserver {
    /// Observes data, recording the first bytes and first completed shell prompt.
    pub fn observe(&self, event: &PtyEvent) {
        let PtyEvent::Data(bytes) = event else {
            return;
        };
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.prompt {
            return;
        }
        if !state.first {
            state.first = true;
            self.bench.record("first_output");
        }
        state.tail.extend_from_slice(bytes);
        if state.tail.windows(8).any(|part| part == b"\x1b]133;B\x07")
            || state.tail.windows(9).any(|part| part == b"\x1b]133;B\x1b\\")
        {
            state.prompt = true;
            self.bench.record("prompt");
            tracing::info!(ms = self.bench.start.elapsed().as_millis(), "terminal ready");
        }
        let excess = state.tail.len().saturating_sub(16);
        state.tail.drain(..excess);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_launch_has_ready_hook_without_frame_telemetry() {
        let ordinary = ready_script(false);
        let timed = ready_script(true);
        assert!(ordinary.contains("benchmark_dom_ready"));
        assert!(!ordinary.contains("benchmark_first_paint"));
        assert!(timed.contains("benchmark_first_paint"));
        assert!(!timed.contains("__FRAME_HOOK__"));
    }
    #[test]
    fn concurrent_phase_writers_produce_complete_json_lines() {
        let dir = tempfile::tempdir().expect("fixture");
        let bench = Arc::new(Benchmark {
            start: Instant::now(),
            root: Some(dir.path().into()),
            offset_ms: 0.0,
            io_lock: Mutex::new(()),
        });
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let bench = Arc::clone(&bench);
                std::thread::spawn(move || {
                    for _ in 0..100 {
                        bench.record("concurrent");
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().expect("worker");
        }
        let text = std::fs::read_to_string(dir.path().join("events.jsonl")).expect("events");
        assert_eq!(text.lines().count(), 400);
        for line in text.lines() {
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(line).expect("valid line")["event"],
                "concurrent"
            );
        }
    }
    #[test]
    fn prompt_requires_a_terminated_mark_and_accepts_split_frames() {
        let dir = tempfile::tempdir().expect("fixture");
        let bench = Arc::new(Benchmark {
            start: Instant::now(),
            root: Some(dir.path().into()),
            offset_ms: 0.0,
            io_lock: Mutex::new(()),
        });
        let observer = bench.observer().expect("enabled");
        observer.observe(&PtyEvent::Data(b"not a prompt B".to_vec()));
        observer.observe(&PtyEvent::Data(b"\x1b]133;B".to_vec()));
        assert!(
            !std::fs::read_to_string(dir.path().join("events.jsonl"))
                .expect("events")
                .contains("\"prompt\"")
        );
        observer.observe(&PtyEvent::Data(b"\x07".to_vec()));
        observer.observe(&PtyEvent::Data(b"\x1b]133;B\x07".to_vec()));
        let events = std::fs::read_to_string(dir.path().join("events.jsonl")).expect("events");
        assert_eq!(events.matches("\"prompt\"").count(), 1);
        assert_eq!(events.matches("first_output").count(), 1);
    }
}

/// Native document-ready hook reveals the initially hidden window without frontend changes.
/// Frame timing is added only for the isolated benchmark harness.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let builder = tauri::plugin::Builder::new("benchmark");
    builder
        .js_init_script(ready_script(std::env::var_os("TESSERA_BENCH_ROOT").is_some()))
        .on_page_load(|webview, payload| {
            if let Some(bench) = webview.try_state::<Arc<Benchmark>>() {
                bench.record(match payload.event() {
                    tauri::webview::PageLoadEvent::Started => "webview_load_begin",
                    tauri::webview::PageLoadEvent::Finished => "webview_load_ready",
                });
            }
        })
        .build()
}

fn ready_script(timing: bool) -> String {
    let frame_hook = if timing {
        "requestAnimationFrame(() => requestAnimationFrame(() => window.__TAURI_INTERNALS__.invoke('benchmark_first_paint').catch(console.error)));"
    } else {
        ""
    };
    r#"if (window === window.top) {
        window.__TESSERA_BENCH__ = __TIMING__;
        document.addEventListener('DOMContentLoaded', () => {
            window.__TAURI_INTERNALS__.invoke('benchmark_dom_ready').catch(console.error);
            __FRAME_HOOK__
        }, {once:true});
    }"#
    .replace("__FRAME_HOOK__", frame_hook)
    .replace("__TIMING__", if timing { "true" } else { "false" })
}

/// Private document-ready endpoint; reveals the main window and optionally records timing.
#[tauri::command]
pub fn benchmark_dom_ready(app: tauri::AppHandle, state: tauri::State<'_, Arc<Benchmark>>) {
    state.record("dom_content_loaded");
    app.state::<crate::startup::Experiments>().dom_ready(&app);
    app.state::<crate::startup::Experiments>().reveal(&app);
}

/// Benchmark-only mark from the page (`window.__TESSERA_BENCH__` is set only when `TESSERA_BENCH_ROOT` is). It lets the
/// cold-start timeline show where the page spends its time before the first shell is requested.
#[tauri::command]
pub fn benchmark_mark(name: String, state: tauri::State<'_, Arc<Benchmark>>) {
    if name.len() <= 40 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        state.record(&format!("js_{name}"));
    }
}

/// Benchmark-only frame scheduling mark (two animation frames after DOM readiness).
#[tauri::command]
pub fn benchmark_first_paint(state: tauri::State<'_, Arc<Benchmark>>) {
    state.record("first_paint");
}
