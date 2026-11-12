use std::{
    fs,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use tessera_store::{
    Config, ConfigState, ConfigWatcher,
    config::{parse_config, parse_config_with_warnings, suggest_key},
    config_patch::{patch_config, write_config_patch},
};

const DEFAULTS: &str = include_str!("fixtures/default-config.toml");

#[test]
fn every_documented_default_and_schema_key() {
    let defaults = parse_config(DEFAULTS).unwrap();
    assert_eq!(defaults, Config::default());
    assert_eq!(parse_config("").unwrap(), defaults);
    let schema = tessera_store::config_json_schema();
    let documented: toml::Table = toml::from_str(DEFAULTS).unwrap();
    for (section, values) in documented {
        assert!(schema.contains(&format!("\"{section}\"")), "section {section}");
        for key in values.as_table().unwrap().keys() {
            assert!(schema.contains(&format!("\"{key}\"")), "key {section}.{key}");
        }
    }
    assert!(schema.contains("1000000"));
    assert!(schema.contains("\"maximum\": 72"));
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("config.toml");
    assert_eq!(tessera_store::load_config(&missing).unwrap(), defaults);
    assert!(!missing.exists());
}

#[test]
fn all_range_errors_have_line_and_key() {
    for (section, key, invalid, valid) in [
        (
            "font",
            "size",
            vec!["5", "73", "nan", "inf", "-inf"],
            vec!["6", "72", "13.5"],
        ),
        (
            "terminal",
            "scrollback",
            vec!["-1", "1000001", "0.5"],
            vec!["0", "1000000"],
        ),
        (
            "appearance",
            "window-opacity",
            vec!["-0.1", "1.1", "nan", "inf"],
            vec!["0", "1"],
        ),
        ("appearance", "ui-zoom", vec!["0.4", "3.1", "nan"], vec!["0.5", "3"]),
        ("appearance", "padding", vec!["-1", "33", "1.5"], vec!["0", "32"]),
        (
            "appearance",
            "dim-unfocused",
            vec!["-0.1", "0.7", "nan"],
            vec!["0", "0.6"],
        ),
        ("font", "line-height", vec!["0.4", "3.1", "nan"], vec!["0.5", "3"]),
        (
            "quick-terminal",
            "height",
            vec!["0", "-1", "1.01", "nan"],
            vec!["0.1", "1"],
        ),
    ] {
        for value in invalid {
            let text = format!("# comment\n[{section}] # header\n{key} = {value}\n");
            let error = parse_config(&text).expect_err(&text);
            assert_eq!(error.key(), Some(format!("{section}.{key}").as_str()), "{text}");
            assert_eq!(error.line(), Some(3), "{text}");
            assert_eq!(error.code(), "config.invalid");
        }
        for value in valid {
            parse_config(&format!("[{section}]\n{key} = {value}\n")).unwrap();
        }
    }
}

#[test]
fn aliases_and_existing_settings_still_work() {
    let text =
        "[terminal]\nfont_size=15\nscrollback_lines=123\n[appearance]\ntheme='dark'\n[updates]\nchannel='beta'\n";
    let config = parse_config(text).unwrap();
    assert_eq!(config.font.size, 15.0);
    assert_eq!(config.terminal.scrollback, 123);
    assert_eq!(config.appearance.theme, tessera_store::Theme::Dark);
    assert_eq!(config.updates.channel, tessera_store::UpdateChannel::Beta);
    let direct: Config = toml::from_str(text).unwrap();
    assert_eq!(direct, config);
    assert!(parse_config_with_warnings(text).unwrap().warnings.is_empty());
    let canonical = toml::to_string(&config).unwrap();
    assert!(!canonical.contains("font_size"));
    assert!(!canonical.contains("scrollback_lines"));
    for (text, key, line) in [
        ("[terminal]\nfont_size=2\n", "terminal.font_size", 2),
        ("[terminal]\nscrollback_lines=-1\n", "terminal.scrollback_lines", 2),
        ("[terminal]\nfont_size=15\n[font]\nsize=16\n", "terminal.font_size", 2),
        (
            "[terminal]\nscrollback=15\nscrollback_lines=16\n",
            "terminal.scrollback_lines",
            3,
        ),
    ] {
        let error = parse_config(text).unwrap_err();
        assert_eq!(error.key(), Some(key));
        assert_eq!(error.line(), Some(line));
    }
}

#[test]
fn type_enum_and_syntax_errors_are_located() {
    for (text, key, line) in [
        ("[terminal]\ncursor-style='circle'\n", "terminal.cursor-style", 2),
        ("[terminal]\nengine='other'\n", "terminal.engine", 2),
        ("[terminal]\nosc52='yes'\n", "terminal.osc52", 2),
        ("[terminal]\nshell-integration='yes'\n", "terminal.shell-integration", 2),
        ("[font]\nfeatures=[1]\n", "font.features", 2),
        ("[appearance]\ntheme='neon'\n", "appearance.theme", 2),
        ("[updates]\nchannel='nightly'\n", "updates.channel", 2),
        ("terminal=13\n", "terminal", 1),
        ("[font] # with comment\n'size'=\"big\"\n", "font.size", 2),
        ("\nfont.size=2\n", "font.size", 2),
        ("font={size=2}\n", "font.size", 1),
    ] {
        let error = parse_config(text).unwrap_err();
        assert_eq!(error.key(), Some(key), "{text}");
        assert_eq!(error.line(), Some(line), "{text}");
    }
    let error = parse_config("# comment\n[terminal\n").unwrap_err();
    assert_eq!(error.code(), "config.syntax");
    assert_eq!(error.line(), Some(2));
}

#[test]
fn unknown_keys_in_every_section_survive_and_warn() {
    let mut text = "future = { nested = [1,2] }\n".to_owned();
    let defaults: toml::Table = toml::from_str(DEFAULTS).unwrap();
    for section in defaults.keys() {
        text.push_str(&format!("[{section}]\nfuture-key=123\n"));
    }
    let parsed = parse_config_with_warnings(&text).unwrap();
    assert_eq!(parsed.warnings.len(), defaults.len() + 1);
    let serialized = toml::to_string(&parsed.config).unwrap();
    assert_eq!(parse_config(&serialized).unwrap(), parsed.config);
    assert_eq!(serialized.matches("future-key = 123").count(), defaults.len());
    let typo = parse_config_with_warnings("[font]\nszie=17\n").unwrap();
    assert_eq!(typo.warnings[0].suggestion.as_deref(), Some("font.size"));
    assert_eq!(typo.warnings[0].line, Some(2));
    assert_eq!(
        suggest_key("scrollbak", ["scrollback", "engine"]),
        Some("scrollback".into())
    );
    assert_eq!(suggest_key("猫咪", ["猫米"]), Some("猫米".into()));
    assert_eq!(suggest_key("totally-unrelated", ["scrollback", "engine"]), None);
}

#[test]
fn pure_state_keeps_last_good_and_clears_error_on_recovery() {
    let mut state = ConfigState::default();
    state.reload("[font]\nsize=18\n");
    state.reload("[font]\nsize=-1\n");
    assert_eq!(state.current.font.size, 18.0);
    assert_eq!(state.last_error.as_ref().unwrap().line, Some(2));
    state.reload("[font]\nsize=20\n");
    assert_eq!(state.current.font.size, 20.0);
    assert!(state.last_error.is_none());
}

fn patch(text: &str, updates: &str) -> String {
    patch_config(text, &toml::from_str(updates).unwrap()).unwrap()
}

#[test]
fn patch_preserves_comments_order_whitespace_crlf_and_unknown_keys() {
    let text = "# user settings\r\n[font] # heading\r\nfamily = 'Mono # special' # keep\r\n  size  = 13  # size\r\nfuture = 42\r\n[terminal]\r\nscrollback=10000\r\n";
    let result = patch(text, "[font]\nsize=16\n");
    assert_eq!(result, text.replace("= 13 ", "= 16 "));
    assert_eq!(patch(&result, ""), result);
    assert_eq!(patch(&result, "[font]\nsize=16\n"), result);
    let result = patch(
        "[terminal]\nfont_size=13 # old\nscrollback_lines=5\n",
        "[font]\nsize=20\n[terminal]\nscrollback=10\n",
    );
    assert_eq!(result, "[terminal]\nfont_size=20 # old\nscrollback_lines=10\n");
}

#[test]
fn patch_handles_quoted_dotted_inline_new_and_multiline_values() {
    for text in [
        "[font]\nsize=13",
        "['font'] # name\nsize=13\n[updates]\nchannel='beta'\n",
        "font.size=13\n",
        "font={size=13}\n",
        "",
        "[terminal]\nengine='xterm'\n",
    ] {
        let result = patch(text, "[font]\nfamily='Other'\nsize=20\n");
        let config = parse_config(&result).unwrap();
        assert_eq!(config.font.size, 20.0, "{result}");
        assert_eq!(config.font.family, "Other", "{result}");
    }
    let source = "[font]\nfeatures = [\n  'calt', # old\n  'ss01'\n] # retained\nfamily='''multi\n[updates]\nline'''\n[updates]\nchannel='beta'\n";
    let result = patch(source, "[font]\nfeatures=['liga']\nsize=18\n");
    assert!(result.contains("# retained"));
    assert!(result.contains("family='''multi\n[updates]\nline'''"));
    assert_eq!(parse_config(&result).unwrap().font.size, 18.0);
    let result = patch(
        "[keybindings]\n'pane.splitRight'='Cmd+D' # keep\n",
        "[keybindings]\n'pane.splitRight'='Ctrl+D'\n",
    );
    assert!(result.contains("# keep"));
    assert!(result.contains("Ctrl+D"));
}

#[test]
fn invalid_patches_do_not_touch_disk() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.toml");
    fs::write(&path, DEFAULTS).unwrap();
    for invalid in ["[font]\nsize=1\n", "[font]\nszie=1\n", "[unknown]\na=1\n", "font=1\n"] {
        assert!(write_config_patch(&path, &toml::from_str(invalid).unwrap()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), DEFAULTS);
    }
    let updated = write_config_patch(&path, &toml::from_str("[font]\nsize=18\n").unwrap()).unwrap();
    assert_eq!(updated.font.size, 18.0);
    assert!(fs::read_to_string(&path).unwrap().contains("# macOS vibrancy"));
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    fs::write(&path, "broken = [").unwrap();
    assert!(write_config_patch(&path, &toml::from_str("[font]\nsize=18\n").unwrap()).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "broken = [");
}

