use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// An interactive CLI definition. Unknown fields are reported by the catalog loader.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub binaries: Vec<String>,
    pub version_cmd: Vec<String>,
    pub prompt_mode: String,
    pub model_flag: Option<String>,
    #[serde(default)]
    pub resume: Vec<String>,
    #[serde(default)]
    pub yolo_flags: Vec<String>,
    pub hooks: String,
    pub ready_pattern: Option<String>,
    #[serde(default)]
    pub status_patterns: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub usage: BTreeMap<String, String>,
    pub install_url: String,
    pub docs_url: String,
    pub icon: String,
}
impl AgentDefinition {
    pub fn validate(&self) -> Result<(), String> {
        for (field, value) in [
            ("id", &self.id),
            ("name", &self.name),
            ("install-url", &self.install_url),
            ("docs-url", &self.docs_url),
            ("icon", &self.icon),
        ] {
            if value.trim().is_empty() {
                return Err(format!("The {field} field must not be blank."));
            }
        }
        if self.binaries.is_empty() || self.binaries.iter().any(|b| b.trim().is_empty()) {
            return Err("At least one nonempty binary name is required.".into());
        }
        if self.version_cmd.is_empty() || self.version_cmd.iter().any(|v| v.trim().is_empty()) {
            return Err("The version-cmd field must contain a command.".into());
        }
        if !matches!(self.prompt_mode.as_str(), "arg" | "stdin" | "type")
            && !self
                .prompt_mode
                .strip_prefix("flag:")
                .is_some_and(|f| f.starts_with('-') && f.len() > 1 && !f.contains(char::is_whitespace))
        {
            return Err("The prompt-mode must be arg, stdin, type, or flag:<name>.".into());
        }
        if !matches!(
            self.hooks.as_str(),
            "claude-settings" | "codex-config" | "gemini-settings" | "none"
        ) {
            return Err("The hooks field has an unsupported adapter.".into());
        }
        if self.model_flag.as_ref().is_some_and(|f| f.trim().is_empty()) {
            return Err("The model-flag field must not be blank.".into());
        }
        for arg in &self.resume {
            let stripped = arg.replace("{external_session_id}", "");
            if stripped.contains(['{', '}']) {
                return Err("The resume template may only use {external_session_id}.".into());
            }
        }
        if let Some(pattern) = &self.ready_pattern {
            validate_regex("ready-pattern", pattern)?;
        }
        for (field, patterns) in &self.status_patterns {
            for pattern in patterns {
                validate_regex(&format!("status-patterns.{field}"), pattern)?;
            }
        }
        Ok(())
    }
}
fn validate_regex(field: &str, pattern: &str) -> Result<(), String> {
    regex::Regex::new(pattern)
        .map(|_| ())
        .map_err(|e| format!("The {field} regex {pattern:?} is invalid: {e}."))
}

/// A recoverable definition diagnostic. Line numbers are one-based when available.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefinitionError {
    pub file: PathBuf,
    pub line: Option<usize>,
    pub message: String,
}
#[derive(Debug, Clone)]
pub struct CatalogEntry {
    pub definition: AgentDefinition,
    pub source: String,
    pub errors: Vec<DefinitionError>,
}
#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub entries: Vec<CatalogEntry>,
    /// Includes errors for files without a usable id as well as per-agent errors.
    pub errors: Vec<DefinitionError>,
    pub rejected_ids: BTreeMap<String, DefinitionError>,
}
const BUNDLED: &[(&str, &str)] = &[
    ("claude", include_str!("../agents/claude.toml")),
    ("codex", include_str!("../agents/codex.toml")),
    ("gemini", include_str!("../agents/gemini.toml")),
    ("opencode", include_str!("../agents/opencode.toml")),
    ("cursor-agent", include_str!("../agents/cursor-agent.toml")),
    ("amp", include_str!("../agents/amp.toml")),
    ("qwen", include_str!("../agents/qwen.toml")),
    ("copilot", include_str!("../agents/copilot.toml")),
    ("aider", include_str!("../agents/aider.toml")),
    ("droid", include_str!("../agents/droid.toml")),
];
const KEYS: &[&str] = &[
    "id",
    "name",
    "binaries",
    "version-cmd",
    "prompt-mode",
    "model-flag",
    "resume",
    "yolo-flags",
    "hooks",
    "ready-pattern",
    "status-patterns",
    "usage",
    "install-url",
    "docs-url",
    "icon",
];

