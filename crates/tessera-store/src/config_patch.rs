//! Validated, source-preserving settings patches and atomic file replacement.

use crate::{
    Config, ConfigError,
    config::{parse_config, read_config},
    config_document::Document,
};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

/// Applies section/leaf updates without rewriting untouched source text.
/// Existing values use parser byte spans, including quoted keys and inline tables.
/// A renamed setting is updated in its original spelling until the user migrates it.
///
/// # Errors
/// Rejects invalid input, unknown patch keys, unsupported insertions and invalid results.
/// The caller's source remains unchanged on every error.
pub fn patch_config(text: &str, patch: &toml::Table) -> Result<String, ConfigError> {
    parse_config(text)?;
    let defaults = toml::Value::try_from(Config::default()).map_err(|e| ConfigError::Invalid {
        key: String::new(),
        line: 1,
        message: e.to_string(),
    })?;
    let mut result = text.to_owned();
    for (section, values) in patch {
        let document = Document::parse(&result)?;
        let known = defaults
            .get(section)
            .and_then(toml::Value::as_table)
            .ok_or_else(|| document.invalid(&[section], "unknown patch section"))?;
        let values = values
            .as_table()
            .ok_or_else(|| document.invalid(&[section], "expected a section patch"))?;
        for (key, value) in values {
            let document = Document::parse(&result)?;
            if !known.contains_key(key) {
                return Err(document.invalid(&[section, key], "unknown patch key; use the canonical setting name"));
            }
            // Validate one changed setting independently, before any write.
            let single = toml::Table::from_iter([(
                section.clone(),
                toml::Value::Table(toml::Table::from_iter([(key.clone(), value.clone())])),
            )]);
            let single = toml::to_string(&single).map_err(|e| document.invalid(&[section, key], e.to_string()))?;
            let proposed = parse_config(&single)?;
            let current = parse_config(&result)?;
            let serialized = |config| {
                toml::Value::try_from(config).map_err(|error| document.invalid(&[section, key], error.to_string()))
            };
            if serialized(proposed)?.get(section).and_then(|section| section.get(key))
                == serialized(current)?.get(section).and_then(|section| section.get(key))
            {
                continue;
            }
            let actual = match (section.as_str(), key.as_str()) {
                ("font", "size") if document.value(&["terminal", "font_size"]).is_some() => ["terminal", "font_size"],
                ("terminal", "scrollback") if document.value(&["terminal", "scrollback_lines"]).is_some() => {
                    ["terminal", "scrollback_lines"]
                }
                _ => [section.as_str(), key.as_str()],
            };
            let replacement = value.to_string();
            if let Some(existing) = document.value(&actual) {
                let span = existing.span();
                result.replace_range(span, &replacement);
            } else {
                result = insert(&document, section, key, &replacement)?;
            }
        }
    }
    // Guard all insertion/layout assumptions with the real parser before touching disk.
    parse_config(&result)?;
    Ok(result)
}

fn insert(document: &Document<'_>, section: &str, key: &str, value: &str) -> Result<String, ConfigError> {
    let text = document.text;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let quoted_key = toml::Value::String(key.into()).to_string();
    let quoted_section = toml::Value::String(section.into()).to_string();
    let mut result = text.to_owned();
    if let Some(table) = document.value(&[section]) {
        let span = table.span();
        let source = &text[span.clone()];
        if source.starts_with('{') && source.ends_with('}') {
            let separator = if source[..source.len() - 1].trim_end().ends_with(['{', ',']) {
                " "
            } else {
                ", "
            };
            result.insert_str(span.end - 1, &format!("{separator}{quoted_key} = {value} "));
            return Ok(result);
        }
        let headers = headers(document);
        if let Some((index, _)) = headers
            .iter()
            .enumerate()
            .find(|(_, (_, name))| name.as_deref() == Some(section))
        {
            let at = headers.get(index + 1).map_or(text.len(), |(at, _)| *at);
            let prefix = if at > 0 && !text[..at].ends_with('\n') {
                newline
            } else {
                ""
            };
            result.insert_str(at, &format!("{prefix}{quoted_key} = {value}{newline}"));
        } else {
            // An implicit table created with dotted keys: extend it before any table header.
            let at = headers.first().map_or(text.len(), |(at, _)| *at);
            let prefix = if at > 0 && !text[..at].ends_with('\n') {
                newline
            } else {
                ""
            };
            result.insert_str(at, &format!("{prefix}{quoted_section}.{quoted_key} = {value}{newline}"));
        }
    } else {
        let prefix = if text.is_empty() || text.ends_with('\n') {
            ""
        } else {
            newline
        };
        result.push_str(&format!(
            "{prefix}{newline}[{quoted_section}]{newline}{quoted_key} = {value}{newline}"
        ));
    }
    Ok(result)
}

