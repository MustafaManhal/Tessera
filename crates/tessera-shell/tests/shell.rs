use std::{collections::BTreeMap, fs, path::Path};
use tessera_shell::detect::{parse_login_shell, parse_wsl_distros, shell_kind};
use tessera_shell::{
    DetectionEnv, ShellEvent, ShellKind, ShellParser, detect_shells, integration_args, integration_env, prepare_launch,
    write_scripts,
};

#[test]
fn parser_accepts_every_chunk_boundary_and_both_terminators() {
    let bytes = b"noise\x1b]133;A\x07> \x1b]133;B\x1b\\echo hi\x1b]133;C\x07hi\x1b]133;D;17\x1b\\\x1b]7;file://host/tmp/space%20%CE%BB%23\x07";
    let expected = vec![
        ShellEvent::PromptStart,
        ShellEvent::PromptEnd,
        ShellEvent::CommandStart,
        ShellEvent::CommandEnd { exit: 17 },
        ShellEvent::Cwd {
            path: "/tmp/space λ#".into(),
        },
    ];
    for split in 0..=bytes.len() {
        let mut parser = ShellParser::default();
        let mut events = parser.feed(&bytes[..split]);
        events.extend(parser.feed(&bytes[split..]));
        assert_eq!(events, expected, "split {split}");
    }
    let mut parser = ShellParser::default();
    let events: Vec<_> = bytes.iter().flat_map(|b| parser.feed(&[*b])).collect();
    assert_eq!(events, expected);
}

#[test]
fn parser_ignores_garbage_and_bounds_oversized_osc() {
    for text in [
        "133;A",
        "\x1b]133;Unknown\x07",
        "\x1b]133;D;nope\x07",
        "\x1b]133;D;999999999999\x07",
        "\x1b]133;D\x07",
        "\x1b]7;https://host/foo\x07",
        "\x1b]7;file://host/foo%GG\x07",
        "\x1b]7;file://host/foo%00\x07",
        "\x1b]7;file://host/foo?bar\x07",
        "\x1b]7;file://host/foo%FF\x07",
        "\x1b]0;title\x07",
        "\x1b]133;A\x18",
    ] {
        assert!(ShellParser::default().feed(text.as_bytes()).is_empty(), "{text:?}");
    }
    let mut parser = ShellParser::default();
    let mut huge = b"\x1b]7;file://host/".to_vec();
    huge.extend(vec![b'x'; 20_000]);
    huge.extend(b"\x07\x1b]133;A\x07");
    assert_eq!(parser.feed(&huge), vec![ShellEvent::PromptStart]);
    assert_eq!(parser.feed(b"\x1b]bad\x1b]133;C\x1b\\"), vec![ShellEvent::CommandStart]);
    assert_eq!(
        parser.feed(b"\x1b]133;D;-1\x07"),
        vec![ShellEvent::CommandEnd { exit: -1 }]
    );
    assert_eq!(
        parser.feed(b"\x1b]7;file://PC/C%3A/Users/A%20B\x07"),
        vec![ShellEvent::Cwd {
            path: "/C:/Users/A B".into()
        }]
    );
}

#[test]
fn windows_discovery_output_is_utf16_aware() {
    assert_eq!(
        parse_wsl_distros(include_bytes!("fixtures/wsl-utf16le.bin")),
        vec!["Ubuntu", "Debian", "测试"]
    );
    assert_eq!(
        parse_wsl_distros(b"Ubuntu\r\nDebian\r\nUbuntu\r\n"),
        vec!["Ubuntu", "Debian"]
    );
    let mut big = vec![0xfe, 0xff];
    for c in "Ubuntu\r\n".encode_utf16() {
        big.extend(c.to_be_bytes());
    }
    assert_eq!(parse_wsl_distros(&big), vec!["Ubuntu"]);
    assert!(parse_wsl_distros(&[0xff, 0xfe, 0]).is_empty());
    assert!(parse_wsl_distros(b"Usage: wsl.exe --install\r\nNo installed distributions.\r\n").is_empty());
    assert_eq!(parse_login_shell("UserShell: /bin/zsh\n"), Some("/bin/zsh".into()));
    assert_eq!(parse_login_shell("unexpected: /bin/sh\n"), None);
    assert_eq!(
        shell_kind(r"C:\Program Files\PowerShell\7\pwsh.exe"),
        ShellKind::PowerShell
    );
    assert_eq!(shell_kind("/bin/zsh-wrapper"), ShellKind::Other);
}

