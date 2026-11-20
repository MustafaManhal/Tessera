//! Last-good configuration state and a directory watcher for editor atomic saves.

use crate::{
    Config, ConfigError,
    config::{ConfigDiagnostic, parse_config_with_warnings, read_config},
};
use notify::{EventKind, RecursiveMode, Watcher};
use std::{
    path::Path,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

/// Pure reload state: invalid edits retain the last usable configuration.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigState {
    /// Last valid configuration, or defaults before the first successful load.
    pub current: Config,
    /// Most recent reload failure; cleared on recovery.
    pub last_error: Option<ConfigDiagnostic>,
    /// Nonfatal unknown-key diagnostics from the last successful load.
    pub warnings: Vec<ConfigDiagnostic>,
}

impl ConfigState {
    /// Applies a file-free reload and retains `current` if parsing fails.
    pub fn reload(&mut self, text: &str) {
        match parse_config_with_warnings(text) {
            Ok(parsed) => {
                self.current = parsed.config;
                self.warnings = parsed.warnings;
                self.last_error = None;
            }
            Err(error) => {
                self.last_error = Some(ConfigDiagnostic::from(&error));
            }
        }
    }

    /// Loads from disk; a missing file resets settings to defaults.
    pub fn reload_path(&mut self, path: &Path) {
        match read_config(path) {
            Ok(text) => self.reload(&text),
            Err(error) => self.last_error = Some(ConfigDiagnostic::from(&error)),
        }
    }
}

enum Message {
    File(notify::Result<notify::Event>),
    Stop,
}

/// Watches the config's parent directory, debouncing relevant events by 200 ms.
/// Dropping the watcher stops and joins its thread; it does not own the app lifetime.
pub struct ConfigWatcher {
    sender: mpsc::Sender<Message>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ConfigWatcher {
    /// Starts watching and loads once after registration to close the startup race.
    /// Callbacks run on the watcher thread while the state lock is held, preserving event order.
    /// They must not acquire that same lock or drop this watcher.
    ///
    /// # Errors
    /// Returns a watch error if registration or thread creation fails.
    pub fn start(
        path: &Path,
        state: Arc<Mutex<ConfigState>>,
        callback: impl Fn(&ConfigState) + Send + 'static,
    ) -> Result<Self, ConfigError> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = parent.canonicalize().map_err(|source| ConfigError::Read {
            path: parent.into(),
            source,
        })?;
        let name = path
            .file_name()
            .ok_or_else(|| ConfigError::Watch(notify::Error::generic("config path has no filename")))?;
        let path = parent.join(name);
        let (sender, receiver) = mpsc::channel();
        let events = sender.clone();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = events.send(Message::File(event));
        })?;
        watcher.watch(&parent, RecursiveMode::NonRecursive)?;
        let thread = thread::Builder::new()
            .name("tessera-config".into())
            .spawn(move || {
                let _watcher = watcher;
                reload(&state, &path, &callback, None);
                loop {
                    let mut error = match receiver.recv() {
                        Ok(Message::Stop) | Err(_) => break,
                        Ok(Message::File(event)) => match relevant(event, &path) {
                            Some(error) => error,
                            None => continue,
                        },
                    };
                    let mut deadline = std::time::Instant::now() + Duration::from_millis(200);
                    loop {
                        match receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
                            Ok(Message::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                            Err(mpsc::RecvTimeoutError::Timeout) => break,
                            Ok(Message::File(event)) => {
                                if let Some(next) = relevant(event, &path) {
                                    if next.is_some() {
                                        error = next;
                                    }
                                    deadline = std::time::Instant::now() + Duration::from_millis(200);
                                }
                            }
                        }
                    }
                    reload(&state, &path, &callback, error);
                }
            })
            .map_err(|error| ConfigError::Watch(notify::Error::generic(&error.to_string())))?;
        Ok(Self {
            sender,
            thread: Some(thread),
        })
    }
}

fn relevant(event: notify::Result<notify::Event>, path: &Path) -> Option<Option<ConfigDiagnostic>> {
    match event {
        Err(error) => Some(Some(ConfigDiagnostic::from(&ConfigError::Watch(error)))),
        Ok(event)
            if !matches!(event.kind, EventKind::Access(_))
                && (event.need_rescan() || event.paths.iter().any(|changed| changed == path)) =>
        {
            Some(None)
        }
        _ => None,
    }
}

fn reload(state: &Mutex<ConfigState>, path: &Path, callback: &impl Fn(&ConfigState), error: Option<ConfigDiagnostic>) {
    let Ok(mut state) = state.lock() else {
        tracing::error!("config state lock poisoned; watcher stopped updating");
        return;
    };
    let before = state.clone();
    if let Some(error) = error {
        state.last_error = Some(error);
    } else {
        state.reload_path(path);
    }
    if *state != before {
        callback(&state);
    }
}

impl Drop for ConfigWatcher {
    fn drop(&mut self) {
        let _ = self.sender.send(Message::Stop);
        if let Some(thread) = self.thread.take()
            && let Err(error) = thread.join()
        {
            tracing::error!(?error, "config watcher thread panicked");
        }
    }
}
