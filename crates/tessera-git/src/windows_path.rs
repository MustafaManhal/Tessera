//! Windows worktree path validation and the boundary between Win32 and Git path syntax.

#[cfg(windows)]
use std::path::{Path, PathBuf};

pub(crate) fn reserved_component(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul" | "conin$" | "conout$")
        || ["com", "lpt"].iter().any(|prefix| {
            matches!(
                stem.strip_prefix(prefix),
                Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
            )
        })
}

#[cfg(any(windows, test))]
fn drive_absolute(path: &str) -> bool {
    matches!(path.as_bytes(), [letter, b':', b'\\', ..] if letter.is_ascii_alphabetic())
}

#[cfg(any(windows, test))]
fn git_spelling(path: &str) -> String {
    let path = path.replace('/', "\\");
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        if rest.get(..4).is_some_and(|prefix| prefix.eq_ignore_ascii_case("UNC\\")) {
            return format!(r"\\{}", &rest[4..]);
        }
        if drive_absolute(rest) {
            return rest.to_owned();
        }
    }
    path
}

#[cfg(any(windows, test))]
fn extended_spelling(path: &str) -> String {
    let (mut root, tail) = if drive_absolute(path) {
        (format!(r"\\?\{}", &path[..3]), &path[3..])
    } else if let Some(unc) = path.strip_prefix(r"\\") {
        let mut parts = unc.splitn(3, '\\');
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        (format!(r"\\?\UNC\{server}\{share}"), parts.next().unwrap_or_default())
    } else {
        return path.to_owned();
    };
    // Extended-length paths are literal, so resolve dot components before adding the prefix.
    let mut names = Vec::new();
    for name in tail.split('\\') {
        match name {
            "" | "." => {}
            ".." => {
                names.pop();
            }
            _ => names.push(name),
        }
    }
    if !names.is_empty() {
        if !root.ends_with('\\') {
            root.push('\\');
        }
        root.push_str(&names.join("\\"));
    }
    root
}

#[cfg(any(windows, test))]
fn valid_components(path: &str) -> bool {
    if path.starts_with(r"\\?\") || path.starts_with(r"\\.\") {
        return false;
    }
    let components = if let Some(unc) = path.strip_prefix(r"\\") {
        let mut components = unc.split('\\');
        if components.next().is_none_or(str::is_empty) || components.next().is_none_or(str::is_empty) {
            return false;
        }
        components
    } else if drive_absolute(path) {
        path[3..].split('\\')
    } else {
        path.split('\\')
    };
    components
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .all(|name| {
            !name.ends_with(['.', ' '])
                && !name
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
                && !reserved_component(name)
        })
}

/// Canonical Win32 spelling for a destination, including one that does not exist yet.
#[cfg(windows)]
pub(crate) fn worktree_destination(path: &Path) -> Result<PathBuf, crate::GitError> {
    let invalid = || crate::GitError::InvalidPath {
        path: path.to_path_buf(),
    };
    let spelling = git_spelling(path.to_str().ok_or_else(invalid)?);
    if !valid_components(&spelling) {
        return Err(invalid());
    }
    if drive_absolute(&spelling) || spelling.starts_with(r"\\") {
        return Ok(PathBuf::from(extended_spelling(&spelling)));
    }
    let absolute = std::path::absolute(&spelling)?;
    let spelling = git_spelling(absolute.to_str().ok_or_else(invalid)?);
    Ok(PathBuf::from(extended_spelling(&spelling)))
}

/// Git for Windows does its own long-path conversion with core.longpaths.
#[cfg(windows)]
pub(crate) fn git_path(path: &Path) -> PathBuf {
    path.to_str()
        .map_or_else(|| path.to_path_buf(), |text| PathBuf::from(git_spelling(text)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_path_spelling_round_trips_drive_unc_and_verbatim_paths() {
        let long = format!("C:/repo/{}/日本", "x".repeat(255));
        let normal = git_spelling(&long);
        let extended = extended_spelling(&normal);
        assert!(extended.starts_with(r"\\?\C:\repo\"));
        assert_eq!(git_spelling(&extended), normal);

        let normal = r"\\server\share\folder with spaces";
        let extended = r"\\?\UNC\server\share\folder with spaces";
        assert_eq!(extended_spelling(normal), extended);
        assert_eq!(git_spelling(extended), normal);
        assert_eq!(git_spelling(r"\\?\unc\server\share\folder with spaces"), normal);
        assert_eq!(extended_spelling(r"C:\repo\sub\..\.\task"), r"\\?\C:\repo\task");
        assert_eq!(extended_spelling(r"\\host\share\..\task"), r"\\?\UNC\host\share\task");
        assert!(!valid_components(&git_spelling(r"\\?\GLOBALROOT\Device\file")));
    }

    #[test]
    fn rejects_names_win32_rewrites_or_reserves() {
        for bad in [
            r"C:\repo\CON",
            r"C:\repo\NUL.tar.gz",
            r"C:\repo\Lpt²",
            r"C:\repo\trailing.",
            r"C:\repo\trailing ",
            r"\\host\share\aux.txt",
            r"C:\repo\alternate:stream",
        ] {
            assert!(!valid_components(bad), "{bad}");
        }
        assert!(valid_components(r"C:\repo\nested folder\.cache\console"));
        assert!(valid_components(r"\\host\share\folder\..\task"));
    }
}