fn until(receiver: &mpsc::Receiver<ConfigState>, predicate: impl Fn(&ConfigState) -> bool) -> ConfigState {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let state = receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("watcher callback before deadline");
        if predicate(&state) {
            return state;
        }
    }
}

#[test]
fn real_watcher_handles_invalid_valid_atomic_save_deletion_and_recreation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.toml");
    fs::write(&path, "[font]\nsize=17\n").unwrap();
    let shared = Arc::new(Mutex::new(ConfigState::default()));
    let (sender, receiver) = mpsc::channel();
    let watcher = ConfigWatcher::start(&path, Arc::clone(&shared), move |state| {
        sender.send(state.clone()).unwrap();
    })
    .unwrap();
    until(&receiver, |state| state.current.font.size == 17.0);
    fs::write(&path, "[font]\nsize=-1\n").unwrap();
    let invalid = until(&receiver, |state| state.last_error.is_some());
    assert_eq!(invalid.current.font.size, 17.0);
    assert_eq!(invalid.last_error.unwrap().key.as_deref(), Some("font.size"));
    let replacement = directory.path().join("replacement.toml");
    fs::write(&replacement, "[font]\nsize=19\n").unwrap();
    fs::rename(replacement, &path).unwrap();
    let valid = until(&receiver, |state| state.current.font.size == 19.0);
    assert!(valid.last_error.is_none());
    fs::remove_file(&path).unwrap();
    until(&receiver, |state| state.current == Config::default());
    fs::write(&path, "[font]\nsize=22\n").unwrap();
    until(&receiver, |state| state.current.font.size == 22.0);
    drop(watcher);
    assert_eq!(shared.lock().unwrap().current.font.size, 22.0);
    assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
}

