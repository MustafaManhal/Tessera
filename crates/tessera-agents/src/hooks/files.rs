use super::*;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
const LIMIT: u64 = 4 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Copy)]
pub enum WriteFailure {
    None,
    BeforeRename,
}
pub struct HookFiles {
    pub path: PathBuf,
    pub kind: Kind,
    pub cli: String,
}
fn suffix(path: &Path, extra: &str) -> PathBuf {
    let mut p = path.as_os_str().to_os_string();
    p.push(extra);
    p.into()
}
fn read(path: &Path) -> Result<Option<String>, HookError> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(m) => {
            if m.file_type().is_symlink() || !m.is_file() {
                return Err(HookError::Conflict(format!("a non-regular file at {}", path.display())));
            }
        }
    }
    let mut text = String::new();
    fs::File::open(path)?
        .take(LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(|e| HookError::Unparseable {
            line: 1,
            message: e.to_string(),
        })?;
    if text.len() as u64 > LIMIT {
        return Err(HookError::Unparseable {
            line: 1,
            message: "The file exceeds 4 MiB".into(),
        });
    }
    Ok(Some(text))
}
struct EditLock {
    file: Option<fs::File>,
    path: PathBuf,
}
impl Drop for EditLock {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.path);
    }
}
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn temporary(path: &Path, text: &str) -> Result<Temp, HookError> {
    let temp_path = suffix(
        path,
        &format!(
            ".tessera.tmp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
    );
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp_path)?;
    let written = file.write_all(text.as_bytes()).and_then(|_| file.sync_all());
    drop(file);
    let temp = Temp(temp_path);
    written?;
    Ok(temp)
}
fn atomic(path: &Path, text: &str) -> Result<(), HookError> {
    let temp = temporary(path, text)?;
    fs::rename(&temp.0, path)?;
    sync_parent(path);
    Ok(())
}
fn sync_parent(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent()
        && let Ok(file) = fs::File::open(parent)
    {
        let _ = file.sync_all();
    }
    let _ = path;
}
impl HookFiles {
    fn journal(&self) -> PathBuf {
        suffix(&self.path, ".tessera-state.json")
    }
    fn ownership(&self) -> Result<Ownership, HookError> {
        match read(&self.journal())? {
            None => Ok(Ownership::default()),
            Some(text) => serde_json::from_str(&text)
                .map_err(|_| HookError::Conflict("an invalid Tessera ownership record".into())),
        }
    }
    pub fn preview(&self, action: Action) -> Result<Plan, HookError> {
        let original = read(&self.path)?;
        let mut ownership = self.ownership()?;
        if original.is_none() {
            ownership.created_file = true;
        }
        if matches!(action, Action::Remove) && original.is_none() {
            return Ok(Plan {
                state: State::None,
                after: String::new(),
                diff: String::new(),
                ownership,
            });
        }
        let text = original.as_deref().unwrap_or("");
        let base = if self.kind != Kind::Codex && (original.is_none() || (ownership.created_file && text.is_empty())) {
            "{}"
        } else {
            text
        };
        let mut result = plan(self.kind, base, &self.cli, action, &ownership)?;
        result.diff = unified_diff(text, &result.after);
        Ok(result)
    }
    pub fn state(&self) -> State {
        let result = (|| {
            let original = read(&self.path)?;
            let ownership = self.ownership()?;
            let Some(text) = original else {
                return Ok(State::None);
            };
            if ownership.created_file && text.is_empty() {
                return Ok(State::None);
            }
            inspect(self.kind, &text, &self.cli)
        })();
        match result {
            Ok(state) => state,
            Err(HookError::Conflict(_)) => State::Conflict,
            Err(_) => State::Unparseable,
        }
    }
    pub fn apply(&self, action: Action) -> Result<Plan, HookError> {
        self.apply_with_failure(action, WriteFailure::None)
    }
    pub fn apply_with_failure(&self, action: Action, failure: WriteFailure) -> Result<Plan, HookError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| HookError::Io("The configuration has no parent folder".into()))?;
        if matches!(action, Action::Install) {
            fs::create_dir_all(parent)?;
        } else if !parent.exists() {
            return self.preview(action);
        }
        let lock_path = suffix(&self.path, ".tessera.lock");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Do not steal an existing lock. Only the process that created it may release it.
        let lock_file = options
            .open(&lock_path)
            .map_err(|e| HookError::Conflict(format!("an active hook-edit lock ({e})")))?;
        let lock = EditLock {
            file: Some(lock_file),
            path: lock_path,
        };
        let original = read(&self.path)?;
        let result = self.preview(action)?;
        if result.after == original.as_deref().unwrap_or("") {
            return Ok(result);
        }
        if fs::metadata(&self.path).is_ok_and(|m| m.permissions().readonly()) {
            return Err(HookError::Io("The configuration is read-only".into()));
        }
        let backup = suffix(&self.path, ".tessera.bak");
        let previous = suffix(&self.path, ".tessera.bak.1");
        if read(&backup)?.is_some() {
            if read(&previous)?.is_some() {
                fs::remove_file(&previous)?;
            }
            fs::rename(&backup, &previous)?;
        }
        atomic(&backup, original.as_deref().unwrap_or(""))?;
        let temp = temporary(&self.path, &result.after)?;
        if let Ok(metadata) = fs::metadata(&self.path) {
            fs::set_permissions(&temp.0, metadata.permissions())?;
        }
        if read(&self.path)? != original {
            return Err(HookError::Changed);
        }
        if matches!(failure, WriteFailure::BeforeRename) {
            return Err(HookError::Io("Simulated failure before rename".into()));
        }
        fs::rename(&temp.0, &self.path)?;
        sync_parent(&self.path);
        let ownership = if matches!(action, Action::Remove) {
            Ownership {
                created_file: result.ownership.created_file,
                ..Default::default()
            }
        } else {
            result.ownership.clone()
        };
        atomic(
            &self.journal(),
            &serde_json::to_string(&ownership).expect("ownership record"),
        )?;
        drop(lock);
        Ok(result)
    }
}
