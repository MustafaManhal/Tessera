//! Agent conversations on disk, so a pane can continue the exact conversation it had before a restart.
//!
//! Agent CLIs write their own transcripts as they run: Claude Code to `<config>/projects/<encoded cwd>/<id>.jsonl`,
//! Codex to `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (the first line, `session_meta`, names the cwd).
//! Tessera only has to remember which conversation belongs to which pane. The status hooks report the id exactly
//! when they are installed; this module finds it from the files when they are not, and checks that a remembered id
//! still has a transcript before Tessera asks the agent to resume it.
//!
//! It also reads a typed command line (`claude --model opus "fix it"`) to tell whether it starts an interactive
//! agent, and which of its flags a resume should keep.
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// Agents whose conversations Tessera can find and resume.
pub const RESUMABLE: &[&str] = &["claude", "codex", "opencode", "gemini"];

/// Where each agent keeps its transcripts. Built from the environment of the shell that runs the agents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roots {
    /// `$CLAUDE_CONFIG_DIR` or `~/.claude`.
    pub claude: PathBuf,
    /// `$CODEX_HOME` or `~/.codex`.
    pub codex: PathBuf,
}

impl Roots {
    /// The roots for `home` and the environment lookup `env` (a variable that is unset or empty is ignored).
    pub fn new(home: &Path, env: impl Fn(&str) -> Option<String>) -> Self {
        let pick = |name: &str, fallback: &str| {
            env(name)
                .filter(|value| !value.trim().is_empty())
                .map_or_else(|| home.join(fallback), PathBuf::from)
        };
        Self {
            claude: pick("CLAUDE_CONFIG_DIR", ".claude"),
            codex: pick("CODEX_HOME", ".codex"),
        }
    }
}

/// A conversation found on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcript {
    pub id: String,
    pub path: PathBuf,
    pub created: SystemTime,
    pub modified: SystemTime,
}

/// Claude Code's folder name for a project: every character that is not an ASCII letter or digit becomes `-`.
pub fn claude_project_folder(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn times(path: &Path) -> Option<(SystemTime, SystemTime)> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let modified = meta.modified().ok()?;
    // Not every file system records a creation time; the first write is close enough then.
    let created = meta.created().unwrap_or(modified);
    Some((created, modified))
}

/// Every Claude transcript of the project in `cwd`.
fn claude_transcripts(roots: &Roots, cwd: &str) -> Vec<Transcript> {
    let dir = roots.claude.join("projects").join(claude_project_folder(cwd));
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_owned();
            if !valid_id(&id) {
                return None;
            }
            let (created, modified) = times(&path)?;
            Some(Transcript {
                id,
                path,
                created,
                modified,
            })
        })
        .collect()
}

/// The `session_meta` line of a Codex rollout: its id and cwd.
fn codex_meta(path: &Path) -> Option<(String, String)> {
    // A session_meta line carries the base instructions and can be long; 4 MiB is plenty.
    let file = fs::File::open(path).ok()?.take(4 << 20);
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok().filter(|n| *n > 0)?;
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let id = payload.get("id")?.as_str()?.to_owned();
    let cwd = payload.get("cwd")?.as_str()?.to_owned();
    Some((id, cwd))
}

