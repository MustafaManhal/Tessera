//! Notification sounds. The app plays the sound itself (the OS notification is sent silent), so a sound plays for
//! every agent finishing, whether or not the OS shows the banner, and the user's sound setting is the only switch.
use crate::error::AppError;

/// Sound ids offered in Settings. Each maps to a system sound on macOS and on Windows.
const SOUNDS: &[(&str, &str, &str)] = &[
    ("default", "Glass", "Windows Notify System Generic.wav"),
    ("glass", "Glass", "Windows Notify Messaging.wav"),
    ("ping", "Ping", "Windows Ding.wav"),
    ("pop", "Pop", "Windows Balloon.wav"),
    ("hero", "Hero", "tada.wav"),
    ("submarine", "Submarine", "chimes.wav"),
    ("funk", "Funk", "Windows Exclamation.wav"),
    ("basso", "Basso", "Windows Critical Stop.wav"),
];

/// The platform's file for a sound id; unknown ids fall back to the default sound.
pub fn sound_file(id: &str, windows: bool) -> String {
    let (_, mac, win) = SOUNDS.iter().find(|(name, ..)| *name == id).unwrap_or(&SOUNDS[0]);
    if windows {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        format!(r"{root}\Media\{win}")
    } else {
        format!("/System/Library/Sounds/{mac}.aiff")
    }
}

/// Plays a notification sound without blocking the caller. A missing sound file is not an error the user can act on.
#[tauri::command]
#[specta::specta]
pub fn sound_play(name: String) -> Result<(), AppError> {
    std::thread::spawn(move || play(&name));
    Ok(())
}

#[cfg(target_os = "macos")]
fn play(name: &str) {
    let file = sound_file(name, false);
    let _ = std::process::Command::new("/usr/bin/afplay")
        .arg(file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(windows)]
fn play(name: &str) {
    use std::os::windows::process::CommandExt;
    let file = sound_file(name, true).replace('\'', "''");
    let script = format!("(New-Object System.Media.SoundPlayer '{file}').PlaySync()");
    let _ = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
}

#[cfg(not(any(target_os = "macos", windows)))]
fn play(_name: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_and_unknown_ids_map_to_files() {
        assert_eq!(sound_file("ping", false), "/System/Library/Sounds/Ping.aiff");
        assert_eq!(sound_file("nope", false), "/System/Library/Sounds/Glass.aiff");
        assert!(sound_file("hero", true).ends_with(r"\Media\tada.wav"));
    }

    #[test]
    fn ids_cannot_inject_a_path() {
        assert_eq!(
            sound_file("../../etc/passwd", false),
            "/System/Library/Sounds/Glass.aiff"
        );
    }
}
