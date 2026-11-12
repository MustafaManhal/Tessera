//! Token and cost figures for a task, read from the session files the agent CLIs already leave on disk (FR-44).
//! Only two roots are ever read: `<home>/.claude/projects/<encoded worktree>/` and `<home>/.codex/sessions/`.
//! Nothing is uploaded. Files are read incrementally (a byte offset per file) and a truncated last line is left for
//! the next scan.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

/// Totals for one task. `cost_usd` is an estimate from a small bundled price table and `None` when any model
/// used is not in the table.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_usd: Option<f64>,
    pub models: Vec<String>,
    /// Which log the numbers came from (`claude-jsonl`, `codex-log`).
    pub source: String,
}

impl Usage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens
    }
}

/// Price in USD per million tokens: input, output, cache read, cache write.
type Price = (f64, f64, f64, f64);

/// Matched by model-id prefix, most specific first. Estimates only; the UI says so.
fn price(model: &str) -> Option<Price> {
    const TABLE: &[(&str, Price)] = &[
        ("claude-opus-4-5", (5.0, 25.0, 0.5, 6.25)),
        ("claude-opus-4-1", (15.0, 75.0, 1.5, 18.75)),
        ("claude-opus-4", (15.0, 75.0, 1.5, 18.75)),
        ("claude-opus-5", (5.0, 25.0, 0.5, 6.25)),
        ("claude-sonnet", (3.0, 15.0, 0.3, 3.75)),
        ("claude-haiku-4", (1.0, 5.0, 0.1, 1.25)),
        ("claude-haiku-5", (1.0, 5.0, 0.1, 1.25)),
        ("claude-3-5-haiku", (0.8, 4.0, 0.08, 1.0)),
        ("gpt-5", (1.25, 10.0, 0.125, 0.0)),
    ];
    TABLE
        .iter()
        .find(|(prefix, _)| model.starts_with(prefix))
        .map(|(_, p)| *p)
}

/// Claude Code names a project folder after the working directory with every non-alphanumeric character as `-`.
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[derive(Default)]
struct FileState {
    offset: u64,
    /// Claude: the latest usage per message id (streamed messages repeat). Codex: the latest cumulative total.
    claude: HashMap<String, (String, [u64; 4])>,
    codex_total: [u64; 4],
    codex_model: Option<String>,
}

/// Remembers how far each file was read, so a rescan only parses appended lines.
#[derive(Default)]
pub struct UsageTracker {
    files: HashMap<PathBuf, FileState>,
}

const MAX_CODEX_FILES: usize = 4000;

impl UsageTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Usage for the worktree `cwd` from the log `source` under `home`. `None` when the agent does not report usage
    /// or no log exists.
    pub fn scan(&mut self, source: &str, home: &Path, cwd: &str) -> Option<Usage> {
        match source {
            "claude-jsonl" => {
                let dir = home.join(".claude").join("projects").join(claude_project_dir_name(cwd));
                let files = jsonl_files(&dir);
                if files.is_empty() {
                    return None;
                }
                for file in &files {
                    self.read_claude(file);
                }
                Some(self.claude_total(&files))
            }
            "codex-log" => {
                let files = codex_files_for(&home.join(".codex").join("sessions"), cwd);
                if files.is_empty() {
                    return None;
                }
                for file in &files {
                    self.read_codex(file);
                }
                Some(self.codex_total(&files))
            }
            _ => None,
        }
    }

    fn read_new_lines(&mut self, path: &Path) -> Vec<String> {
        let state = self.files.entry(path.to_path_buf()).or_default();
        let Ok(mut file) = File::open(path) else {
            return Vec::new();
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        if len < state.offset {
            *state = FileState::default();
        }
        if file.seek(SeekFrom::Start(state.offset)).is_err() {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file
            .take(len.saturating_sub(state.offset))
            .read_to_end(&mut bytes)
            .is_err()
        {
            return Vec::new();
        }
        // Keep a trailing partial line for the next scan.
        let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        state.offset += complete as u64;
        String::from_utf8_lossy(&bytes[..complete])
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn read_claude(&mut self, path: &Path) {
        for line in self.read_new_lines(path) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let message = &value["message"];
            let usage = &message["usage"];
            if !usage.is_object() {
                continue;
            }
            let n = |key: &str| usage[key].as_u64().unwrap_or(0);
            let tokens = [
                n("input_tokens"),
                n("output_tokens"),
                n("cache_read_input_tokens"),
                n("cache_creation_input_tokens"),
            ];
            let model = message["model"].as_str().unwrap_or_default().to_owned();
            let id = message["id"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| value["uuid"].as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("line-{}", self.files[path].claude.len()));
            if let Some(state) = self.files.get_mut(path) {
                state.claude.insert(id, (model, tokens));
            }
        }
    }

    fn claude_total(&self, files: &[PathBuf]) -> Usage {
        let mut all: HashMap<&str, &(String, [u64; 4])> = HashMap::new();
        for state in files.iter().filter_map(|f| self.files.get(f)) {
            for (id, entry) in &state.claude {
                all.insert(id, entry);
            }
        }
        build("claude-jsonl", all.values().map(|(model, t)| (model.as_str(), *t)))
    }

    fn read_codex(&mut self, path: &Path) {
        for line in self.read_new_lines(path) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let payload = &value["payload"];
            let Some(state) = self.files.get_mut(path) else {
                continue;
            };
            if value["type"] == "turn_context"
                && let Some(model) = payload["model"].as_str()
            {
                state.codex_model = Some(model.to_owned());
            }
            if payload["type"] == "token_count" {
                let total = &payload["info"]["total_token_usage"];
                if total.is_object() {
                    let n = |key: &str| total[key].as_u64().unwrap_or(0);
                    let cached = n("cached_input_tokens");
                    // Codex counts cached tokens inside input_tokens; report them separately.
                    state.codex_total = [n("input_tokens").saturating_sub(cached), n("output_tokens"), cached, 0];
                }
            }
        }
    }

    fn codex_total(&self, files: &[PathBuf]) -> Usage {
        build(
            "codex-log",
            files
                .iter()
                .filter_map(|f| self.files.get(f))
                .map(|s| (s.codex_model.as_deref().unwrap_or_default(), s.codex_total)),
        )
    }
}

