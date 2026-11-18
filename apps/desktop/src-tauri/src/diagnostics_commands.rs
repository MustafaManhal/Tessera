//! Diagnostics and privacy (M12.4, FR-74, NFR-08): a copyable error report (never uploaded) and the local switch for
//! optional anonymous usage statistics, which is off by default and, in this version, only a stored preference:
//! nothing is collected or sent whatever its value.
use crate::{error::AppError, project_commands::with_store, state::AppState};
use serde::Serialize;
use specta::Type;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use tauri::Manager;
use tessera_store::redact::redact;

const LOG_LINES: usize = 200;
/// Enough bytes from the end of the log for 200 lines of normal length.
const LOG_TAIL_BYTES: u64 = 256 * 1024;

/// The last `lines` lines of the newest `*.log` file in `dir`, or an empty list.
pub fn log_tail(dir: &Path, lines: usize) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let Some(newest) = read
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "log"))
        .max()
    else {
        return Vec::new();
    };
    let Ok(mut file) = File::open(&newest) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.take(LOG_TAIL_BYTES).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut all: Vec<&str> = text.lines().collect();
    // The first line may be cut by the tail start.
    if start > 0 && !all.is_empty() {
        all.remove(0);
    }
    let from = all.len().saturating_sub(lines);
    all[from..].iter().map(|l| (*l).to_owned()).collect()
}

/// Builds the report text from its parts. Everything is redacted once more here, so logs written before the
/// redactor existed cannot leak through a report.
pub fn build_report(version: &str, build: &str, schema: u32, title: &str, message: &str, log: &[String]) -> String {
    let mut out = String::new();
    out.push_str("Tessera error report\n");
    out.push_str(&format!("Version: {version} ({build})\n"));
    out.push_str(&format!(
        "System: {} {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    out.push_str(&format!("Schema: {schema}\n"));
    if !title.trim().is_empty() {
        out.push_str(&format!("\nError: {}\n", title.trim()));
    }
    if !message.trim().is_empty() {
        out.push_str(&format!("Details: {}\n", message.trim()));
    }
    out.push_str(&format!("\n--- last {} log lines ---\n", log.len()));
    for line in log {
        out.push_str(line);
        out.push('\n');
    }
    redact(&out).into_owned()
}

/// The text the "Copy error report" buttons put on the clipboard.
#[tauri::command]
#[specta::specta]
pub async fn diagnostics_report(app: tauri::AppHandle, title: String, message: String) -> Result<String, AppError> {
    let version = app.package_info().version.to_string();
    let logs = app.state::<AppState>().dirs.logs.clone();
    let schema = with_store(app, |store| Ok(store.schema_version().unwrap_or(0))).await?;
    let build = if cfg!(debug_assertions) { "debug" } else { "release" };
    tauri::async_runtime::spawn_blocking(move || {
        let tail = log_tail(&logs, LOG_LINES);
        build_report(&version, build, schema, &title, &message, &tail)
    })
    .await
    .map_err(|e| AppError::new("diagnostics.failed", e.to_string()))
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct PrivacySettings {
    /// Off unless the user turned it on. Nothing is sent in this version either way.
    pub usage_stats: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn privacy_settings(app: tauri::AppHandle) -> Result<PrivacySettings, AppError> {
    with_store(app, |store| {
        Ok(PrivacySettings {
            usage_stats: store.kv_get("privacy.usage_stats")?.as_deref() == Some("on"),
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn privacy_set_usage_stats(app: tauri::AppHandle, enabled: bool) -> Result<PrivacySettings, AppError> {
    with_store(app, move |store| {
        store.kv_set("privacy.usage_stats", if enabled { "on" } else { "off" })?;
        Ok(PrivacySettings { usage_stats: enabled })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_has_the_facts_and_no_secrets() {
        let log = vec![
            "INFO started".to_owned(),
            "WARN github said ghp_0123456789abcdefghijABCDEFGHIJ012345".to_owned(), // scan:allow
        ];
        let text = build_report(
            "0.1.0",
            "release",
            15,
            "Push failed",
            "https://me:pw@github.com/o/r token=abc12345",
            &log,
        );
        assert!(text.starts_with("Tessera error report\nVersion: 0.1.0 (release)\n"));
        assert!(text.contains("Error: Push failed"));
        assert!(text.contains("--- last 2 log lines ---"));
        assert!(text.contains("INFO started"));
        for secret in ["ghp_0123", "me:pw@", "abc12345"] {
            // scan:allow
            assert!(!text.contains(secret), "{secret} leaked:\n{text}");
        }
    }

    #[test]
    fn log_tail_reads_the_newest_file_and_only_the_last_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tessera.2026-11-10.log"), "old\n").unwrap();
        let body: String = (1..=500).map(|n| format!("line {n}\n")).collect();
        std::fs::write(dir.path().join("tessera.2026-11-12.log"), body).unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not a log\n").unwrap();
        let tail = log_tail(dir.path(), 3);
        assert_eq!(tail, ["line 498", "line 499", "line 500"]);
        assert!(log_tail(&dir.path().join("missing"), 3).is_empty());
    }
}
