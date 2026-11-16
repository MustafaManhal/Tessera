//! Listing a folder for the Files panel: names, whether each is a folder, and sizes. Read only.
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

/// One entry of a folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct DirEntryInfo {
    /// File or folder name.
    pub name: String,
    /// Absolute path.
    pub path: String,
    /// A folder (symbolic links to folders count as folders).
    pub is_dir: bool,
    /// Size in bytes (0 for folders).
    pub size: f64,
}

/// The most entries one folder returns; a folder with more is cut and the UI says so.
const MAX_ENTRIES: usize = 5000;

/// The entries of the folder at `path`: folders first, then files, each sorted by name. `.git` is left out.
#[tauri::command]
#[specta::specta]
pub async fn dir_list(path: String) -> Result<Vec<DirEntryInfo>, AppError> {
    tauri::async_runtime::spawn_blocking(move || list(&PathBuf::from(path)))
        .await
        .map_err(|error| AppError::new("fs.io", format!("the folder could not be read: {error}")))?
}

fn list(folder: &std::path::Path) -> Result<Vec<DirEntryInfo>, AppError> {
    let read = std::fs::read_dir(folder)
        .map_err(|error| AppError::new("fs.read_failed", format!("{}: {error}", folder.display())))?;
    let mut entries = Vec::new();
    for entry in read.flatten().take(MAX_ENTRIES) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let path = entry.path();
        // `metadata` follows links, so a link to a folder opens like a folder; a broken link is a plain file.
        let meta = std::fs::metadata(&path).or_else(|_| entry.metadata());
        let (is_dir, size) = meta.map_or((false, 0), |meta| {
            (meta.is_dir(), if meta.is_dir() { 0 } else { meta.len() })
        });
        entries.push(DirEntryInfo {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir,
            size: size as f64,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_come_first_and_git_is_hidden() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir(dir.path().join("src")).expect("dir");
        std::fs::create_dir(dir.path().join(".git")).expect("dir");
        std::fs::write(dir.path().join("a.txt"), "hello").expect("file");
        std::fs::write(dir.path().join("B.txt"), "hi").expect("file");
        let names: Vec<_> = list(dir.path()).expect("list").into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["src", "a.txt", "B.txt"]);
    }

    #[test]
    fn a_missing_folder_is_an_error() {
        assert_eq!(
            list(&PathBuf::from("/definitely/not/here")).unwrap_err().code,
            "fs.read_failed"
        );
    }
}
