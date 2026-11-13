//! Debounced worktree notifications with deterministic shutdown.
use crate::{GitError, run};
use notify::{RecursiveMode, Watcher};
use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::Duration,
};
/// Owns the watcher and debounce thread; dropping stops and joins the thread.
pub struct WorktreeWatcher {
    stop: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
    _watcher: notify::RecommendedWatcher,
}
/// Whether a path is relevant to the worktree display.
pub fn relevant_path(path: &Path) -> bool {
    let parts: Vec<_> = path.components().map(|c| c.as_os_str()).collect();
    if parts.iter().any(|p| *p == "node_modules" || *p == "target") {
        return false;
    }
    if let Some(i) = parts.iter().position(|p| *p == ".git") {
        return parts.len() == i + 2 && (parts[i + 1] == "HEAD" || parts[i + 1] == "index");
    }
    true
}
impl WorktreeWatcher {
    /// Watch worktree files and linked-worktree HEAD/index; invoke after 300 ms quiet.
    pub fn new(path: &Path, callback: impl Fn() + Send + 'static) -> Result<Self, GitError> {
        let (tx, rx) = mpsc::channel();
        let (stop, stopped) = mpsc::channel();
        let git_dir = PathBuf::from(
            String::from_utf8_lossy(&run(path, ["rev-parse", "--absolute-git-dir"])?)
                .trim_end()
                .to_owned(),
        );
        let metadata = git_dir.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| match event {
                Ok(e)
                    if !matches!(e.kind, notify::EventKind::Access(_))
                        && e.paths.iter().any(|p| {
                            if p.starts_with(&metadata) {
                                p == &metadata.join("HEAD") || p == &metadata.join("index")
                            } else {
                                relevant_path(p)
                            }
                        }) =>
                {
                    let _ = tx.send(());
                }
                Err(e) => tracing::warn!(error=%e,"git watcher error"),
                _ => {}
            })?;
        watcher.watch(path, RecursiveMode::Recursive)?;
        if !git_dir.starts_with(path) {
            watcher.watch(&git_dir, RecursiveMode::NonRecursive)?;
        }
        let thread = thread::spawn(move || {
            let mut pending = false;
            loop {
                if stopped.try_recv().is_ok() {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(if pending { 300 } else { 50 })) {
                    Ok(()) => pending = true,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if pending {
                            pending = false;
                            callback();
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        Ok(Self {
            stop,
            thread: Some(thread),
            _watcher: watcher,
        })
    }
}
impl Drop for WorktreeWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