#[test]
fn syntax_error_identifies_the_setting_when_the_parser_recovers_it() {
    let error = parse_config("[font]\nsize=not_a_number\n").unwrap_err();
    assert_eq!(error.line(), Some(2));
    assert_eq!(error.key(), Some("font.size"));
}

#[test]
fn no_op_patch_does_not_reformat_numbers_or_write_default_values() {
    let text = "[font]\nsize=16 # integer spelling\n";
    assert_eq!(patch(text, "[font]\nsize=16.0\n"), text);
    assert_eq!(patch("", "[font]\nsize=13\n"), "");
}

#[test]
fn read_errors_keep_last_good_state_and_missing_parent_fails_cleanly() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = ConfigState::default();
    state.reload("[font]\nsize=19\n");
    state.reload_path(directory.path());
    assert_eq!(state.current.font.size, 19.0);
    assert_eq!(state.last_error.unwrap().code, "config.read_failed");
    let absent = directory.path().join("missing").join("config.toml");
    assert!(ConfigWatcher::start(&absent, Arc::new(Mutex::new(ConfigState::default())), |_| {}).is_err());
    assert!(write_config_patch(&absent, &toml::from_str("[font]\nsize=18\n").unwrap()).is_err());
    assert!(!absent.exists());
}

#[test]
fn watcher_ignores_other_files_and_coalesces_a_burst_of_edits() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.toml");
    fs::write(&path, "[font]\nsize=17\n").unwrap();
    let (sender, receiver) = mpsc::channel();
    let watcher = ConfigWatcher::start(&path, Arc::new(Mutex::new(ConfigState::default())), move |state| {
        sender.send(state.clone()).unwrap();
    })
    .unwrap();
    until(&receiver, |state| state.current.font.size == 17.0);
    fs::write(directory.path().join("unrelated.log"), "noise").unwrap();
    assert!(matches!(
        receiver.recv_timeout(Duration::from_millis(350)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    for size in [18, 19, 20] {
        fs::write(&path, format!("[font]\nsize={size}\n")).unwrap();
    }
    let state = receiver.recv_timeout(Duration::from_secs(8)).unwrap();
    assert_eq!(state.current.font.size, 20.0);
    assert!(matches!(
        receiver.recv_timeout(Duration::from_millis(350)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(watcher);
}