/// The day folders (`YYYY/MM/DD`) of Codex rollouts from `since` until today, newest first, at most 8.
fn codex_day_folders(roots: &Roots, since: SystemTime) -> Vec<PathBuf> {
    let sessions = roots.codex.join("sessions");
    let mut years: Vec<PathBuf> = match fs::read_dir(&sessions) {
        Ok(entries) => entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect(),
        Err(_) => return Vec::new(),
    };
    years.sort();
    let mut days = Vec::new();
    for year in years.iter().rev() {
        let mut months: Vec<PathBuf> = fs::read_dir(year)
            .map(|e| e.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        months.sort();
        for month in months.iter().rev() {
            let mut month_days: Vec<PathBuf> = fs::read_dir(month)
                .map(|e| e.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
                .unwrap_or_default();
            month_days.sort();
            for day in month_days.into_iter().rev() {
                // Folder dates are local days; a folder last touched before `since` (minus a day) is too old.
                let recent = fs::metadata(&day)
                    .and_then(|m| m.modified())
                    .map_or(true, |m| m + Duration::from_secs(86_400) >= since);
                if !recent || days.len() >= 8 {
                    return days;
                }
                days.push(day);
            }
        }
    }
    days
}

/// Codex rollouts whose `session_meta` names `cwd`, written after `since`.
fn codex_transcripts(roots: &Roots, cwd: &str, since: SystemTime) -> Vec<Transcript> {
    let mut found = Vec::new();
    for day in codex_day_folders(roots, since) {
        let Ok(entries) = fs::read_dir(&day) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            let Some((created, modified)) = times(&path) else {
                continue;
            };
            if modified < since {
                continue;
            }
            let Some((id, meta_cwd)) = codex_meta(&path) else {
                continue;
            };
            if !valid_id(&id) || !same_path(&meta_cwd, cwd) {
                continue;
            }
            found.push(Transcript {
                id,
                path,
                created,
                modified,
            });
        }
    }
    found
}

fn same_path(a: &str, b: &str) -> bool {
    let trim = |s: &str| s.trim_end_matches(['/', '\\']).to_owned();
    if cfg!(windows) {
        trim(a)
            .replace('\\', "/")
            .eq_ignore_ascii_case(&trim(b).replace('\\', "/"))
    } else {
        trim(a) == trim(b)
    }
}

/// Session ids are UUIDs or similar tokens; anything else is not put on a command line.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The transcripts of `agent` in `cwd` touched at or after `since` (with two seconds of slack for clock and
/// file system rounding). Agents whose transcripts Tessera cannot read give nothing.
pub fn recent(agent: &str, roots: &Roots, cwd: &str, since: SystemTime) -> Vec<Transcript> {
    let since = since.checked_sub(Duration::from_secs(2)).unwrap_or(since);
    let mut all = match agent {
        "claude" => claude_transcripts(roots, cwd),
        "codex" => codex_transcripts(roots, cwd, since),
        _ => Vec::new(),
    };
    all.retain(|t| t.modified >= since);
    all
}

/// One running agent that needs (or already has) a conversation id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub agent: String,
    pub cwd: String,
    pub started: SystemTime,
    /// The id it has now, if any.
    pub current: Option<String>,
}

/// Matches running agents to transcripts. Agents are taken in start order; each one takes the earliest transcript
/// created after it started that no other agent holds, so two agents started one after the other in the same folder
/// get their own conversations. An agent that already has an id moves to a newer transcript only when one appeared
/// after its own stopped changing (`/clear` and `/resume` start a new one in the same process). Returns the new id
/// for each claim (None: unchanged or nothing found).
pub fn assign(claims: &[Claim], roots: &Roots) -> Vec<Option<String>> {
    let mut held: HashSet<String> = claims.iter().filter_map(|c| c.current.clone()).collect();
    let mut order: Vec<usize> = (0..claims.len()).collect();
    order.sort_by_key(|&i| claims[i].started);
    let mut out = vec![None; claims.len()];
    for i in order {
        let claim = &claims[i];
        let mut candidates = recent(&claim.agent, roots, &claim.cwd, claim.started);
        candidates.retain(|t| t.created + Duration::from_secs(2) >= claim.started && !held.contains(&t.id));
        candidates.sort_by_key(|t| t.created);
        let pick = match &claim.current {
            None => candidates.into_iter().next(),
            Some(current) => {
                let own = recent(&claim.agent, roots, &claim.cwd, claim.started)
                    .into_iter()
                    .find(|t| &t.id == current);
                match own {
                    // A newer conversation began after this one went quiet.
                    Some(own) => candidates
                        .into_iter()
                        .rfind(|t| t.created + Duration::from_secs(2) >= own.modified && t.modified > own.modified),
                    // Its transcript never appeared (an id chosen up front that the agent did not use).
                    None => candidates.into_iter().next(),
                }
            }
        };
        if let Some(pick) = pick {
            held.insert(pick.id.clone());
            if let Some(old) = &claim.current {
                held.remove(old);
            }
            out[i] = Some(pick.id);
        }
    }
    out
}

