use super::*;
fn fixture(kind: Kind) -> String {
    match kind {
        Kind::Claude => include_str!("../../../../fixtures/hooks/claude/settings.before.json.fixture"),
        Kind::Gemini => include_str!("../../../../fixtures/hooks/gemini/settings.before.json.fixture"),
        Kind::Codex => include_str!("../../../../fixtures/hooks/codex/settings.before.toml"),
    }
    .into()
}
#[test]
fn hooks_golden_roundtrips_and_idempotence() {
    for kind in [Kind::Claude, Kind::Codex, Kind::Gemini] {
        for original in [
            fixture(kind),
            if kind == Kind::Codex {
                String::new()
            } else {
                "{}".into()
            },
            if kind == Kind::Codex {
                "# trailing comment".into()
            } else {
                "{ \r\n\t}\r\n".into()
            },
        ] {
            let installed = plan(
                kind,
                &original,
                "/fixture/tessera",
                Action::Install,
                &Ownership::default(),
            )
            .unwrap();
            if original == fixture(kind) {
                let expected = match kind {
                    Kind::Claude => include_str!("../../../../fixtures/hooks/claude/settings.after.json.fixture"),
                    Kind::Gemini => include_str!("../../../../fixtures/hooks/gemini/settings.after.json.fixture"),
                    Kind::Codex => include_str!("../../../../fixtures/hooks/codex/settings.after.toml"),
                };
                assert_eq!(installed.after, expected);
            }
            assert_eq!(state(kind, &installed.after, "/fixture/tessera"), State::Installed);
            let twice = plan(
                kind,
                &installed.after,
                "/fixture/tessera",
                Action::Install,
                &installed.ownership,
            )
            .unwrap();
            assert_eq!(installed.after, twice.after);
            assert!(twice.diff.is_empty());
            let removed = plan(
                kind,
                &installed.after,
                "/fixture/tessera",
                Action::Remove,
                &installed.ownership,
            )
            .unwrap();
            assert_eq!(removed.after, original);
            let updated = plan(
                kind,
                &installed.after,
                "/new location/tessera",
                Action::Install,
                &installed.ownership,
            )
            .unwrap();
            assert_eq!(state(kind, &installed.after, "/new location/tessera"), State::Outdated);
            assert_eq!(state(kind, &updated.after, "/new location/tessera"), State::Installed);
            assert_eq!(
                plan(
                    kind,
                    &updated.after,
                    "/new location/tessera",
                    Action::Remove,
                    &updated.ownership
                )
                .unwrap()
                .after,
                original
            );
        }
    }
}
#[test]
fn hooks_conflicts_invalid_inputs_and_toml_comments_are_preserved() {
    let conflict = include_str!("../../../../fixtures/hooks/codex/settings.conflict.toml");
    assert_eq!(state(Kind::Codex, conflict, "/cli"), State::Conflict);
    for action in [Action::Install, Action::Remove] {
        assert!(
            matches!(plan(Kind::Codex,conflict,"/cli",action,&Ownership::default()),Err(HookError::Conflict(value))if value.contains("user-notifier"))
        );
    }
    for (kind, text) in [
        (Kind::Codex, "notify = ["),
        (Kind::Claude, "{bad"),
        (Kind::Gemini, "{\"hooks\":[]}"),
        (Kind::Claude, "{\"hooks\":{},\"hooks\":{}}"),
    ] {
        assert_eq!(state(kind, text, "/cli"), State::Unparseable);
        assert!(plan(kind, text, "/cli", Action::Install, &Ownership::default()).is_err());
    }
    let original = "# header\nmodel='keep' # inline\n[extra]\ntext = '''\n# >>> tessera-managed >>>\nexample only\n# <<< tessera-managed <<<\n'''\n";
    let installed = plan(Kind::Codex, original, "/cli", Action::Install, &Ownership::default()).unwrap();
    assert_eq!(
        plan(
            Kind::Codex,
            &installed.after,
            "/cli",
            Action::Remove,
            &installed.ownership
        )
        .unwrap()
        .after,
        original
    );
}
#[test]
fn hooks_windows_paths_and_user_changes_remain_literal() {
    let path = r"C:\Program Files\Tessera\tessera.exe";
    for kind in [Kind::Claude, Kind::Codex, Kind::Gemini] {
        let text = if kind == Kind::Codex { "" } else { "{}" };
        let p = plan(kind, text, path, Action::Install, &Ownership::default()).unwrap();
        assert_eq!(state(kind, &p.after, path), State::Installed);
        if kind == Kind::Codex {
            let v: toml::Value = toml::from_str(&p.after).unwrap();
            assert_eq!(v["notify"][0].as_str(), Some(path));
        } else {
            let v: serde_json::Value = serde_json::from_str(&p.after).unwrap();
            let cmd = v["hooks"][kind.events()[0]][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.starts_with("& '"));
            assert!(cmd.contains("Program Files"));
        }
    }
    let p = plan(
        Kind::Claude,
        "{\"unknown\":1}",
        "/cli",
        Action::Install,
        &Ownership::default(),
    )
    .unwrap();
    let changed = p
        .after
        .replacen("\"unknown\":1", "\"unknown\":2, \"new-user-field\": [ 1, 2 ]", 1);
    let removed = plan(Kind::Claude, &changed, "/cli", Action::Remove, &p.ownership).unwrap();
    assert!(removed.after.contains("\"new-user-field\": [ 1, 2 ]"));
    assert!(removed.after.contains("\"unknown\":2"));
}
#[test]
fn hooks_files_backups_atomic_failure_and_missing_provenance() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("nested/settings.json");
    let files = HookFiles {
        path: path.clone(),
        kind: Kind::Claude,
        cli: "/fixture/tessera".into(),
    };
    files.apply(Action::Install).unwrap();
    assert!(path.is_file());
    assert_eq!(
        std::fs::read_to_string(path.with_file_name("settings.json.tessera.bak")).unwrap(),
        ""
    );
    files.apply(Action::Remove).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    files.apply(Action::Install).unwrap();
    files.apply(Action::Remove).unwrap();
    std::fs::write(&path, "{\n \"user\": true\n}\n").unwrap();
    let original = std::fs::read(&path).unwrap();
    assert!(
        files
            .apply_with_failure(Action::Install, WriteFailure::BeforeRename)
            .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    files.apply(Action::Install).unwrap();
    assert_eq!(
        std::fs::read(path.with_file_name("settings.json.tessera.bak")).unwrap(),
        original
    );
    files.apply(Action::Remove).unwrap();
    assert!(path.with_file_name("settings.json.tessera.bak.1").is_file());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    std::fs::write(&path, "{broken").unwrap();
    assert!(files.apply(Action::Install).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{broken");
}

#[test]
fn hooks_never_release_another_writer_lock() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("settings.json");
    std::fs::write(&path, "{}").unwrap();
    let lock = tmp.path().join("settings.json.tessera.lock");
    std::fs::write(&lock, "other writer").unwrap();
    let files = HookFiles {
        path: path.clone(),
        kind: Kind::Claude,
        cli: "/cli".into(),
    };
    assert!(files.apply(Action::Install).is_err());
    assert_eq!(std::fs::read_to_string(lock).unwrap(), "other writer");
    assert_eq!(std::fs::read_to_string(path).unwrap(), "{}");
}

#[test]
fn hooks_remove_tagged_commands_inside_user_groups_without_removing_user_material() {
    for kind in [Kind::Claude, Kind::Gemini] {
        let original = r#"{"hooks":{"Stop":[{"matcher":"user", "hooks":[{"type":"command","command":"echo user"}]}]}}"#;
        let changed = original.replace(
            r#""echo user"}"#,
            r#""echo user"},{"_tessera":true,"type":"command","command":"old tessera"}"#,
        );
        assert_eq!(state(kind, &changed, "/cli"), State::Outdated);
        let removed = plan(kind, &changed, "/cli", Action::Remove, &Ownership::default()).unwrap();
        assert_eq!(removed.after, original);
    }
}

#[test]
fn hooks_invalid_or_conflicting_files_are_never_written_or_backed_up() {
    let tmp = tempfile::tempdir().unwrap();
    for (kind, text) in [
        (Kind::Claude, "{invalid"),
        (Kind::Gemini, "{invalid"),
        (Kind::Codex, "notify = ["),
        (Kind::Codex, "notify=['user']\n"),
    ] {
        let path = tmp.path().join("config");
        std::fs::write(&path, text).unwrap();
        let files = HookFiles {
            path: path.clone(),
            kind,
            cli: "/cli".into(),
        };
        for action in [Action::Install, Action::Remove] {
            assert!(files.apply(action).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
            assert!(!tmp.path().join("config.tessera.bak").exists());
        }
    }
}
