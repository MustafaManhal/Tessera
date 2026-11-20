//! Opt-in startup experiments. Ordinary launches retain the supported startup sequence.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// Controls experiments only when the isolated benchmark harness is active.
#[derive(Default)]
pub struct Experiments {
    /// Force the hidden startup path in an isolated benchmark.
    pub hidden: bool,
    /// Override the normal hidden-window config for a visible-window control run.
    pub force_visible: bool,
    revealed: AtomicBool,
    /// Defer optional native plugins in a benchmark experiment only.
    pub deferred: bool,
    plugins_started: AtomicBool,
}
impl Experiments {
    /// Reads the isolated harness switches; setting a switch alone never changes a normal launch.
    pub fn from_environment() -> Self {
        Self::parse(
            std::env::var_os("TESSERA_BENCH_ROOT").is_some(),
            std::env::var("TESSERA_STARTUP_WINDOW").ok().as_deref(),
            std::env::var("TESSERA_STARTUP_PLUGINS").ok().as_deref(),
        )
    }
    fn parse(benchmark: bool, window: Option<&str>, plugins: Option<&str>) -> Self {
        Self {
            hidden: benchmark && window == Some("hidden"),
            force_visible: benchmark && window == Some("visible"),
            revealed: AtomicBool::new(false),
            deferred: benchmark && plugins == Some("deferred"),
            plugins_started: AtomicBool::new(false),
        }
    }
    /// Reveals the main window once the document is ready, including ordinary launches.
    pub fn reveal(&self, app: &tauri::AppHandle) {
        if self.revealed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(window) = app.get_webview_window("main")
            && !window.is_visible().unwrap_or(true)
        {
            match window.show() {
                Ok(()) => app
                    .state::<std::sync::Arc<crate::benchmark::Benchmark>>()
                    .record("window_shown"),
                Err(error) => {
                    self.revealed.store(false, Ordering::Release);
                    tracing::error!(%error,"could not reveal main window");
                }
            }
        }
    }

    /// Installs deferred plugins once at DOM readiness, before ordinary user actions need them.
    pub fn dom_ready(&self, app: &tauri::AppHandle) {
        if !self.deferred || self.plugins_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let bench = app.state::<std::sync::Arc<crate::benchmark::Benchmark>>();
        bench.record("deferred_plugins_begin");
        for result in [
            app.plugin(tauri_plugin_opener::init()),
            app.plugin(tauri_plugin_notification::init()),
            app.plugin(tauri_plugin_dialog::init()),
        ] {
            if let Err(error) = result {
                tracing::error!(%error,"startup experiment plugin initialization failed");
            }
        }
        bench.record("deferred_plugins_ready");
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switches_require_the_isolated_harness_and_exact_values() {
        let ordinary = Experiments::parse(false, Some("hidden"), Some("deferred"));
        assert!(!ordinary.hidden && !ordinary.deferred);
        let active = Experiments::parse(true, Some("hidden"), Some("deferred"));
        assert!(active.hidden && active.deferred);
        assert!(!ordinary.force_visible);
        assert!(Experiments::parse(true, Some("visible"), None).force_visible);
        let unknown = Experiments::parse(true, Some("false"), Some("skip"));
        assert!(!unknown.hidden && !unknown.deferred);
    }
}