/// Whether `id` still has a transcript `agent` can resume. Agents whose files Tessera cannot read are trusted.
pub fn exists(agent: &str, roots: &Roots, id: &str) -> bool {
    if !valid_id(id) {
        return false;
    }
    match agent {
        "claude" => {
            let Ok(projects) = fs::read_dir(roots.claude.join("projects")) else {
                return false;
            };
            projects
                .flatten()
                .any(|project| times(&project.path().join(format!("{id}.jsonl"))).is_some())
        }
        "codex" => codex_any_day_has(roots, &[format!("-{id}.jsonl"), format!("-{id}.jsonl.zst")]),
        _ => true,
    }
}

/// A search of every Codex day folder (an old conversation can be weeks back).
fn codex_any_day_has(roots: &Roots, suffixes: &[String]) -> bool {
    fn walk(dir: &Path, depth: u8, suffixes: &[String]) -> bool {
        let Ok(entries) = fs::read_dir(dir) else { return false };
        entries.flatten().any(|entry| {
            let path = entry.path();
            if depth < 3 && path.is_dir() {
                return walk(&path, depth + 1, suffixes);
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            suffixes.iter().any(|s| name.ends_with(s.as_str()))
        })
    }
    walk(&roots.codex.join("sessions"), 0, suffixes)
}

/// An interactive agent started by a typed command line, with the flags a resume keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedAgent {
    pub agent: String,
    /// The program as typed (`claude`, `./node_modules/.bin/claude`, `claude.exe`).
    pub program: String,
    pub flags: Vec<String>,
    /// An id named on the command line (`claude --resume <id>`, `codex resume <id>`).
    pub id: Option<String>,
}

/// Flags that take a value, per agent. A value after any other flag is treated as the prompt and dropped.
fn value_flags(agent: &str) -> &'static [&'static str] {
    match agent {
        "claude" => &[
            "--model",
            "--permission-mode",
            "--add-dir",
            "--allowedTools",
            "--allowed-tools",
            "--disallowedTools",
            "--disallowed-tools",
            "--mcp-config",
            "--settings",
            "--agent",
            "--agents",
            "--append-system-prompt",
            "--system-prompt",
            "--fallback-model",
            "--setting-sources",
            "--plugin-dir",
            "--permission-prompt-tool",
        ],
        "codex" => &[
            "-m",
            "--model",
            "-s",
            "--sandbox",
            "-a",
            "--ask-for-approval",
            "-c",
            "--config",
            "-p",
            "--profile",
            "-C",
            "--cd",
            "--add-dir",
            "--enable",
            "--disable",
        ],
        "opencode" => &["-m", "--model", "--agent", "--port", "--hostname"],
        "gemini" => &["-m", "--model", "--approval-mode", "--include-directories"],
        _ => &[],
    }
}

/// Flags (with their value, if any) that pick or start a conversation; a resume adds its own.
fn conversation_flags(agent: &str) -> &'static [(&'static str, bool)] {
    match agent {
        "claude" => &[
            ("-r", true),
            ("--resume", true),
            ("-c", false),
            ("--continue", false),
            ("--session-id", true),
            ("--fork-session", false),
            ("--from-pr", true),
        ],
        "codex" => &[("--last", false), ("--all", false), ("-i", true), ("--image", true)],
        "opencode" => &[
            ("-c", false),
            ("--continue", false),
            ("-s", true),
            ("--session", true),
            ("--prompt", true),
        ],
        "gemini" => &[
            ("-r", true),
            ("--resume", true),
            ("-p", true),
            ("--prompt", true),
            ("-i", true),
        ],
        _ => &[],
    }
}