fn build<'a>(source: &str, rows: impl Iterator<Item = (&'a str, [u64; 4])>) -> Usage {
    let mut usage = Usage {
        source: source.to_owned(),
        ..Usage::default()
    };
    let mut cost = Some(0.0f64);
    for (model, t) in rows {
        usage.input_tokens += t[0];
        usage.output_tokens += t[1];
        usage.cache_read_tokens += t[2];
        usage.cache_write_tokens += t[3];
        if !model.is_empty() && !usage.models.iter().any(|m| m == model) {
            usage.models.push(model.to_owned());
        }
        match (price(model), cost) {
            (Some((i, o, r, w)), Some(c)) => {
                cost = Some(c + (t[0] as f64 * i + t[1] as f64 * o + t[2] as f64 * r + t[3] as f64 * w) / 1_000_000.0);
            }
            _ => cost = None,
        }
    }
    usage.models.sort();
    usage.cost_usd = cost;
    usage
}

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = read
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    files.sort();
    files
}

/// Rollout files whose first line (`session_meta`) names `cwd` as the working directory.
fn codex_files_for(root: &Path, cwd: &str) -> Vec<PathBuf> {
    let mut all = Vec::new();
    collect_jsonl(root, 0, &mut all);
    all.sort();
    all.reverse();
    all.truncate(MAX_CODEX_FILES);
    all.into_iter()
        .filter(|p| codex_cwd(p).as_deref() == Some(cwd))
        .collect()
}

