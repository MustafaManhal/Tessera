//! Versioned, age-limited login environment cache and nonblocking refresh.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_CACHE: u64 = 4 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct LoginEnvironment {
    current: Mutex<BTreeMap<String, String>>,
    started: std::sync::atomic::AtomicBool,
}
impl LoginEnvironment {
    pub(crate) fn snapshot(&self) -> BTreeMap<String, String> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
    /// Read the small local cache once, then run all shell commands outside the caller and state lock.
    pub(crate) fn start(self: &Arc<Self>, path: Option<PathBuf>, shell: String) {
        self.start_with(
            path,
            shell,
            crate::shell::login_environment,
            crate::shell::path_helper_environment,
        );
    }
    pub(crate) fn start_with(
        self: &Arc<Self>,
        path: Option<PathBuf>,
        shell: String,
        probe: impl FnOnce(&str) -> BTreeMap<String, String> + Send + 'static,
        fallback: impl FnOnce() -> BTreeMap<String, String> + Send + 'static,
    ) -> bool {
        use std::sync::atomic::Ordering;
        if self.started.swap(true, Ordering::AcqRel) {
            return false;
        }
        let mut cache_hit = false;
        if let Some(path) = &path
            && let Ok(metadata) = std::fs::metadata(path)
            && metadata.len() <= MAX_CACHE
            && let Ok(text) = std::fs::read_to_string(path)
            && let Some(cached) = decode(Some(&text), &shell, now_seconds())
        {
            *self.current.lock().unwrap_or_else(PoisonError::into_inner) = cached;
            cache_hit = true;
        }
        if self.snapshot().is_empty() {
            let fallback = fallback();
            *self.current.lock().unwrap_or_else(PoisonError::into_inner) = fallback;
        }
        let shared = Arc::clone(self);
        if let Err(error) = std::thread::Builder::new()
            .name("tessera-login-environment".into())
            .spawn(move || {
                // The potentially slow login shell never holds the snapshot mutex.
                let fresh = probe(&shell);
                if fresh.is_empty() {
                    return;
                } // A failed probe must not replace a valid cache.
                *shared.current.lock().unwrap_or_else(PoisonError::into_inner) = fresh.clone();
                if let Some(path) = path
                    && let Err(error) = write_cache(&path, &encode(&fresh, &shell, now_seconds()))
                {
                    tracing::warn!(%error, "could not update login environment cache");
                }
            })
        {
            tracing::warn!(%error, "could not start login environment refresh");
        }
        cache_hit
    }
}
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn hex(text: &str) -> String {
    text.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect()
}
fn unhex(text: &str) -> Option<String> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    let bytes: Option<Vec<u8>> = text
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| Some((char::from(pair[0]).to_digit(16)? * 16 + char::from(pair[1]).to_digit(16)?) as u8))
        .collect();
    String::from_utf8(bytes?).ok()
}
fn encode(env: &BTreeMap<String, String>, shell: &str, timestamp: u64) -> String {
    let mut text = format!("TESSERA-LOGIN-ENV-1\n{timestamp}\n{}\n", hex(shell));
    for (key, value) in env {
        text.push_str(&format!("{}:{}\n", hex(key), hex(value)));
    }
    text
}
/// Pure validity check: future-dated, expired, wrong-shell and malformed entries are all cache misses.
fn decode(text: Option<&str>, shell: &str, now: u64) -> Option<BTreeMap<String, String>> {
    let mut lines = text?.lines();
    if lines.next()? != "TESSERA-LOGIN-ENV-1" {
        return None;
    }
    let saved: u64 = lines.next()?.parse().ok()?;
    if now.checked_sub(saved)? > MAX_AGE.as_secs() || unhex(lines.next()?)? != shell {
        return None;
    }
    let mut env = BTreeMap::new();
    for line in lines {
        let (key, value) = line.split_once(':')?;
        let key = unhex(key)?;
        let value = unhex(value)?;
        if key.is_empty()
            || key.chars().any(|c| c == '=' || c.is_whitespace() || c.is_control())
            || value.contains('\0')
        {
            return None;
        }
        env.insert(key, value);
    }
    if env.is_empty() { None } else { Some(env) }
}
fn write_cache(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("{}.tmp", crate::SessionId::new()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_stale_missing_and_corrupt_cache_are_distinct_from_valid_values() {
        let env = BTreeMap::from([
            ("PATH".into(), "/bin:/a b".into()),
            ("MULTILINE".into(), "a\nb=é".into()),
        ]);
        let text = encode(&env, "/bin/zsh", 100);
        assert_eq!(decode(Some(&text), "/bin/zsh", 101), Some(env.clone()));
        assert_eq!(decode(Some(&text), "/bin/zsh", 100 + MAX_AGE.as_secs()), Some(env));
        assert!(decode(Some(&text), "/bin/zsh", 101 + MAX_AGE.as_secs()).is_none());
        assert!(decode(Some(&text), "/bin/zsh", 99).is_none());
        assert!(decode(Some(&text), "/bin/bash", 101).is_none());
        assert!(decode(None, "/bin/zsh", 101).is_none());
        assert!(decode(Some("corrupt"), "/bin/zsh", 101).is_none());
        assert!(decode(Some(&(text + "xx:00\n")), "/bin/zsh", 101).is_none());
    }
    #[test]
    fn cache_file_replacement_round_trips_and_is_private() {
        let dir = tempfile::tempdir().expect("fixture");
        let path = dir.path().join("login.cache");
        write_cache(&path, "old").expect("write");
        write_cache(&path, "new").expect("replace");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "new");
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).expect("stat").permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn blocked_probe_never_holds_the_snapshot_or_spawn_path() {
        use std::sync::mpsc;
        let env = Arc::new(LoginEnvironment::default());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        env.start_with(
            None,
            "fake".into(),
            move |_| {
                entered_tx.send(()).expect("entered");
                release_rx.recv().expect("release");
                BTreeMap::from([("FRESH".into(), "yes".into())])
            },
            BTreeMap::new,
        );
        let timeout = Duration::from_secs(if cfg!(windows) { 3 } else { 1 });
        entered_rx.recv_timeout(timeout).expect("probe started");
        let host = crate::PtyHost::new();
        // Install the blocked provider before spawning a real child.
        host.set_login_environment_for_test(Arc::clone(&env));
        let (tx, rx) = mpsc::channel();
        let spec = crate::SpawnSpec {
            program: Some(if cfg!(windows) { "cmd" } else { "/bin/sh" }.into()),
            args: if cfg!(windows) {
                vec!["/c".into(), "echo READY".into()]
            } else {
                vec!["-c".into(), "printf READY".into()]
            },
            ..crate::SpawnSpec::new(std::env::current_dir().expect("cwd"))
        };
        let spawn_host = host.clone();
        std::thread::spawn(move || {
            let result = spawn_host.spawn_with_sink(
                spec,
                Some(Arc::new(move |event| {
                    let _ = tx.send(event);
                })),
            );
            assert!(result.is_ok());
        });
        let result = rx.recv_timeout(timeout);
        release_tx.send(()).expect("release probe");
        assert!(
            matches!(result, Ok(crate::PtyEvent::Data(_))),
            "spawn blocked on probe: {result:?}"
        );
    }
}
