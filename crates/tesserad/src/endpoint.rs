//! Where the daemon listens and the token that guards it.
//!
//! macOS: a Unix socket `tesserad.sock` in the data folder, mode 0600. Windows: the named pipe
//! `\\.\pipe\tesserad-<hash of the data folder>` (one daemon per data folder, so dev and release builds do not meet).
//! A named pipe's default security lets other local accounts open it, so every connection must also present the
//! token from `tesserad-token` (mode 0600 on macOS; on Windows it lives in the user's own `%APPDATA%`).

use interprocess::local_socket::Name;
use std::io;
use std::path::{Path, PathBuf};

/// The daemon's address and token file for one data folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    data_dir: PathBuf,
}

impl Endpoint {
    /// The endpoint for the app data folder `data_dir` (`…/Tessera` or `…/Tessera Dev`).
    #[must_use]
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    /// The data folder.
    #[must_use]
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// The token file.
    #[must_use]
    pub fn token_path(&self) -> PathBuf {
        self.data_dir.join("tesserad-token")
    }

    /// Socket file (macOS) or the pipe name shown in logs (Windows).
    #[must_use]
    pub fn display(&self) -> String {
        if cfg!(windows) {
            format!(r"\\.\pipe\{}", pipe_name(&self.data_dir))
        } else {
            self.socket_path().display().to_string()
        }
    }

    /// The socket file path (unused on Windows).
    #[must_use]
    pub fn socket_path(&self) -> PathBuf {
        self.data_dir.join("tesserad.sock")
    }

    /// The local socket name to listen on or connect to.
    ///
    /// # Errors
    /// An invalid name for this platform.
    pub fn name(&self) -> io::Result<Name<'static>> {
        #[cfg(windows)]
        {
            use interprocess::local_socket::{GenericNamespaced, ToNsName};
            pipe_name(&self.data_dir).to_ns_name::<GenericNamespaced>()
        }
        #[cfg(not(windows))]
        {
            use interprocess::local_socket::{GenericFilePath, ToFsName};
            self.socket_path().to_fs_name::<GenericFilePath>()
        }
    }

    /// Creates a fresh random token, writes it user-only, and returns it.
    ///
    /// # Errors
    /// Randomness or file errors.
    pub fn create_token(&self) -> io::Result<String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        std::fs::create_dir_all(&self.data_dir)?;
        let path = self.token_path();
        let _ = std::fs::remove_file(&path);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        std::io::Write::write_all(&mut file, token.as_bytes())?;
        Ok(token)
    }

    /// Reads the token the running daemon wrote.
    ///
    /// # Errors
    /// The file is missing or unreadable.
    pub fn read_token(&self) -> io::Result<String> {
        Ok(std::fs::read_to_string(self.token_path())?.trim().to_owned())
    }
}

/// `tesserad-<16 hex digits>`: FNV-1a of the lower-cased data folder, stable across runs.
fn pipe_name(data_dir: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data_dir.to_string_lossy().to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("tesserad-{hash:016x}")
}

/// Compares two tokens in time that does not depend on where they differ.
#[must_use]
pub fn tokens_match(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_names_are_stable_and_differ_per_folder() {
        let a = pipe_name(Path::new(r"C:\Users\me\AppData\Roaming\Tessera"));
        assert_eq!(a, pipe_name(Path::new(r"c:\users\me\appdata\roaming\tessera")));
        assert_ne!(a, pipe_name(Path::new(r"C:\Users\me\AppData\Roaming\Tessera Dev")));
        assert!(a.starts_with("tesserad-") && a.len() == "tesserad-".len() + 16);
    }

    #[test]
    fn tokens_are_random_user_only_and_compared_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let endpoint = Endpoint::new(dir.path());
        let first = endpoint.create_token().unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(endpoint.read_token().unwrap(), first);
        let second = endpoint.create_token().unwrap();
        assert_ne!(first, second);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(endpoint.token_path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(tokens_match(&second, &second));
        assert!(!tokens_match(&second, &first));
        assert!(!tokens_match("", ""));
        assert!(!tokens_match(&second, &second[..63]));
    }
}