fn collect_jsonl(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            collect_jsonl(&path, depth + 1, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

fn codex_cwd(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let mut line = String::new();
    // The meta line can be large (instructions); read at most 256 KiB of it.
    BufReader::new(File::open(path).ok()?.take(256 * 1024))
        .read_line(&mut line)
        .ok()?;
    let value: Value = serde_json::from_str(&line).ok()?;
    value["payload"]["cwd"]
        .as_str()
        .or_else(|| value["cwd"].as_str())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn claude_line(id: &str, model: &str, i: u64, o: u64, r: u64, w: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"id":"{id}","model":"{model}","usage":{{"input_tokens":{i},"output_tokens":{o},"cache_read_input_tokens":{r},"cache_creation_input_tokens":{w}}}}}}}"#
        )
    }

    #[test]
    fn dir_name_replaces_every_non_alphanumeric_character() {
        assert_eq!(claude_project_dir_name("/Users/a b/ü/x.y"), "-Users-a-b---x-y");
    }

    #[test]
    fn claude_sums_models_dedupes_streamed_messages_and_prices_known_ones() {
        let home = tempfile::tempdir().unwrap();
        let cwd = "/work/with space/ünï";
        let dir = home.path().join(".claude/projects").join(claude_project_dir_name(cwd));
        fs::create_dir_all(&dir).unwrap();
        let body = [
            claude_line("m1", "claude-sonnet-4-5", 10, 1, 0, 0),
            claude_line("m1", "claude-sonnet-4-5", 10, 20, 100, 50), // same message again, final numbers
            claude_line("m2", "claude-haiku-4-5", 1_000_000, 0, 0, 0),
            "not json".into(),
            "{\"type\":\"user\"}".into(),
        ]
        .join("\n");
        fs::write(dir.join("a.jsonl"), format!("{body}\n")).unwrap();
        let usage = UsageTracker::new().scan("claude-jsonl", home.path(), cwd).unwrap();
        assert_eq!(usage.input_tokens, 1_000_010);
        assert_eq!(usage.output_tokens, 20);
        assert_eq!(usage.cache_read_tokens, 100);
        assert_eq!(usage.cache_write_tokens, 50);
        assert_eq!(usage.models, ["claude-haiku-4-5", "claude-sonnet-4-5"]);
        let cost = usage.cost_usd.unwrap();
        let expected = (10.0 * 3.0 + 20.0 * 15.0 + 100.0 * 0.3 + 50.0 * 3.75) / 1e6 + 1.0;
        assert!((cost - expected).abs() < 1e-9, "{cost} vs {expected}");
    }

    #[test]
    fn unknown_model_gives_tokens_without_cost() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".claude/projects/-w");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.jsonl"), claude_line("m", "mystery-9", 5, 6, 0, 0) + "\n").unwrap();
        let usage = UsageTracker::new().scan("claude-jsonl", home.path(), "/w").unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens), (5, 6));
        assert_eq!(usage.cost_usd, None);
    }

    #[test]
    fn truncated_last_line_waits_for_the_next_scan_and_files_read_incrementally() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".claude/projects/-w");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.jsonl");
        let first = claude_line("m1", "claude-sonnet-4-5", 1, 1, 0, 0);
        let second = claude_line("m2", "claude-sonnet-4-5", 2, 2, 0, 0);
        fs::write(&file, format!("{first}\n{}", &second[..20])).unwrap();
        let mut tracker = UsageTracker::new();
        assert_eq!(tracker.scan("claude-jsonl", home.path(), "/w").unwrap().input_tokens, 1);
        fs::write(&file, format!("{first}\n{second}\n")).unwrap();
        assert_eq!(tracker.scan("claude-jsonl", home.path(), "/w").unwrap().input_tokens, 3);
        // A rewritten, shorter file starts over instead of reading garbage.
        fs::write(&file, format!("{first}\n")).unwrap();
        assert_eq!(tracker.scan("claude-jsonl", home.path(), "/w").unwrap().input_tokens, 1);
    }

    #[test]
    fn missing_directory_and_unknown_source_report_nothing() {
        let home = tempfile::tempdir().unwrap();
        let mut tracker = UsageTracker::new();
        assert!(tracker.scan("claude-jsonl", home.path(), "/none").is_none());
        assert!(tracker.scan("codex-log", home.path(), "/none").is_none());
        assert!(tracker.scan("other", home.path(), "/none").is_none());
    }

    #[test]
    fn codex_matches_by_cwd_uses_the_last_cumulative_total_and_splits_cached_input() {
        let home = tempfile::tempdir().unwrap();
        let day = home.path().join(".codex/sessions/2026/11/12");
        fs::create_dir_all(&day).unwrap();
        let cwd = "/repo/wt one";
        let mine = [
            format!(r#"{{"type":"session_meta","payload":{{"id":"x","cwd":"{cwd}"}}}}"#),
            r#"{"type":"turn_context","payload":{"model":"gpt-5-codex"}}"#.into(),
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}}}"#.into(),
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":30}}}}"#.into(),
            r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#.into(),
        ]
        .join("\n");
        fs::write(day.join("rollout-1.jsonl"), mine + "\n").unwrap();
        fs::write(
            day.join("rollout-2.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/other\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":9999}}}}\n",
        )
        .unwrap();
        let usage = UsageTracker::new().scan("codex-log", home.path(), cwd).unwrap();
        assert_eq!(usage.input_tokens, 200);
        assert_eq!(usage.cache_read_tokens, 100);
        assert_eq!(usage.output_tokens, 30);
        assert_eq!(usage.models, ["gpt-5-codex"]);
        assert!(usage.cost_usd.is_some());
    }
}