fn candidate(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn discovers_login_shell_and_windows_install_locations_without_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin space");
    for name in ["zsh", "bash", "fish"] {
        candidate(&bin.join(name));
    }
    let env = DetectionEnv {
        path: vec![bin.clone()],
        login_shell: Some(bin.join("zsh")),
        ..Default::default()
    };
    let shells = detect_shells(&env);
    assert_eq!(
        shells.iter().map(|shell| shell.kind).collect::<Vec<_>>(),
        [ShellKind::Zsh, ShellKind::Bash, ShellKind::Fish]
    );
    for name in ["pwsh.exe", "cmd.exe", "wsl.exe"] {
        candidate(&bin.join(name));
    }
    candidate(&dir.path().join("Git/bin/bash.exe"));
    candidate(&dir.path().join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    let env = DetectionEnv {
        windows: true,
        path: vec![bin.clone()],
        program_dirs: vec![dir.path().into()],
        system_root: Some(dir.path().into()),
        wsl_distros: vec!["Ubuntu".into()],
        ..Default::default()
    };
    let shells = detect_shells(&env);
    assert_eq!(shells.len(), 5);
    assert_eq!(shells[0].path, bin.join("pwsh.exe"));
    assert!(shells.iter().any(|shell| shell.kind == ShellKind::GitBash));
    assert_eq!(shells.last().unwrap().id, "wsl:Ubuntu");
    assert!(detect_shells(&DetectionEnv::default()).is_empty());
}

#[test]
fn injection_snapshots_and_explicit_opt_out() {
    let dir = Path::new("integration space");
    let mut summary = Vec::new();
    for shell in [
        ShellKind::Zsh,
        ShellKind::Bash,
        ShellKind::GitBash,
        ShellKind::Fish,
        ShellKind::PowerShell,
        ShellKind::Cmd,
        ShellKind::Wsl,
    ] {
        summary.push((
            shell,
            integration_env(shell, dir, true),
            integration_args(shell, dir, true),
        ));
        assert!(integration_env(shell, dir, false).is_empty());
        assert!(integration_args(shell, dir, false).is_empty());
    }
    insta::assert_debug_snapshot!(summary);
    let environment = BTreeMap::from([
        ("ZDOTDIR".into(), "/custom zsh".into()),
        ("XDG_DATA_DIRS".into(), "/custom/share:/other".into()),
    ]);
    let plans: Vec<_> = ["zsh", "bash", "fish", "pwsh"]
        .iter()
        .map(|shell| prepare_launch(shell, &[], &environment, dir, true))
        .collect();
    insta::assert_debug_snapshot!(plans);
    for shell in ["zsh", "bash", "fish", "pwsh"] {
        assert!(
            !prepare_launch(
                shell,
                &[],
                &BTreeMap::from([("SHELL_INTEGRATION".into(), "off".into())]),
                dir,
                true
            )
            .injected
        );
        assert!(!prepare_launch(shell, &[], &environment, dir, false).injected);
    }
    for (shell, args) in [
        ("bash", vec!["-c", "echo hi"]),
        ("bash", vec!["--norc"]),
        ("bash", vec!["--rcfile", "mine"]),
        ("zsh", vec!["-f"]),
        ("fish", vec!["script.fish"]),
        ("pwsh", vec!["-File", "script.ps1"]),
        ("sh", vec![]),
    ] {
        let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
        let plan = prepare_launch(shell, &args, &environment, dir, true);
        assert!(!plan.injected);
        assert_eq!(plan.args, args);
        assert!(plan.env.is_empty());
    }
    let plan = prepare_launch("bash", &["-l".into()], &environment, dir, true);
    assert_eq!(plan.env["TESSERA_BASH_LOGIN"], "1");
    assert!(!plan.args.contains(&"-l".into()));
    let quoted = integration_args(ShellKind::PowerShell, Path::new("it's a folder"), true);
    assert!(quoted.last().unwrap().contains("it''s a folder"));
}

#[test]
fn installed_scripts_are_embedded_idempotent_and_confined() {
    let data = tempfile::tempdir().unwrap();
    let root = write_scripts(data.path()).unwrap();
    assert_eq!(root, data.path().join("shell-integration"));
    let script = root.join("bash.sh");
    let modified = fs::metadata(&script).unwrap().modified().unwrap();
    assert!(fs::read_to_string(&script).unwrap().contains("133;D"));
    write_scripts(data.path()).unwrap();
    assert_eq!(fs::metadata(&script).unwrap().modified().unwrap(), modified);
    assert!(!data.path().join(".bashrc").exists());
    fs::write(&script, "outdated").unwrap();
    write_scripts(data.path()).unwrap();
    assert!(fs::read_to_string(&script).unwrap().contains("133;D"));
    let bad = data.path().join("not a directory");
    fs::write(&bad, "keep").unwrap();
    assert_eq!(write_scripts(&bad).unwrap_err().code(), "shell.integration_io");
    assert_eq!(fs::read_to_string(bad).unwrap(), "keep");
}

#[test]
fn shared_installed_launch_matches_pure_plan_and_preserves_opt_out() {
    use tessera_shell::prepare_installed_launch;
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("test-host");
    let env = BTreeMap::from([("ZDOTDIR".into(), "/custom zsh".into())]);
    let args = vec!["-l".into()];
    let disabled = prepare_installed_launch("zsh", &args, &env, &root, false).unwrap();
    assert!(!disabled.injected);
    assert_eq!(disabled.args, args);
    assert!(!root.exists(), "disabled integration must not install scripts");
    for program in ["zsh", "bash", "fish", "pwsh"] {
        let actual = prepare_installed_launch(program, &[], &env, &root, true).unwrap();
        assert_eq!(
            actual,
            prepare_launch(program, &[], &env, &root.join("shell-integration"), true)
        );
    }
    let opt_out = BTreeMap::from([("SHELL_INTEGRATION".into(), "off".into())]);
    assert!(
        !prepare_installed_launch("zsh", &args, &opt_out, &root, true)
            .unwrap()
            .injected
    );
    let bad = data.path().join("file");
    fs::write(&bad, "keep").unwrap();
    assert_eq!(
        prepare_installed_launch("zsh", &args, &env, &bad, true)
            .unwrap_err()
            .code(),
        "shell.integration_io"
    );
    assert_eq!(fs::read_to_string(bad).unwrap(), "keep");
}