/// Subcommands and flags that make a command line non-interactive (it prints and exits, nothing to resume).
fn one_shot(agent: &str, subcommand: Option<&str>, words: &[String]) -> bool {
    let has = |flags: &[&str]| words.iter().any(|w| flags.contains(&w.as_str()));
    let sub = |names: &[&str]| subcommand.is_some_and(|w| names.contains(&w));
    match agent {
        "claude" => {
            has(&["-p", "--print", "-v", "--version", "-h", "--help"])
                || sub(&[
                    "mcp",
                    "config",
                    "update",
                    "doctor",
                    "install",
                    "migrate-installer",
                    "setup-token",
                    "plugin",
                    "auth",
                    "agents",
                ])
        }
        "codex" => {
            has(&["-h", "--help", "-V", "--version"])
                || sub(&[
                    "exec",
                    "e",
                    "login",
                    "logout",
                    "mcp",
                    "mcp-server",
                    "app-server",
                    "completion",
                    "sandbox",
                    "debug",
                    "apply",
                    "a",
                    "cloud",
                    "features",
                    "help",
                    "proto",
                    "review",
                ])
        }
        "opencode" => {
            has(&["-h", "--help", "-v", "--version"])
                || sub(&[
                    "run",
                    "serve",
                    "web",
                    "auth",
                    "agent",
                    "models",
                    "stats",
                    "export",
                    "import",
                    "github",
                    "upgrade",
                    "uninstall",
                    "mcp",
                    "acp",
                    "debug",
                    "attach",
                    "pr",
                    "session",
                    "help",
                ])
        }
        "gemini" => has(&["-p", "--prompt", "-h", "--help", "-v", "--version"]) || sub(&["mcp", "extensions"]),
        _ => true,
    }
}

/// Splits a command line into words: quotes and backslash escapes as a POSIX shell reads them. Returns the words of
/// the last simple command (`cd x && claude` gives `claude`).
pub fn words(line: &str) -> Vec<String> {
    let mut commands: Vec<Vec<String>> = vec![Vec::new()];
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = line.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match quote {
            Some(q) if c == q => quote = None,
            Some('"') if c == '\\' => {
                if let Some(next) = chars.next() {
                    word.push(next);
                }
            }
            Some(_) => word.push(c),
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    in_word = true;
                }
                '\\' if !cfg!(windows) => {
                    if let Some(next) = chars.next() {
                        word.push(next);
                        in_word = true;
                    }
                }
                ' ' | '\t' | '\n' | '\r' => {
                    if in_word {
                        commands
                            .last_mut()
                            .expect("one command")
                            .push(std::mem::take(&mut word));
                        in_word = false;
                    }
                }
                ';' | '&' | '|' => {
                    if in_word {
                        commands
                            .last_mut()
                            .expect("one command")
                            .push(std::mem::take(&mut word));
                        in_word = false;
                    }
                    if chars.peek() == Some(&c) {
                        chars.next();
                    }
                    commands.push(Vec::new());
                }
                _ => {
                    word.push(c);
                    in_word = true;
                }
            },
        }
    }
    if in_word {
        commands.last_mut().expect("one command").push(word);
    }
    commands.into_iter().rev().find(|c| !c.is_empty()).unwrap_or_default()
}

/// The agent a program name stands for (`/usr/local/bin/claude`, `claude.exe`, `codex.cmd`).
pub fn agent_of_program(program: &str) -> Option<&'static str> {
    let base = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let lower = base.to_ascii_lowercase();
    let stem = [".exe", ".cmd", ".bat", ".ps1"]
        .iter()
        .find_map(|ext| lower.strip_suffix(ext))
        .unwrap_or(&lower);
    RESUMABLE.iter().copied().find(|agent| *agent == stem)
}

/// Reads a typed command line. `None` when it does not start an interactive, resumable agent.
pub fn typed_agent(line: &str) -> Option<TypedAgent> {
    typed_words(&words(line))
}

