//! User-level CLI installation. Invoked only by a future consent UI; never during setup.
use crate::{agent_commands::env_value, error::AppError, state::AppState};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
static INSTALL_LOCK: Mutex<()> = Mutex::new(());
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CliInstall {
    pub installed: bool,
    pub path: Option<String>,
    pub target: String,
    pub needs_admin: bool,
    /// Required so the later consent UI can distinguish installation from PATH availability.
    pub on_path: bool,
}
struct Location {
    source: PathBuf,
    bin: PathBuf,
    windows: bool,
    login_path: String,
}
#[derive(Serialize, Deserialize)]
struct Marker {
    target: String,
    digest: u64,
    added_to_path: bool,
}
fn failure(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn io_error(_: std::io::Error) -> AppError {
    failure("cli.install_failed", "The CLI installation files could not be updated.")
}
impl Location {
    fn from_app(app: &tauri::AppHandle) -> Result<Self, AppError> {
        let source = std::env::current_exe()
            .map_err(io_error)?
            .parent()
            .ok_or_else(|| failure("cli.binary_not_found", "The bundled CLI could not be located."))?
            .join(if cfg!(windows) { "tessera.exe" } else { "tessera" });
        let bin = if cfg!(windows) {
            PathBuf::from(
                std::env::var_os("LOCALAPPDATA")
                    .ok_or_else(|| failure("cli.install_failed", "The user application folder is unavailable."))?,
            )
            .join("Tessera/bin")
        } else {
            app.path()
                .home_dir()
                .map_err(|_| failure("cli.install_failed", "The home folder is unavailable."))?
                .join(".local/bin")
        };
        let env = app.state::<AppState>().pty.login_environment_snapshot();
        Ok(Self {
            source,
            bin,
            windows: cfg!(windows),
            login_path: env_value(&env, "PATH").unwrap_or_default().into(),
        })
    }
    fn path(&self) -> PathBuf {
        self.bin.join(if self.windows { "tessera.exe" } else { "tessera" })
    }
    fn marker(&self) -> PathBuf {
        self.bin.join(".tessera-cli-install.json")
    }
    fn read_marker(&self) -> Option<Marker> {
        std::fs::read(self.marker())
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
    }
    fn owned(&self) -> bool {
        if self.windows {
            if !std::fs::symlink_metadata(self.path())
                .is_ok_and(|m| m.file_type().is_file() && !m.file_type().is_symlink())
            {
                return false;
            }
            return self
                .read_marker()
                .is_some_and(|m| digest(&self.path()).is_ok_and(|d| d == m.digest));
        }
        std::fs::read_link(self.path()).is_ok_and(|target| {
            let target = if target.is_absolute() {
                target
            } else {
                self.bin.join(target)
            };
            target == self.source
        })
    }
    fn status(&self, user_path: &str) -> CliInstall {
        let installed = self.owned();
        let on_path = contains_path(&self.login_path, &self.bin, self.windows)
            || (self.windows && contains_path(user_path, &self.bin, true));
        CliInstall {
            installed,
            path: installed.then(|| self.path().to_string_lossy().into_owned()),
            target: self.source.to_string_lossy().into_owned(),
            needs_admin: false,
            on_path,
        }
    }
    fn install(&self, user_path: &str) -> Result<(CliInstall, Option<String>), AppError> {
        if !self.source.is_file() {
            return Err(failure(
                "cli.binary_not_found",
                "The bundled CLI is missing. Build or reinstall the app first.",
            ));
        }
        if std::fs::symlink_metadata(self.path()).is_ok() && !self.owned() {
            return Err(failure(
                "cli.path_conflict",
                "Another file already occupies the CLI installation path.",
            ));
        }
        std::fs::create_dir_all(&self.bin).map_err(io_error)?;
        let mut changed_path = None;
        if self.windows {
            let previous = self.read_marker();
            let (path, added) = add_path(user_path, &self.bin);
            std::fs::copy(&self.source, self.path()).map_err(io_error)?;
            let marker = Marker {
                target: self.source.to_string_lossy().into_owned(),
                digest: digest(&self.path()).map_err(io_error)?,
                added_to_path: added || previous.is_some_and(|m| m.added_to_path),
            };
            std::fs::write(
                self.marker(),
                serde_json::to_vec(&marker)
                    .map_err(|_| failure("cli.install_failed", "The installation record could not be encoded."))?,
            )
            .map_err(io_error)?;
            if added {
                changed_path = Some(path);
            }
        } else if !self.owned() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(&self.source, self.path()).map_err(io_error)?;
            #[cfg(not(unix))]
            return Err(failure("cli.install_failed", "This installation mode is unavailable."));
        }
        let status = self.status(changed_path.as_deref().unwrap_or(user_path));
        Ok((status, changed_path))
    }
    fn uninstall(&self, user_path: &str) -> Result<Option<String>, AppError> {
        if std::fs::symlink_metadata(self.path()).is_err() {
            return Ok(None);
        }
        if !self.owned() {
            return Err(failure(
                "cli.path_conflict",
                "The CLI installation was changed by another program and was preserved.",
            ));
        }
        let marker = self.read_marker();
        std::fs::remove_file(self.path()).map_err(io_error)?;
        if self.windows {
            let _ = std::fs::remove_file(self.marker());
            if marker.is_some_and(|m| m.added_to_path) {
                return Ok(Some(remove_path(user_path, &self.bin)));
            }
        }
        Ok(None)
    }
}
fn digest(path: &Path) -> std::io::Result<u64> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = [0u8; 8192];
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok(hash);
        }
        for b in &buf[..n] {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
}
fn normalized(component: &str, windows: bool) -> String {
    let mut value = component.trim().trim_matches('"').to_string();
    if windows {
        value = value.replace('/', "\\");
        for (key, expanded) in std::env::vars() {
            let needle = format!("%{}%", key.to_ascii_uppercase());
            while let Some(index) = value.to_ascii_uppercase().find(&needle) {
                value.replace_range(index..index + needle.len(), &expanded);
                if expanded.to_ascii_uppercase().contains(&needle) {
                    break;
                }
            }
        }
        value = value.to_lowercase();
    }
    value
        .trim_end_matches(if windows { &['\\', '/'][..] } else { &['/'][..] })
        .to_string()
}
fn contains_path(path: &str, bin: &Path, windows: bool) -> bool {
    let target = normalized(&bin.to_string_lossy(), windows);
    path.split(if windows { ';' } else { ':' })
        .any(|p| !p.is_empty() && normalized(p, windows) == target)
}
fn add_path(path: &str, bin: &Path) -> (String, bool) {
    if contains_path(path, bin, true) {
        return (path.into(), false);
    }
    let value = if path.is_empty() {
        bin.to_string_lossy().into_owned()
    } else {
        format!("{};{}", path.trim_end_matches(';'), bin.display())
    };
    (value, true)
}
fn remove_path(path: &str, bin: &Path) -> String {
    let target = normalized(&bin.to_string_lossy(), true);
    path.split(';')
        .filter(|p| normalized(p, true) != target)
        .collect::<Vec<_>>()
        .join(";")
}
#[cfg(windows)]
fn user_path() -> Result<String, AppError> {
    let output = std::process::Command::new("reg.exe")
        .args(["query", r"HKCU\Environment", "/v", "Path"])
        .output()
        .map_err(|_| failure("cli.path_failed", "The user PATH could not be read."))?;
    if !output.status.success() {
        let key = std::process::Command::new("reg.exe")
            .args(["query", r"HKCU\Environment"])
            .output()
            .map_err(|_| failure("cli.path_failed", "The user PATH could not be read."))?;
        if !key.status.success() {
            return Err(failure("cli.path_failed", "The user PATH could not be read."));
        }
        return Ok(String::new());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        for kind in ["REG_EXPAND_SZ", "REG_SZ"] {
            if let Some((name, value)) = line.split_once(kind)
                && name.trim().eq_ignore_ascii_case("Path")
            {
                return Ok(value.trim().into());
            }
        }
    }
    Ok(String::new())
}
#[cfg(not(windows))]
fn user_path() -> Result<String, AppError> {
    Ok(String::new())
}
#[cfg(windows)]
fn save_user_path(value: &str) -> Result<(), AppError> {
    let status = std::process::Command::new("reg.exe")
        .args([
            "add",
            r"HKCU\Environment",
            "/v",
            "Path",
            "/t",
            "REG_EXPAND_SZ",
            "/d",
            value,
            "/f",
        ])
        .output()
        .map_err(|_| failure("cli.path_failed", "The user PATH could not be updated."))?;
    if !status.status.success() {
        return Err(failure("cli.path_failed", "The user PATH could not be updated."));
    }
    // Broadcast WM_SETTINGCHANGE with a bounded SendMessageTimeout; no user data is interpolated.
    let script = r#"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class TesseraEnv { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r); }'; $result=[UIntPtr]::Zero; [void][TesseraEnv]::SendMessageTimeout([IntPtr]65535,26,[UIntPtr]::Zero,'Environment',2,1000,[ref]$result)"#;
    let result = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|_| failure("cli.path_failed", "The environment change could not be broadcast."))?;
    if !result.status.success() {
        return Err(failure(
            "cli.path_failed",
            "The environment change could not be broadcast.",
        ));
    }
    Ok(())
}
#[cfg(not(windows))]
fn save_user_path(_: &str) -> Result<(), AppError> {
    Ok(())
}
async fn operation(app: tauri::AppHandle, action: u8) -> Result<CliInstall, AppError> {
    let location = Location::from_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = INSTALL_LOCK.lock().map_err(|_| AppError::lock_failed())?;
        let path = user_path()?;
        match action {
            1 => {
                let (status, new_path) = location.install(&path)?;
                if let Some(new_path) = new_path {
                    save_user_path(&new_path)?;
                }
                Ok(status)
            }
            2 => {
                if let Some(path) = location.uninstall(&path)? {
                    save_user_path(&path)?;
                }
                Ok(location.status(&user_path()?))
            }
            _ => Ok(location.status(&path)),
        }
    })
    .await
    .map_err(|_| failure("cli.install_failed", "The CLI installation worker failed."))?
}
#[tauri::command]
#[specta::specta]
pub async fn cli_install_status(app: tauri::AppHandle) -> Result<CliInstall, AppError> {
    operation(app, 0).await
}
#[tauri::command]
#[specta::specta]
pub async fn cli_install(app: tauri::AppHandle) -> Result<CliInstall, AppError> {
    operation(app, 1).await
}
#[tauri::command]
#[specta::specta]
pub async fn cli_uninstall(app: tauri::AppHandle) -> Result<CliInstall, AppError> {
    operation(app, 2).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(windows: bool) -> (tempfile::TempDir, Location) {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("bundled tessera");
        std::fs::write(&source, b"fixture executable").unwrap();
        let location = Location {
            source,
            bin: tmp.path().join("home/.local/bin"),
            windows,
            login_path: String::new(),
        };
        (tmp, location)
    }
    #[test]
    #[cfg(unix)]
    fn cli_install_symlink_status_path_and_uninstall_use_temp_home() {
        let (_tmp, mut l) = fixture(false);
        assert!(!l.status("").installed);
        assert!(!l.install("").unwrap().0.on_path);
        assert!(l.status("").installed);
        assert_eq!(std::fs::read_link(l.path()).unwrap(), l.source);
        l.login_path = l.bin.to_string_lossy().into_owned();
        assert!(l.status("").on_path);
        l.install("").unwrap();
        l.uninstall("").unwrap();
        assert!(!l.status("").installed);
        std::fs::write(l.path(), b"foreign").unwrap();
        assert_eq!(l.install("").unwrap_err().code, "cli.path_conflict");
        assert!(l.uninstall("").is_err());
        assert_eq!(std::fs::read(l.path()).unwrap(), b"foreign");
    }
    #[test]
    fn cli_install_windows_copy_path_dedup_and_owned_cleanup() {
        let (_tmp, l) = fixture(true);
        let (status, path) = l.install("C:\\Tools").unwrap();
        assert!(status.installed);
        assert!(status.on_path);
        let path = path.unwrap();
        assert!(l.install(&path).unwrap().1.is_none());
        assert_eq!(l.uninstall(&path).unwrap().as_deref(), Some("C:\\Tools"));
        assert!(!l.path().exists());
        l.install("").unwrap();
        std::fs::write(l.path(), b"changed").unwrap();
        assert!(l.uninstall("").is_err());
        assert!(l.path().exists());
    }
    #[test]
    fn cli_install_path_matching_and_preexisting_entries() {
        let bin = Path::new(r"C:\Users\Me\Tessera\bin");
        assert!(contains_path(r#"C:\Tools;"c:/users/me/tessera/bin/""#, bin, true));
        assert!(!add_path(r"c:\users\me\tessera\bin", bin).1);
        assert!(!contains_path(r"C:\Users\Me\Tessera\binary", bin, true));
        let (_tmp, l) = fixture(true);
        let existing = l.bin.to_string_lossy().into_owned();
        l.install(&existing).unwrap();
        assert!(l.uninstall(&existing).unwrap().is_none());
    }
}