fn parse(text: &str, file: &Path) -> Result<toml::Value, DefinitionError> {
    toml::from_str(text).map_err(|e: toml::de::Error| DefinitionError {
        file: file.into(),
        line: e
            .span()
            .map(|s| text[..s.start].bytes().filter(|b| *b == b'\n').count() + 1),
        message: format!("The definition could not be parsed: {e}."),
    })
}
fn decode(value: toml::Value, file: &Path) -> Result<AgentDefinition, DefinitionError> {
    let def: AgentDefinition = value.try_into().map_err(|e| DefinitionError {
        file: file.into(),
        line: None,
        message: format!("The definition has invalid fields: {e}."),
    })?;
    def.validate().map_err(|message| DefinitionError {
        file: file.into(),
        line: None,
        message,
    })?;
    Ok(def)
}
fn merge(base: &mut toml::Value, patch: toml::Value) {
    if let (Some(a), Some(b)) = (base.as_table_mut(), patch.as_table()) {
        for (key, value) in b {
            if let Some(old) = a.get_mut(key) {
                merge(old, value.clone());
            } else {
                a.insert(key.clone(), value.clone());
            }
        }
    } else {
        *base = patch;
    }
}
impl Catalog {
    /// Load bundled data then deterministic, field-by-field user overrides.
    /// Bad files never remove the last valid definition; unknown keys produce warnings.
    pub fn load(config_dir: &Path) -> Self {
        let mut catalog = Self::default();
        let mut values = BTreeMap::new();
        for (id, text) in BUNDLED {
            let path = PathBuf::from(format!("bundled/{id}.toml"));
            match parse(text, &path).and_then(|value| decode(value.clone(), &path).map(|d| (value, d))) {
                Ok((value, definition)) => {
                    if values.insert(id.to_string(), value).is_some() {
                        catalog.errors.push(DefinitionError {
                            file: path,
                            line: None,
                            message: format!("The agent id {id} is duplicated."),
                        });
                    } else {
                        catalog.entries.push(CatalogEntry {
                            definition,
                            source: "bundled".into(),
                            errors: vec![],
                        });
                    }
                }
                Err(e) => catalog.errors.push(e),
            }
        }
        let directory = config_dir.join("agents");
        let mut files = match std::fs::read_dir(&directory) {
            Ok(files) => files
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "toml"))
                .collect::<Vec<_>>(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return catalog,
            Err(e) => {
                catalog.errors.push(DefinitionError {
                    file: directory,
                    line: None,
                    message: format!("The agent directory could not be read: {e}."),
                });
                return catalog;
            }
        };
        files.sort();
        for file in files {
            let result = std::fs::read_to_string(&file)
                .map_err(|e| DefinitionError {
                    file: file.clone(),
                    line: None,
                    message: format!("The definition could not be read: {e}."),
                })
                .and_then(|s| parse(&s, &file));
            let mut warnings = vec![];
            let mut known_id = None;
            let result = result.and_then(|mut patch| {
                known_id = patch.get("id").and_then(|v| v.as_str()).map(String::from);
                if let Some(table) = patch.as_table() {
                    for key in table.keys().filter(|k| !KEYS.contains(&k.as_str())) {
                        warnings.push(DefinitionError {
                            file: file.clone(),
                            line: None,
                            message: format!("The key {key:?} is unknown and was ignored."),
                        });
                    }
                    for (section, keys) in [
                        ("usage", &["source"][..]),
                        ("status-patterns", &["needs-input", "working", "error"][..]),
                    ] {
                        if let Some(t) = table.get(section).and_then(|v| v.as_table()) {
                            for key in t.keys().filter(|k| !keys.contains(&k.as_str())) {
                                warnings.push(DefinitionError {
                                    file: file.clone(),
                                    line: None,
                                    message: format!("The key {section}.{key} is unknown and was ignored."),
                                });
                            }
                        }
                    }
                }
                if let Some(table) = patch.as_table_mut() {
                    table.retain(|key, _| KEYS.contains(&key));
                    for (section, keys) in [
                        ("usage", &["source"][..]),
                        ("status-patterns", &["needs-input", "working", "error"][..]),
                    ] {
                        if let Some(nested) = table.get_mut(section).and_then(|v| v.as_table_mut()) {
                            nested.retain(|key, _| keys.contains(&key));
                        }
                    }
                }
                let id = known_id.as_deref().ok_or_else(|| DefinitionError {
                    file: file.clone(),
                    line: None,
                    message: "The definition must include an id.".into(),
                })?;
                let mut value = values
                    .get(id)
                    .cloned()
                    .unwrap_or(toml::Value::Table(Default::default()));
                merge(&mut value, patch);
                decode(value.clone(), &file).map(|d| (value, d))
            });
            match result {
                Ok((value, definition)) => {
                    if let Some(entry) = catalog.entries.iter_mut().find(|e| e.definition.id == definition.id) {
                        entry.definition = definition.clone();
                        entry.source = "override".into();
                        entry.errors.extend(warnings.clone());
                    } else {
                        catalog.entries.push(CatalogEntry {
                            definition: definition.clone(),
                            source: "user".into(),
                            errors: warnings.clone(),
                        });
                    }
                    values.insert(definition.id.clone(), value);
                }
                Err(e) => {
                    if let Some(entry) = catalog
                        .entries
                        .iter_mut()
                        .find(|e| Some(&e.definition.id) == known_id.as_ref())
                    {
                        entry.errors.push(e.clone());
                    }
                    if let Some(id) = &known_id {
                        catalog.rejected_ids.insert(id.clone(), e.clone());
                    }
                    catalog.errors.push(e);
                }
            }
            catalog.errors.extend(warnings);
        }
        catalog
    }
}