/// [`typed_agent`] for a command already split into words (program first).
pub fn typed_words(words: &[String]) -> Option<TypedAgent> {
    let mut rest = words;
    // Leading `NAME=value` assignments, `env`, `command`, `exec`, `time`, `npx`/`bunx` (and `-y`).
    loop {
        let first = rest.first()?;
        let assignment = first
            .find('=')
            .is_some_and(|eq| eq > 0 && first[..eq].chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        if assignment
            || [
                "env", "command", "exec", "time", "nohup", "npx", "bunx", "pnpx", "-y", "--yes",
            ]
            .contains(&first.as_str())
        {
            rest = &rest[1..];
        } else {
            break;
        }
    }
    let program = rest.first()?;
    // `npx @openai/codex`, `npx @anthropic-ai/claude-code`.
    let package = match program.as_str() {
        "@anthropic-ai/claude-code" => Some("claude"),
        "@openai/codex" => Some("codex"),
        "opencode-ai" => Some("opencode"),
        "@google/gemini-cli" => Some("gemini"),
        _ => None,
    };
    let agent = agent_of_program(program).or(package)?;
    let args = &rest[1..];
    let subcommand = args.first().filter(|w| !w.starts_with('-')).map(String::as_str);
    if one_shot(agent, subcommand, args) {
        return None;
    }
    let values = value_flags(agent);
    let conversation = conversation_flags(agent);
    let mut flags = Vec::new();
    let mut id = None;
    let mut i = 0;
    let mut skipped_subcommand = false;
    while i < args.len() {
        let arg = &args[i];
        if agent == "codex" && !skipped_subcommand && arg == "resume" {
            skipped_subcommand = true;
            // `codex resume <id>`: the first positional after it is the conversation.
            if let Some(next) = args.get(i + 1).filter(|n| !n.starts_with('-') && valid_id(n)) {
                id = Some(next.clone());
                i += 1;
            }
            i += 1;
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value)),
            _ => (arg.as_str(), None),
        };
        if let Some((_, takes)) = conversation.iter().find(|(flag, _)| *flag == name) {
            if *takes {
                let value = inline.map(str::to_owned).or_else(|| {
                    args.get(i + 1)
                        .filter(|n| !n.starts_with('-'))
                        .cloned()
                        .inspect(|_| i += 1)
                });
                if matches!(name, "-r" | "--resume" | "--session-id" | "-s" | "--session")
                    && let Some(value) = value.filter(|v| valid_id(v))
                {
                    id = Some(value);
                }
            }
            i += 1;
            continue;
        }
        if name.starts_with('-') {
            flags.push(arg.clone());
            if inline.is_none()
                && values.contains(&name)
                && let Some(value) = args.get(i + 1)
            {
                flags.push(value.clone());
                i += 1;
            }
        }
        // Anything else is the prompt: a resume must not send it again.
        i += 1;
    }
    Some(TypedAgent {
        agent: agent.to_owned(),
        program: program.clone(),
        flags,
        id,
    })
}

/// The flags of a launch command (`args` without the program) that a resume keeps.
pub fn kept_flags(agent: &str, args: &[String]) -> Vec<String> {
    let line: Vec<String> = std::iter::once(agent.to_owned()).chain(args.iter().cloned()).collect();
    typed_words(&line).map(|typed| typed.flags).unwrap_or_default()
}

/// The words that continue a conversation: `program` with its kept `flags` and the agent's resume form for `id`, or
/// its "latest in this folder" form when there is no id (only used when nothing else can tell the conversations of
/// one folder apart). None when the agent has no such form.
pub fn resume_words(agent: &str, program: &str, flags: &[String], id: Option<&str>) -> Option<Vec<String>> {
    let mut out = vec![program.to_owned()];
    match (agent, id) {
        ("codex", Some(id)) => {
            out.push("resume".into());
            out.extend(flags.iter().cloned());
            out.push(id.into());
        }
        ("codex", None) => {
            out.push("resume".into());
            out.extend(flags.iter().cloned());
            out.push("--last".into());
        }
        ("claude" | "gemini", Some(id)) => {
            out.extend(flags.iter().cloned());
            out.extend(["--resume".into(), id.into()]);
        }
        ("claude", None) => {
            out.extend(flags.iter().cloned());
            out.push("--continue".into());
        }
        ("opencode", Some(id)) => {
            out.extend(flags.iter().cloned());
            out.extend(["--session".into(), id.into()]);
        }
        ("opencode", None) => {
            out.extend(flags.iter().cloned());
            out.push("--continue".into());
        }
        _ => return None,
    }
    Some(out)
}