fn headers(document: &Document<'_>) -> Vec<(usize, Option<String>)> {
    fn spans(value: &toml::Spanned<toml::de::DeValue<'_>>, out: &mut Vec<std::ops::Range<usize>>) {
        if let Some(table) = value.get_ref().as_table() {
            for value in table.values() {
                spans(value, out);
            }
        } else {
            out.push(value.span());
        }
    }
    let mut values = Vec::new();
    for value in document.root.get_ref().values() {
        spans(value, &mut values);
    }
    let mut offset = 0;
    document
        .text
        .split_inclusive('\n')
        .filter_map(|line| {
            let at = offset;
            offset += line.len();
            if !line.trim_start().starts_with('[') || values.iter().any(|span| span.contains(&at)) {
                return None;
            }
            let parsed = toml::de::DeTable::parse(line).ok()?;
            let section = if line.trim_start().starts_with("[[") {
                None
            } else {
                parsed.get_ref().keys().next().map(|key| key.get_ref().to_string())
            };
            Some((at, section))
        })
        .collect()
}

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

/// Validates a patch, preserves source formatting and atomically replaces the file.
/// A no-op patch does not touch the file. Existing permissions are preserved.
///
/// # Errors
/// Returns parsing, validation, write or concurrent-edit errors; never truncates the original.
pub fn write_config_patch(path: &Path, patch: &toml::Table) -> Result<Config, ConfigError> {
    let original = read_config(path)?;
    let updated = patch_config(&original, patch)?;
    let config = parse_config(&updated)?;
    if original == updated {
        return Ok(config);
    }
    let io = |source| ConfigError::Write {
        path: path.into(),
        source,
    };
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(io(std::io::Error::other(
            "refusing to replace a symlink; edit the target file directly",
        )));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = parent.join(format!(
        ".tessera-config-{}-{}.tmp",
        std::process::id(),
        NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io)?;
    let write = (|| {
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions()).map_err(io)?;
        }
        file.write_all(updated.as_bytes()).map_err(io)?;
        file.sync_all().map_err(io)?;
        drop(file);
        if read_config(path)? != original {
            return Err(io(std::io::Error::other(
                "config changed during settings update; retry",
            )));
        }
        fs::rename(&temporary, path).map_err(io)
    })();
    if write.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write?;
    Ok(config)
}

/// Converts a typed section patch to TOML and writes it without adding dependencies to IPC callers.
///
/// # Errors
/// Returns a serialization, validation or filesystem error.
pub fn write_settings_patch(path: &Path, patch: &impl serde::Serialize) -> Result<Config, ConfigError> {
    let patch = toml::Value::try_from(patch).map_err(|error| ConfigError::Invalid {
        key: String::new(),
        line: 1,
        message: error.to_string(),
    })?;
    let table = patch.as_table().ok_or_else(|| ConfigError::Invalid {
        key: String::new(),
        line: 1,
        message: "expected a table patch".into(),
    })?;
    write_config_patch(path, table)
}