/// Custom-definition ids name files in the user agents directory: lower-case letters, digits and
/// dashes only, so a saved definition can never write outside `<config>/agents/`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
/// Whether the id belongs to a bundled definition; a user file may only reuse one as an explicit override.
pub fn is_bundled_id(id: &str) -> bool {
    BUNDLED.iter().any(|(bundled, _)| *bundled == id)
}
/// The dialog cannot edit these sections; a re-save keeps them when the file already had them.
fn preserved_extras(
    previous: Option<&str>,
    def: &AgentDefinition,
) -> (BTreeMap<String, Vec<String>>, BTreeMap<String, String>) {
    let mut status_patterns = def.status_patterns.clone();
    let mut usage = def.usage.clone();
    if let Some(text) = previous
        && let Ok(value) = toml::from_str::<toml::Value>(text)
    {
        if status_patterns.is_empty()
            && let Some(table) = value.get("status-patterns")
        {
            status_patterns = table.clone().try_into().unwrap_or_default();
        }
        if usage.is_empty()
            && let Some(table) = value.get("usage")
        {
            usage = table.clone().try_into().unwrap_or_default();
        }
    }
    (status_patterns, usage)
}
/// Serialization order puts every table last so `toml::to_string` emits valid TOML.
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
struct FileRepr<'a> {
    id: &'a str,
    name: &'a str,
    binaries: &'a [String],
    version_cmd: &'a [String],
    prompt_mode: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_flag: Option<&'a str>,
    resume: &'a [String],
    yolo_flags: &'a [String],
    hooks: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ready_pattern: Option<&'a str>,
    install_url: &'a str,
    docs_url: &'a str,
    icon: &'a str,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    status_patterns: &'a BTreeMap<String, Vec<String>>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    usage: &'a BTreeMap<String, String>,
}
/// Write `<config>/agents/<id>.toml` atomically (temp file then rename), backing an existing file up as
/// `<id>.toml.bak`. Validation runs first; the id charset keeps the write inside the agents directory.
pub fn save_definition(config_dir: &Path, def: &AgentDefinition) -> Result<PathBuf, String> {
    def.validate()?;
    if !valid_id(&def.id) {
        return Err(format!(
            "The id {:?} may only use lower-case letters, digits and dashes.",
            def.id
        ));
    }
    let directory = config_dir.join("agents");
    std::fs::create_dir_all(&directory).map_err(|e| format!("The agents directory could not be created: {e}."))?;
    let path = directory.join(format!("{}.toml", def.id));
    let previous = std::fs::read_to_string(&path).ok();
    let (status_patterns, usage) = preserved_extras(previous.as_deref(), def);
    let text = toml::to_string_pretty(&FileRepr {
        id: &def.id,
        name: &def.name,
        binaries: &def.binaries,
        version_cmd: &def.version_cmd,
        prompt_mode: &def.prompt_mode,
        model_flag: def.model_flag.as_deref(),
        resume: &def.resume,
        yolo_flags: &def.yolo_flags,
        hooks: &def.hooks,
        ready_pattern: def.ready_pattern.as_deref(),
        install_url: &def.install_url,
        docs_url: &def.docs_url,
        icon: &def.icon,
        status_patterns: &status_patterns,
        usage: &usage,
    })
    .map_err(|e| format!("The definition could not be encoded: {e}."))?;
    if previous.is_some() {
        let backup = directory.join(format!("{}.toml.bak", def.id));
        std::fs::copy(&path, &backup).map_err(|e| format!("The existing definition could not be backed up: {e}."))?;
    }
    // The dot-prefixed temp name never matches the loader's `*.toml` filter.
    let temp = directory.join(format!(".{}.{}.tmp", def.id, std::process::id()));
    let write = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temp, &path)
    })();
    if write.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    write.map_err(|e| format!("The definition could not be written: {e}."))?;
    Ok(path)
}
/// Remove `<config>/agents/<id>.toml`; returns whether a file was removed. Refuses unsafe ids.
pub fn delete_definition(config_dir: &Path, id: &str) -> Result<bool, String> {
    if !valid_id(id) {
        return Err(format!(
            "The id {id:?} may only use lower-case letters, digits and dashes."
        ));
    }
    let path = config_dir.join("agents").join(format!("{id}.toml"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("The definition could not be deleted: {e}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_validate_and_ids_are_unique() {
        let tmp = tempfile::tempdir().unwrap();
        let catalog = Catalog::load(tmp.path());
        assert!(catalog.errors.is_empty(), "{:?}", catalog.errors);
        assert_eq!(catalog.entries.len(), 10);
        let ids: std::collections::BTreeSet<_> = catalog.entries.iter().map(|e| &e.definition.id).collect();
        assert_eq!(ids.len(), 10);
    }
    fn overridden(text: &str) -> Catalog {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("agents")).unwrap();
        std::fs::write(tmp.path().join("agents/test.toml"), text).unwrap();
        Catalog::load(tmp.path())
    }
    #[test]
    fn partial_override_preserves_fields_and_reports_unknown_keys() {
        let c = overridden("id = 'claude'\nname = 'Custom'\nunknown = true");
        let entry = &c.entries[0];
        assert_eq!(entry.definition.name, "Custom");
        assert_eq!(entry.definition.binaries, ["claude"]);
        assert_eq!(entry.source, "override");
        assert_eq!(c.errors.len(), 1);
    }
    #[test]
    fn nested_unknown_patterns_are_ignored_and_tables_merge() {
        let catalog =
            overridden("id='claude'\n[status-patterns]\nerror=['error:']\nunknown=['[']\n[usage]\nunknown='ignored'");
        assert_eq!(catalog.errors.len(), 2);
        assert_eq!(
            catalog.entries[0].definition.usage.get("source").map(String::as_str),
            Some("claude-jsonl")
        );
        assert!(!catalog.entries[0].definition.status_patterns.contains_key("unknown"));
        assert_eq!(catalog.entries[0].source, "override");
    }
    #[test]
    fn invalid_override_preserves_bundled_agent() {
        for text in [
            "id='claude'\nname=''",
            "id='claude'\nbinaries=[]",
            "id='claude'\nready-pattern='['",
            "id='claude'\nresume=['{other}']",
        ] {
            let c = overridden(text);
            assert!(!c.errors.is_empty());
            assert_eq!(c.entries[0].definition.name, "Claude Code");
            assert_eq!(c.entries[0].source, "bundled");
        }
        let c = overridden("id='claude'\nready-pattern='['");
        assert!(c.errors[0].message.contains("ready-pattern"));
        assert!(c.errors[0].message.contains("regex"));
    }
    #[test]
    fn new_user_definition_and_syntax_diagnostics() {
        let c = overridden(&BUNDLED[0].1.replace("id = \"claude\"", "id = \"custom\""));
        assert_eq!(c.entries.len(), 11);
        assert_eq!(c.entries.last().unwrap().source, "user");
        let c = overridden("id = [");
        assert_eq!(c.errors[0].line, Some(1));
        assert_eq!(c.entries.len(), 10);
    }

    fn custom_def(id: &str) -> AgentDefinition {
        AgentDefinition {
            id: id.into(),
            name: "Test Agent".into(),
            binaries: vec!["testagent".into(), "testagent-cli".into()],
            version_cmd: vec!["testagent".into(), "--version".into()],
            prompt_mode: "arg".into(),
            model_flag: Some("--model".into()),
            resume: vec![],
            yolo_flags: vec!["--yolo".into()],
            hooks: "none".into(),
            ready_pattern: Some("ready>".into()),
            status_patterns: BTreeMap::new(),
            usage: BTreeMap::new(),
            install_url: "testagent".into(),
            docs_url: "https://".into(),
            icon: "bot".into(),
        }
    }
    #[test]
    fn save_round_trips_through_the_catalog() {
        let tmp = tempfile::tempdir().unwrap();
        let def = custom_def("my-agent-1");
        let path = save_definition(tmp.path(), &def).unwrap();
        assert_eq!(path, tmp.path().join("agents/my-agent-1.toml"));
        let catalog = Catalog::load(tmp.path());
        assert!(catalog.errors.is_empty(), "{:?}", catalog.errors);
        assert_eq!(catalog.entries.len(), 11);
        let entry = catalog.entries.last().unwrap();
        assert_eq!(entry.source, "user");
        assert_eq!(entry.definition.name, "Test Agent");
        assert_eq!(entry.definition.binaries, def.binaries);
        assert_eq!(entry.definition.version_cmd, def.version_cmd);
        assert_eq!(entry.definition.prompt_mode, "arg");
        assert_eq!(entry.definition.model_flag.as_deref(), Some("--model"));
        assert_eq!(entry.definition.yolo_flags, ["--yolo"]);
        assert_eq!(entry.definition.ready_pattern.as_deref(), Some("ready>"));
        assert_eq!(entry.definition.hooks, "none");
        // Saving the same definition again is an update, not a duplicate.
        save_definition(tmp.path(), &def).unwrap();
        assert_eq!(Catalog::load(tmp.path()).entries.len(), 11);
    }
    #[test]
    fn save_refuses_invalid_regex_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let mut def = custom_def("bad-regex");
        def.ready_pattern = Some("[".into());
        let error = save_definition(tmp.path(), &def).unwrap_err();
        assert!(error.contains("ready-pattern"), "{error}");
        assert!(!tmp.path().join("agents").exists());
    }
    #[test]
    fn save_refuses_bundled_and_unsafe_ids() {
        assert!(is_bundled_id("claude"));
        assert!(!is_bundled_id("my-agent"));
        assert!(valid_id("agent-2"));
        let tmp = tempfile::tempdir().unwrap();
        for id in ["", "Claude", "a/b", "../x", "a b", "a.b", "a_b", &"x".repeat(65)] {
            assert!(!valid_id(id), "{id}");
            let mut def = custom_def("safe");
            def.id = id.into();
            assert!(save_definition(tmp.path(), &def).is_err(), "{id}");
        }
        // Refused saves never even create the agents directory.
        assert!(!tmp.path().join("agents").exists());
    }
    #[test]
    fn unsafe_ids_write_nothing_outside_the_agents_dir() {
        for id in ["../escape", "a/b", ".."] {
            let tmp = tempfile::tempdir().unwrap();
            let mut def = custom_def("safe");
            def.id = id.into();
            assert!(save_definition(tmp.path(), &def).is_err());
            assert!(delete_definition(tmp.path(), id).is_err());
            // Only an (empty) agents dir may exist; nothing landed beside it.
            let entries: Vec<_> = std::fs::read_dir(tmp.path())
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert!(
                entries.iter().all(|n| n == "agents"),
                "unexpected entries for {id}: {entries:?}"
            );
        }
    }
    #[test]
    fn resave_backs_up_and_leaves_no_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        let mut def = custom_def("versioned");
        save_definition(tmp.path(), &def).unwrap();
        def.name = "Renamed".into();
        save_definition(tmp.path(), &def).unwrap();
        let backup = std::fs::read_to_string(tmp.path().join("agents/versioned.toml.bak")).unwrap();
        assert!(backup.contains("Test Agent"));
        let mut names: Vec<_> = std::fs::read_dir(tmp.path().join("agents"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["versioned.toml", "versioned.toml.bak"]);
    }
    #[test]
    fn resave_preserves_status_patterns_and_usage() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("agents")).unwrap();
        std::fs::write(
            tmp.path().join("agents/tuned.toml"),
            "id='tuned'\nname='Tuned'\nbinaries=['t']\nversion-cmd=['t','--version']\nprompt-mode='type'\nhooks='none'\ninstall-url='t'\ndocs-url='https://'\nicon='bot'\n[status-patterns]\nneeds-input=['needs you']\n[usage]\nsource='custom-jsonl'\n",
        )
        .unwrap();
        let mut def = custom_def("tuned");
        def.name = "Tuned v2".into();
        save_definition(tmp.path(), &def).unwrap();
        let entry = Catalog::load(tmp.path())
            .entries
            .into_iter()
            .find(|e| e.definition.id == "tuned")
            .unwrap();
        assert_eq!(entry.definition.name, "Tuned v2");
        assert_eq!(
            entry.definition.status_patterns.get("needs-input").map(Vec::as_slice),
            Some(&["needs you".to_string()][..])
        );
        assert_eq!(
            entry.definition.usage.get("source").map(String::as_str),
            Some("custom-jsonl")
        );
    }
    #[test]
    fn delete_removes_only_the_definition_file() {
        let tmp = tempfile::tempdir().unwrap();
        save_definition(tmp.path(), &custom_def("doomed")).unwrap();
        assert!(delete_definition(tmp.path(), "doomed").unwrap());
        assert!(!tmp.path().join("agents/doomed.toml").exists());
        assert!(!delete_definition(tmp.path(), "doomed").unwrap());
        assert!(delete_definition(tmp.path(), "../x").is_err());
        // The bundled catalog is untouched by user-file deletion.
        assert_eq!(Catalog::load(tmp.path()).entries.len(), 10);
    }
}