/// A word quoted for a POSIX shell (zsh, bash, fish) only when it needs it.
pub fn quote_posix(word: &str) -> String {
    if !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c))
    {
        return word.to_owned();
    }
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// A word quoted for PowerShell only when it needs it.
pub fn quote_powershell(word: &str) -> String {
    if !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./\\=:%+".contains(c))
    {
        return word.to_owned();
    }
    format!("'{}'", word.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    fn roots(dir: &Path) -> Roots {
        Roots {
            claude: dir.join("claude"),
            codex: dir.join("codex"),
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn touch(path: &Path, at: SystemTime) {
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    #[test]
    fn claude_folder_names_match_claude_code() {
        assert_eq!(
            claude_project_folder("/Users/me/Library/Application Support/Tessera/worktrees/01M/boss-3"),
            "-Users-me-Library-Application-Support-Tessera-worktrees-01M-boss-3"
        );
        assert_eq!(claude_project_folder("C:\\code\\my.app"), "C--code-my-app");
    }

    #[test]
    fn roots_follow_the_environment() {
        let home = Path::new("/home/me");
        let none = Roots::new(home, |_| None);
        assert_eq!(none.claude, home.join(".claude"));
        assert_eq!(none.codex, home.join(".codex"));
        let set = Roots::new(home, |name| (name == "CODEX_HOME").then(|| "/x/codex".to_owned()));
        assert_eq!(set.codex, PathBuf::from("/x/codex"));
    }

    #[test]
    fn two_claude_agents_in_one_folder_get_their_own_conversations() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path());
        let cwd = "/work/repo";
        let folder = roots.claude.join("projects").join(claude_project_folder(cwd));
        let start = SystemTime::now() - Duration::from_secs(60);
        // An older conversation of the folder, untouched since: never picked.
        write(&folder.join("old-one.jsonl"), "{}\n");
        touch(&folder.join("old-one.jsonl"), start - Duration::from_secs(3600));
        write(&folder.join("aaa-first.jsonl"), "{}\n");
        std::thread::sleep(Duration::from_millis(20));
        write(&folder.join("bbb-second.jsonl"), "{}\n");
        let claims = [
            Claim {
                agent: "claude".into(),
                cwd: cwd.into(),
                started: start,
                current: None,
            },
            Claim {
                agent: "claude".into(),
                cwd: cwd.into(),
                started: start + Duration::from_secs(1),
                current: None,
            },
        ];
        let ids = assign(&claims, &roots);
        assert_eq!(ids, vec![Some("aaa-first".into()), Some("bbb-second".into())]);
        // A known id that is still current is left alone.
        let kept = assign(
            &[Claim {
                current: Some("bbb-second".into()),
                ..claims[1].clone()
            }],
            &roots,
        );
        assert_eq!(kept, vec![None]);
    }

    #[test]
    fn a_cleared_conversation_moves_the_agent_to_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path());
        let cwd = "/work/repo";
        let folder = roots.claude.join("projects").join(claude_project_folder(cwd));
        let start = SystemTime::now() - Duration::from_secs(120);
        write(&folder.join("before-clear.jsonl"), "{}\n");
        touch(
            &folder.join("before-clear.jsonl"),
            SystemTime::now() - Duration::from_secs(30),
        );
        write(&folder.join("after-clear.jsonl"), "{}\n");
        let claim = Claim {
            agent: "claude".into(),
            cwd: cwd.into(),
            started: start,
            current: Some("before-clear".into()),
        };
        assert_eq!(assign(&[claim], &roots), vec![Some("after-clear".into())]);
    }

    #[test]
    fn codex_rollouts_are_matched_by_their_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path());
        let day = roots.codex.join("sessions/2026/11/20");
        let meta = |id: &str, cwd: &str| {
            format!(r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","timestamp":"x"}}}}"#) + "\n"
        };
        write(
            &day.join("rollout-2026-11-20T10-00-00-elsewhere.jsonl"),
            &meta("0199-other", "/other"),
        );
        write(
            &day.join("rollout-2026-11-20T10-00-01-mine.jsonl"),
            &meta("0199-mine", "/work/repo"),
        );
        let start = SystemTime::now() - Duration::from_secs(10);
        let claim = Claim {
            agent: "codex".into(),
            cwd: "/work/repo/".into(),
            started: start,
            current: None,
        };
        assert_eq!(assign(&[claim], &roots), vec![Some("0199-mine".into())]);
        write(
            &day.join("rollout-2026-11-20T10-00-02-0199-abc.jsonl"),
            &meta("0199-abc", "/w"),
        );
        assert!(exists("codex", &roots, "0199-abc"));
        assert!(!exists("codex", &roots, "0199-missing"));
    }

    #[test]
    fn a_claude_id_exists_only_with_a_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path());
        write(&roots.claude.join("projects/-a-b/1234-5678.jsonl"), "{}\n");
        write(&roots.claude.join("projects/-a-b/empty-one.jsonl"), "");
        assert!(exists("claude", &roots, "1234-5678"));
        assert!(!exists("claude", &roots, "empty-one"));
        assert!(!exists("claude", &roots, "nope"));
        assert!(!exists("claude", &roots, "../etc/passwd"));
        assert!(exists("opencode", &roots, "anything"));
    }

    #[test]
    fn typed_command_lines() {
        let typed = typed_agent("claude --dangerously-skip-permissions --model opus 'fix the bug'").unwrap();
        assert_eq!(typed.agent, "claude");
        assert_eq!(typed.flags, ["--dangerously-skip-permissions", "--model", "opus"]);
        assert_eq!(typed.id, None);
        let resumed = typed_agent("cd app && claude -r 0f9e-11 --permission-mode=plan").unwrap();
        assert_eq!(resumed.id.as_deref(), Some("0f9e-11"));
        assert_eq!(resumed.flags, ["--permission-mode=plan"]);
        assert_eq!(typed_agent("claude -c").unwrap().flags, Vec::<String>::new());
        assert!(typed_agent("claude -p 'one shot'").is_none());
        assert!(typed_agent("claude mcp list").is_none());
        assert!(typed_agent("echo claude").is_none());
        assert!(typed_agent("ls").is_none());
        let codex = typed_agent("FOO=1 codex -m gpt-5 --full-auto").unwrap();
        assert_eq!((codex.agent.as_str(), codex.flags.len()), ("codex", 3));
        assert!(typed_agent("codex exec 'do it'").is_none());
        let codex_resume = typed_agent("codex resume 019a-77 --yolo").unwrap();
        assert_eq!(codex_resume.id.as_deref(), Some("019a-77"));
        assert_eq!(codex_resume.flags, ["--yolo"]);
        assert_eq!(typed_agent("npx @openai/codex").unwrap().agent, "codex");
        assert_eq!(
            typed_agent("/opt/bin/claude.exe").unwrap().program,
            "/opt/bin/claude.exe"
        );
        assert_eq!(typed_agent("opencode").unwrap().agent, "opencode");
        assert!(typed_agent("opencode run 'x'").is_none());
        assert_eq!(
            typed_agent("codex 'fix the tests'").unwrap().flags,
            Vec::<String>::new()
        );
    }

    #[test]
    fn resume_command_lines() {
        let flags = vec!["--model".to_owned(), "opus".to_owned()];
        assert_eq!(
            resume_words("claude", "claude", &flags, Some("abc")).unwrap(),
            ["claude", "--model", "opus", "--resume", "abc"]
        );
        assert_eq!(
            resume_words("codex", "codex", &[], Some("abc")).unwrap(),
            ["codex", "resume", "abc"]
        );
        assert_eq!(
            resume_words("codex", "codex", &[], None).unwrap(),
            ["codex", "resume", "--last"]
        );
        assert_eq!(
            resume_words("opencode", "opencode", &[], Some("s1")).unwrap(),
            ["opencode", "--session", "s1"]
        );
        assert!(resume_words("gemini", "gemini", &[], None).is_none());
        assert_eq!(quote_posix("--model"), "--model");
        assert_eq!(quote_posix("it's"), "'it'\\''s'");
        assert_eq!(quote_powershell("a b"), "'a b'");
        assert_eq!(
            kept_flags(
                "claude",
                &["--dangerously-skip-permissions".into(), "first prompt".into()]
            ),
            ["--dangerously-skip-permissions"]
        );
    }
}
