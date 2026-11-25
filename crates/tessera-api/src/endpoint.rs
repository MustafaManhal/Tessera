//! API address and user-only authentication file. Tokens are never included in Debug output.
use interprocess::local_socket::{Name, prelude::*};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub address: String,
    pub token_file: PathBuf,
}
impl Endpoint {
    pub fn new(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref();
        Self {
            address: if cfg!(windows) {
                format!(r"\\.\pipe\{}", pipe_name(root))
            } else {
                root.join("tessera.sock").to_string_lossy().into_owned()
            },
            token_file: root.join("api-token"),
        }
    }
    pub fn from_environment(dev: bool) -> io::Result<Self> {
        let mut endpoint = Self::new(default_data_dir(dev)?);
        if let Some(address) = std::env::var_os("TESSERA_SOCKET") {
            endpoint.address = address.to_string_lossy().into_owned();
        }
        if let Some(path) = std::env::var_os("TESSERA_API_TOKEN_FILE") {
            endpoint.token_file = path.into();
        } else if !cfg!(windows)
            && std::env::var_os("TESSERA_SOCKET").is_some()
            && let Some(parent) = Path::new(&endpoint.address).parent()
        {
            endpoint.token_file = parent.join("api-token");
        }
        Ok(endpoint)
    }
    pub fn name(&self) -> io::Result<Name<'static>> {
        #[cfg(windows)]
        {
            use interprocess::local_socket::GenericNamespaced;
            let prefix = r"\\.\pipe\";
            let name = self.address.strip_prefix(prefix).unwrap_or(&self.address);
            if name.contains(['\\', '/']) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Only local pipe names are supported.",
                ));
            }
            name.to_string().to_ns_name::<GenericNamespaced>()
        }
        #[cfg(not(windows))]
        {
            use interprocess::local_socket::GenericFilePath;
            PathBuf::from(&self.address).to_fs_name::<GenericFilePath>()
        }
    }
    pub(crate) fn create_token(&self) -> io::Result<String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| io::Error::other("Authentication randomness is unavailable."))?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let _ = std::fs::remove_file(&self.token_file);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&self.token_file)?.write_all(token.as_bytes())?;
        Ok(token)
    }
    pub fn read_token(&self) -> io::Result<String> {
        let mut text = String::new();
        std::fs::File::open(&self.token_file)?
            .take(129)
            .read_to_string(&mut text)?;
        let text = text.trim();
        if text.len() != 64 || !text.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "The API authentication file is invalid.",
            ));
        }
        Ok(text.into())
    }
}
pub fn default_data_dir(dev: bool) -> io::Result<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    }
    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "The user data folder is unavailable."))?;
    Ok(base.join(if dev { "Tessera Dev" } else { "Tessera" }))
}
pub fn pipe_name(root: &Path) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in root.to_string_lossy().to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("tessera-{hash:016x}")
}
pub fn tokens_match(expected: &str, given: &str) -> bool {
    if expected.len() != given.len() || expected.is_empty() {
        return false;
    }
    expected
        .bytes()
        .zip(given.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}
