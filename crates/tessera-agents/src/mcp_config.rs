//! Explicit-root, preview-first MCP and Markdown edits. No process-global HOME or secret storage here.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize, Deserialize)]
pub struct Spec {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub env_keys: Vec<String>,
}
pub struct Plan {
    pub path: PathBuf,
    original: Option<String>,
    after: String,
    pub preview: String,
    remove_file: bool,
}
fn marker(id: &str) -> Result<String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("Invalid managed identifier.".into());
    }
    Ok(format!("tessera:{id}"))
}
pub fn read(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not inspect the target file.".into()),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
            return Err("Refusing a symlink or non-regular target file.".into());
        }
        _ => {}
    }
    let mut s = String::new();
    fs::File::open(path)
        .map_err(|_| "Could not open target.")?
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut s)
        .map_err(|_| "The target is not readable UTF-8.")?;
    if s.len() > 4 * 1024 * 1024 {
        return Err("The config exceeds 4 MiB.".into());
    }
    Ok(Some(s))
}
pub fn target(root: &Path, relative: &str) -> Result<PathBuf> {
    if root.to_string_lossy().starts_with("ssh:") {
        return Err("Remote worktree installs are not supported yet.".into());
    }
    if Path::new(relative)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Unsafe install path.".into());
    }
    let root = fs::canonicalize(root).map_err(|_| "The install root does not exist.")?;
    let mut path = root;
    for part in Path::new(relative).components() {
        path.push(part);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Refusing a symlink in the install path.".into());
        }
    }
    Ok(path)
}
pub fn config_path(home: &Path, project: Option<&Path>, agent: &str) -> Result<PathBuf> {
    let relative = match (agent, project.is_some()) {
        ("claude", true) => ".mcp.json",
        ("claude", false) => ".claude.json",
        ("codex", false) => ".codex/config.toml",
        ("gemini", _) => ".gemini/settings.json",
        ("opencode", true) => "opencode.json",
        ("opencode", false) => ".config/opencode/opencode.json",
        _ => return Err("Manual configuration required for this agent/scope.".into()),
    };
    target(project.unwrap_or(home), relative)
}
fn entry(spec: &Spec, agent: &str, values: &BTreeMap<String, String>, write_values: bool, project: bool) -> Value {
    let mut env = serde_json::Map::new();
    for key in &spec.env_keys {
        if write_values {
            if let Some(v) = values.get(key) {
                env.insert(key.clone(), json!(v));
            }
        } else if agent != "claude" || project {
            env.insert(
                key.clone(),
                json!(if agent == "opencode" {
                    format!("{{env:{key}}}")
                } else {
                    format!("${{{key}}}")
                }),
            );
        }
    }
    let mut v = if spec.transport == "http" {
        match agent {
            "gemini" => json!({"httpUrl":spec.url}),
            "opencode" => json!({"type":"remote","url":spec.url}),
            _ => json!({"type":"http","url":spec.url}),
        }
    } else if agent == "opencode" {
        let mut command = vec![spec.command.clone()];
        command.extend(spec.args.clone());
        json!({"type":"local","command":command,"environment":env})
    } else {
        json!({"command":spec.command,"args":spec.args,"env":env})
    };
    if agent != "opencode" {
        v["_tessera"] = json!(format!("tessera:{}", spec.id));
    }
    v
}
pub fn snippet(spec: &Spec, agent: &str) -> String {
    if agent == "codex" && spec.transport == "http" {
        format!("[mcp_servers.{}]\nurl = {:?}\n", spec.name, spec.url)
    } else if agent == "codex" {
        format!(
            "[mcp_servers.{}]\ncommand = {:?}\nargs = {:?}\nenv_vars = {:?}\n",
            spec.name, spec.command, spec.args, spec.env_keys
        )
    } else {
        serde_json::to_string_pretty(&json!({"mcpServers":{&spec.name:entry(spec,agent,&BTreeMap::new(),false,true)}}))
            .unwrap()
    }
}
fn block(text: &str, tag: &str) -> Result<(String, bool)> {
    let start = format!("# >>> {tag} >>>");
    let end = format!("# <<< {tag} <<<");
    match (text.find(&start), text.find(&end)) {
        (None, None) => Ok((text.into(), false)),
        (Some(a), Some(b)) if b > a && text.matches(&start).count() == 1 && text.matches(&end).count() == 1 => Ok((
            format!(
                "{}{}",
                &text[..a],
                text[b + end.len()..]
                    .strip_prefix('\n')
                    .unwrap_or(&text[b + end.len()..])
            ),
            true,
        )),
        _ => Err("The managed markers are incomplete or duplicated.".into()),
    }
}
pub fn plan_mcp(
    home: &Path,
    project: Option<&Path>,
    agent: &str,
    spec: &Spec,
    values: &BTreeMap<String, String>,
    write_values: bool,
    remove: bool,
) -> Result<Plan> {
    let path = config_path(home, project, agent)?;
    let original = read(&path)?;
    let before = original.as_deref().unwrap_or("");
    let tag = marker(&spec.id)?;
    let after = if agent == "codex" {
        let parsed: toml::Value =
            toml::from_str(before).map_err(|_| "Existing TOML is invalid; nothing was changed.")?;
        let (clean, owned) = block(before, &tag)?;
        if parsed.get("mcp_servers").and_then(|v| v.get(&spec.name)).is_some() && !owned {
            return Err("A foreign server already uses this name.".into());
        }
        if remove {
            if !owned {
                return Err("No matching Tessera marker; nothing was removed.".into());
            }
            clean
        } else {
            let mut table = toml::map::Map::new();
            if spec.transport == "http" {
                table.insert("url".into(), toml::Value::String(spec.url.clone()));
            } else {
                table.insert("command".into(), toml::Value::String(spec.command.clone()));
                table.insert(
                    "args".into(),
                    toml::Value::try_from(&spec.args).map_err(|_| "Invalid args.")?,
                );
                if write_values {
                    table.insert("env".into(), toml::Value::try_from(values).map_err(|_| "Invalid env.")?);
                } else {
                    table.insert(
                        "env_vars".into(),
                        toml::Value::try_from(&spec.env_keys).map_err(|_| "Invalid env names.")?,
                    );
                }
            }
            let payload =
                toml::to_string(&json!({"mcp_servers":{&spec.name:table}})).map_err(|_| "Could not encode TOML.")?;
            format!("{}\n# >>> {tag} >>>\n{payload}# <<< {tag} <<<\n", clean.trim_end())
        }
    } else {
        let mut config: Value = if original.is_none() {
            json!({})
        } else {
            strict_json(before)?
        };
        let root = config.as_object_mut().ok_or("Config root must be an object.")?;
        let servers = if agent == "opencode" {
            root.entry("mcp")
                .or_insert(json!({}))
                .as_object_mut()
                .ok_or("mcp must be an object.")?
                .entry("servers")
                .or_insert(json!({}))
        } else {
            root.entry("mcpServers").or_insert(json!({}))
        }
        .as_object_mut()
        .ok_or("MCP servers must be an object.")?;
        let owned = servers
            .iter()
            .filter(|(key, v)| {
                if agent == "opencode" {
                    key.as_str() == tag
                } else {
                    v["_tessera"] == tag
                }
            })
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>();
        if remove && owned.is_empty() {
            return Err("No matching Tessera marker; nothing was removed.".into());
        }
        let entry_name = if agent == "opencode" { &tag } else { &spec.name };
        if servers
            .get(entry_name)
            .is_some_and(|v| agent != "opencode" && v["_tessera"] != tag)
            && !remove
        {
            return Err("A foreign server already uses this name.".into());
        }
        for key in owned {
            servers.remove(&key);
        }
        if !remove {
            servers.insert(
                entry_name.clone(),
                entry(spec, agent, values, write_values, project.is_some()),
            );
        }
        format!(
            "{}\n",
            serde_json::to_string_pretty(&config).map_err(|_| "Could not encode JSON.")?
        )
    };
    if agent == "codex" {
        toml::from_str::<toml::Value>(&after).map_err(|_| "The edit would create invalid TOML.")?;
    }
    let preview = if remove {
        format!("Remove only {tag} from {}", path.display())
    } else {
        let mut preview = if agent == "codex" {
            let parsed: toml::Value = toml::from_str(&after).map_err(|_| "Invalid TOML preview.")?;
            toml::to_string(&json!({"mcp_servers":{&spec.name:parsed["mcp_servers"][&spec.name].clone()}}))
                .map_err(|_| "Invalid TOML preview.")?
        } else {
            let key = if agent == "opencode" { &tag } else { &spec.name };
            serde_json::to_string_pretty(&json!({key:entry(spec,agent,values,write_values,project.is_some())}))
                .map_err(|_| "Invalid JSON preview.")?
        };
        for value in values.values().filter(|v| !v.is_empty()) {
            preview = preview.replace(value, "<redacted>");
        }
        preview
    };
    Ok(Plan {
        path,
        original,
        after,
        preview,
        remove_file: false,
    })
}
pub fn plan_skill(root: &Path, id: &str, name: &str, kind: &str, body: &str, remove: bool, home: bool) -> Result<Plan> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid skill name.".into());
    }
    let relative = match (kind, home) {
        ("agents_md", true) => ".codex/AGENTS.md".into(),
        ("agents_md", false) => "AGENTS.md".into(),
        ("claude_skill", _) => format!(".claude/skills/{name}/SKILL.md"),
        ("rules_file", _) => format!(".claude/rules/{name}.md"),
        _ => return Err("Unknown skill kind.".into()),
    };
    let path = target(root, &relative)?;
    let original = read(&path)?;
    let before = original.as_deref().unwrap_or("");
    let tag = marker(id)?;
    let start = format!("<!-- >>> {tag} >>> -->");
    let end = format!("<!-- <<< {tag} <<< -->");
    let clean = match (before.find(&start), before.find(&end)) {
        (None, None) if kind == "agents_md" || before.is_empty() => before.to_string(),
        (Some(a), Some(b)) if b > a && before.matches(&start).count() == 1 && before.matches(&end).count() == 1 => {
            format!("{}{}", &before[..a], &before[b + end.len()..])
        }
        _ => return Err("Foreign content or invalid markers; refusing to replace this skill file.".into()),
    };
    if remove && !before.contains(&start) {
        return Err("No matching Tessera marker; nothing was removed.".into());
    }
    let frontmatter = format!("---\nname: {name}\ndescription: Tessera managed skill {name}\n---\n");
    if kind != "agents_md" && before.contains(&start) {
        let permitted = if kind == "claude_skill" {
            clean.trim() == frontmatter.trim()
        } else {
            clean.trim().is_empty()
        };
        if !permitted {
            return Err("Foreign content surrounds this managed skill; refusing to replace it.".into());
        }
    }
    let after = if remove {
        if kind == "agents_md" { clean } else { String::new() }
    } else if kind == "claude_skill" {
        format!("{frontmatter}{start}\n{body}\n{end}\n")
    } else {
        format!("{}\n{start}\n{body}\n{end}\n", clean.trim_end())
    };
    Ok(Plan {
        path,
        original,
        preview: after.clone(),
        remove_file: remove && kind != "agents_md",
        after,
    })
}
impl Plan {
    pub fn apply(self) -> Result<PathBuf> {
        let parent = self.path.parent().ok_or("No parent directory.")?;
        if parent
            .ancestors()
            .any(|p| fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
        {
            return Err("Refusing a symlink in the install path.".into());
        }
        fs::create_dir_all(parent).map_err(|_| "Could not create target directory.")?;
        let lock = self.path.with_extension("tessera-lock");
        let guard = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .map_err(|_| "This file is being edited. Retry after its current writer finishes.")?;
        let result = (|| {
            if read(&self.path)? != self.original {
                return Err("The target changed after preview. Preview it again.".into());
            }
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let serial = NEXT.fetch_add(1, Ordering::Relaxed);
            let backup = PathBuf::from(format!("{}.tessera.bak-{stamp}-{serial}", self.path.display()));
            write_new(&backup, self.original.as_deref().unwrap_or(""))?;
            if self.remove_file {
                fs::remove_file(&self.path).map_err(|_| "Could not remove the managed file.")?;
                return Ok(backup);
            }
            let temp = PathBuf::from(format!(
                "{}.tessera.tmp-{}-{serial}",
                self.path.display(),
                std::process::id()
            ));
            write_new(&temp, &self.after)?;
            if fs::rename(&temp, &self.path).is_err() {
                let _ = fs::remove_file(&temp);
                return Err("Atomic replacement failed; the original and backup were kept.".into());
            }
            Ok(backup)
        })();
        drop(guard);
        let _ = fs::remove_file(lock);
        result
    }
}
fn write_new(path: &Path, text: &str) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options
        .open(path)
        .map_err(|_| "Could not create a backup or temporary file.")?;
    f.write_all(text.as_bytes())
        .and_then(|_| f.sync_all())
        .map_err(|_| "Could not finish writing file.".to_string())
}
// Reject duplicate keys as well as syntax errors; otherwise serializing could silently drop a foreign entry.
fn strict_json(text: &str) -> Result<Value> {
    struct Checked(Value);
    impl<'de> serde::Deserialize<'de> for Checked {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Checked;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("JSON without duplicate keys")
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(self, mut a: A) -> std::result::Result<Checked, A::Error> {
                    let mut result = serde_json::Map::new();
                    while let Some((k, v)) = a.next_entry::<String, Checked>()? {
                        if result.insert(k, v.0).is_some() {
                            return Err(serde::de::Error::custom("duplicate key"));
                        }
                    }
                    Ok(Checked(Value::Object(result)))
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Checked, A::Error> {
                    let mut result = Vec::new();
                    while let Some(v) = a.next_element::<Checked>()? {
                        result.push(v.0)
                    }
                    Ok(Checked(Value::Array(result)))
                }
                fn visit_bool<E: serde::de::Error>(self, v: bool) -> std::result::Result<Checked, E> {
                    Ok(Checked(json!(v)))
                }
                fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Checked, E> {
                    Ok(Checked(json!(v)))
                }
                fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Checked, E> {
                    Ok(Checked(json!(v)))
                }
                fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Checked, E> {
                    Ok(Checked(json!(v)))
                }
                fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Checked, E> {
                    Ok(Checked(json!(v)))
                }
                fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Checked, E> {
                    Ok(Checked(Value::Null))
                }
                fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Checked, E> {
                    Ok(Checked(Value::Null))
                }
            }
            d.deserialize_any(Visitor)
        }
    }
    serde_json::from_str::<Checked>(text)
        .map(|v| v.0)
        .map_err(|_| "Existing JSON is invalid or contains duplicate keys; nothing was changed.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec() -> Spec {
        Spec {
            id: "fixture".into(),
            name: "demo".into(),
            transport: "stdio".into(),
            command: "fixture".into(),
            args: vec!["--literal".into()],
            url: "".into(),
            env_keys: vec!["TOKEN".into()],
        }
    }
    #[test]
    fn formats_backups_markers_and_foreign_entries() {
        let tmp = tempfile::tempdir().unwrap();
        for agent in ["claude", "codex", "gemini", "opencode"] {
            let p = config_path(tmp.path(), None, agent).unwrap();
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            let original = if agent == "codex" {
                "model = 'foreign'\n[mcp_servers.foreign]\ncommand='kept'\n"
            } else if agent == "opencode" {
                r#"{"mcp":{"servers":{"foreign":{"type":"local","command":["kept"]}}},"foreign":42}"#
            } else {
                r#"{"mcpServers":{"foreign":{"command":"kept"}},"foreign":42}"#
            };
            fs::write(&p, original).unwrap();
            let plan = plan_mcp(tmp.path(), None, agent, &spec(), &BTreeMap::new(), false, false).unwrap();
            let backup = plan.apply().unwrap();
            assert_eq!(fs::read_to_string(backup).unwrap(), original);
            assert!(fs::read_to_string(&p).unwrap().contains("tessera:fixture"));
            plan_mcp(tmp.path(), None, agent, &spec(), &BTreeMap::new(), false, true)
                .unwrap()
                .apply()
                .unwrap();
            assert!(fs::read_to_string(&p).unwrap().contains("foreign"));
            assert!(!fs::read_to_string(&p).unwrap().contains("tessera:fixture"));
            fs::write(&p, "{invalid").unwrap();
            assert!(plan_mcp(tmp.path(), None, agent, &spec(), &BTreeMap::new(), false, false).is_err());
            assert_eq!(fs::read_to_string(&p).unwrap(), "{invalid");
        }
    }
    #[test]
    fn skill_markers_stale_preview_and_remote_refusal() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("AGENTS.md"), "Foreign rules\n").unwrap();
        let p = plan_skill(tmp.path(), "fixture", "review", "agents_md", "# Review", false, false).unwrap();
        p.apply().unwrap();
        let p = plan_skill(tmp.path(), "fixture", "review", "agents_md", "", true, false).unwrap();
        p.apply().unwrap();
        assert!(
            fs::read_to_string(tmp.path().join("AGENTS.md"))
                .unwrap()
                .contains("Foreign rules")
        );
        let plan = plan_skill(tmp.path(), "fixture", "review", "agents_md", "# new", false, false).unwrap();
        fs::write(tmp.path().join("AGENTS.md"), "changed").unwrap();
        assert!(plan.apply().is_err());
        assert!(target(Path::new("ssh://host/work"), "AGENTS.md").is_err());
        assert!(target(tmp.path(), "../outside").is_err());
    }
    #[test]
    fn literal_env_duplicate_json_and_skill_file_uninstall() {
        let tmp = tempfile::tempdir().unwrap();
        let values = BTreeMap::from([("TOKEN".into(), "secret-value-fixture".into())]);
        let plan = plan_mcp(tmp.path(), None, "gemini", &spec(), &values, true, false).unwrap();
        assert!(!plan.preview.contains("secret-value-fixture"));
        let path = plan.path.clone();
        plan.apply().unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("secret-value-fixture"));
        fs::write(&path, r#"{"mcpServers":{},"mcpServers":{"foreign":{}}}"#).unwrap();
        assert!(plan_mcp(tmp.path(), None, "gemini", &spec(), &values, false, false).is_err());
        for kind in ["claude_skill", "rules_file"] {
            let plan = plan_skill(tmp.path(), "fixture", "review", kind, "# Body", false, false).unwrap();
            let path = plan.path.clone();
            plan.apply().unwrap();
            plan_skill(tmp.path(), "fixture", "review", kind, "", true, false)
                .unwrap()
                .apply()
                .unwrap();
            assert!(!path.exists());
        }
    }
}
