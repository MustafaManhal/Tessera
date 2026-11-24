use std::{
    ffi::OsStr,
    path::PathBuf,
    process::Command,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tessera_agents::{Catalog, Detector, LaunchProfile, command_line, detection::*};
fn fixture() -> PathBuf {
    static BINARY: OnceLock<PathBuf> = OnceLock::new();
    BINARY
        .get_or_init(|| {
            let dir = tempfile::tempdir().unwrap().keep();
            let binary = dir.join(if cfg!(windows) { "fake_agent.exe" } else { "fake_agent" });
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples/fake_agent.rs");
            assert!(
                Command::new("rustc")
                    .arg(source)
                    .arg("-o")
                    .arg(&binary)
                    .status()
                    .unwrap()
                    .success()
            );
            binary
        })
        .clone()
}
fn definitions() -> Catalog {
    Catalog::load(tempfile::tempdir().unwrap().path())
}
#[test]
fn detection_finds_absence_and_cache_rescan() {
    let binary = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let name = if cfg!(windows) { "claude.exe" } else { "claude" };
    std::fs::copy(&binary, tmp.path().join(name)).unwrap();
    let def = &definitions().entries[0].definition;
    let path = tmp.path().as_os_str();
    let mut detector = Detector::default();
    let d = detector.detect(def, path, ".EXE;.CMD", false);
    assert!(d.binary_path.is_some());
    assert_eq!(d.version.as_deref(), Some("1.2.3"));
    let version_file = tmp.path().join("version.txt");
    std::fs::write(&version_file, "4.5.6").unwrap();
    let mut cached_def = def.clone();
    cached_def
        .version_cmd
        .extend(["--version-file".into(), version_file.to_string_lossy().into_owned()]);
    assert_eq!(
        detector.detect(&cached_def, path, ".EXE", false).version.as_deref(),
        Some("4.5.6")
    );
    std::fs::write(&version_file, "7.8.9").unwrap();
    assert_eq!(
        detector.detect(&cached_def, path, ".EXE", false).version.as_deref(),
        Some("4.5.6")
    );
    assert_eq!(
        detector.detect(&cached_def, path, ".EXE", true).version.as_deref(),
        Some("7.8.9")
    );
    std::fs::write(&version_file, "9.8.7").unwrap();
    // Setting a modification time needs a writable handle on Windows (SetFileTime denies a read-only one), but on macOS
    // opening a signed executable for writing invalidates its code signature and its next run is killed.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(cfg!(windows))
        .open(tmp.path().join(name))
        .unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now() + Duration::from_secs(2)))
        .unwrap();
    drop(file);
    assert_eq!(
        detector.detect(&cached_def, path, ".EXE", false).version.as_deref(),
        Some("9.8.7")
    );
    // A valid cache hit survives a changed version command only when its argv is unchanged.
    let mut def2 = def.clone();
    def2.version_cmd = vec!["claude".into(), "--hang-version".into()];
    let start = Instant::now();
    let d = detector.detect(&def2, path, ".EXE", true);
    assert!(d.error.unwrap().contains("timed out"));
    assert!(start.elapsed() < Duration::from_secs(5));
    std::fs::remove_file(tmp.path().join(name)).unwrap();
    assert!(detector.detect(def, path, ".EXE", false).binary_path.is_none());
}
#[test]
fn windows_pathext_expansion_and_search_on_any_platform() {
    assert_eq!(
        binary_candidates("agent", true, ".EXE;.CMD"),
        ["agent.EXE", "agent.exe", "agent.CMD", "agent.cmd", "agent"]
    );
    assert_eq!(binary_candidates("agent.cmd", true, ".EXE"), ["agent.cmd"]);
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("agent.cmd"), "@echo 1.2.3").unwrap();
    assert!(find_binary(&["agent".into()], tmp.path().as_os_str(), true, ".CMD").is_some());
    assert!(find_binary(&["missing".into()], tmp.path().as_os_str(), true, ".CMD").is_none());
}
#[test]
fn prompt_modes_preserve_literal_prompt_and_profile() {
    let mut def = definitions().entries[0].definition.clone();
    let p = LaunchProfile {
        model: Some("chosen".into()),
        extra_args: vec!["--extra".into()],
        env: [("COLOR".into(), "1".into())].into(),
        ..Default::default()
    };
    let prompt = "--dangerously-skip-permissions $(hello)\nworld";
    for mode in ["arg", "stdin", "type", "flag:--prompt"] {
        def.prompt_mode = mode.into();
        let c = command_line(&def, &p, Some(prompt)).unwrap();
        assert_eq!(&c.args[..3], ["--model", "chosen", "--extra"]);
        assert_eq!(c.env, p.env);
        match mode {
            "arg" => assert_eq!(&c.args[3..], ["--", prompt]),
            "stdin" => assert_eq!(c.stdin.as_deref(), Some(prompt)),
            "type" => assert_eq!(c.type_after_ready.as_deref(), Some(prompt)),
            _ => assert_eq!(&c.args[3..], ["--prompt", prompt]),
        }
    }
}
#[test]
fn every_bundled_agent_requires_explicit_permission_switch() {
    for entry in definitions().entries {
        let def = entry.definition;
        let safe = command_line(&def, &LaunchProfile::default(), None).unwrap();
        for flag in &def.yolo_flags {
            assert!(!safe.args.contains(flag), "{}", def.id);
        }
        let enabled = command_line(
            &def,
            &LaunchProfile {
                skip_permissions: true,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        for flag in &def.yolo_flags {
            assert!(enabled.args.contains(flag));
            assert!(
                command_line(
                    &def,
                    &LaunchProfile {
                        extra_args: vec![flag.clone()],
                        ..Default::default()
                    },
                    None
                )
                .is_err()
            );
        }
    }
}
#[test]
fn fake_agent_echo_and_notifications() {
    use std::io::Write;
    for mode in ["arg", "stdin", "type"] {
        let mut def = definitions().entries[0].definition.clone();
        def.prompt_mode = mode.into();
        let c = command_line(&def, &LaunchProfile::default(), Some("hello")).unwrap();
        let mut child = Command::new(fixture())
            .args(c.args)
            .env("FAKE_AGENT_NOTIFY", "finished")
            .env("FAKE_AGENT_NEEDS_INPUT", "Confirm? (y/n)")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(input) = c.stdin.or(c.type_after_ready) {
            writeln!(child.stdin.take().unwrap(), "{input}").unwrap();
        }
        let out = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
        assert!(out.contains("prompt: hello"));
        assert!(out.contains("\x1b]9;finished\x07"));
        assert!(out.contains("Confirm?"));
    }
}
#[test]
fn version_token_parsing() {
    assert_eq!(parse_version("codex-cli 0.167.0"), Some("0.167.0".into()));
    assert_eq!(parse_version("2026.11.05-86047df"), Some("2026.11.05-86047df".into()));
    assert_eq!(parse_version("no release"), None);
    assert!(
        probe_version(
            &fixture(),
            &["--hang-version".into()],
            OsStr::new(""),
            Duration::from_millis(100)
        )
        .unwrap_err()
        .contains("timed out")
    );
}
