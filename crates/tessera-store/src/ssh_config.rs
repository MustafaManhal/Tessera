//! Reads the user's `~/.ssh/config` for the SSH host list (FR-62, S-19). Read only: Tessera never writes that file.
//!
//! Supported: `Host` blocks with one or more names (patterns with `*`, `?` or `!` are not hosts and are skipped),
//! `Match` blocks (skipped), `Include` (relative to `~/.ssh`, `*` and `?` in the file name, at most 8 levels),
//! `key value` and `key=value`, quoted values, comments, case-insensitive keywords. Per host: `HostName`, `User`,
//! `Port`, the first `IdentityFile`, `ProxyJump`. `ssh` itself resolves everything else when it connects.

use std::path::{Path, PathBuf};

/// One concrete host from the config.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SshConfigHost {
    /// The name after `Host` (what `ssh <alias>` takes).
    pub alias: String,
    /// `HostName`, when set.
    pub host_name: Option<String>,
    /// `User`, when set.
    pub user: Option<String>,
    /// `Port`, when set and valid.
    pub port: Option<u16>,
    /// The first `IdentityFile`, `~` expanded.
    pub identity_file: Option<String>,
    /// `ProxyJump`, when set.
    pub proxy_jump: Option<String>,
}

const MAX_DEPTH: usize = 8;

/// Hosts from `~/.ssh/config` under `home`, in file order, each alias once (the first block wins, as in ssh).
#[must_use]
pub fn read_ssh_config(home: &Path) -> Vec<SshConfigHost> {
    let ssh_dir = home.join(".ssh");
    let mut hosts = Vec::new();
    parse_file(&ssh_dir.join("config"), &ssh_dir, home, 0, &mut hosts);
    hosts
}

fn parse_file(path: &Path, ssh_dir: &Path, home: &Path, depth: usize, hosts: &mut Vec<SshConfigHost>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    parse_text(&text, ssh_dir, home, depth, hosts);
}

/// Parses config text; `Include` lines are resolved against `ssh_dir`.
pub fn parse_text(text: &str, ssh_dir: &Path, home: &Path, depth: usize, hosts: &mut Vec<SshConfigHost>) {
    // Indices into `hosts` that the current block applies to (None inside Match or a pattern-only Host).
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = split(line) else { continue };
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                current.clear();
                for name in words(&value) {
                    if name.contains(['*', '?', '!']) {
                        continue;
                    }
                    if let Some(index) = hosts.iter().position(|h| h.alias == name) {
                        current.push(index);
                    } else {
                        hosts.push(SshConfigHost {
                            alias: name,
                            ..SshConfigHost::default()
                        });
                        current.push(hosts.len() - 1);
                    }
                }
            }
            "match" => current.clear(),
            "include" => {
                for pattern in words(&value) {
                    for file in expand_include(&pattern, ssh_dir, home) {
                        parse_file(&file, ssh_dir, home, depth + 1, hosts);
                    }
                }
            }
            keyword => {
                for &index in &current {
                    let host = &mut hosts[index];
                    // ssh takes the first value for each keyword.
                    match keyword {
                        "hostname" if host.host_name.is_none() => host.host_name = Some(unquote(&value)),
                        "user" if host.user.is_none() => host.user = Some(unquote(&value)),
                        "port" if host.port.is_none() => host.port = unquote(&value).parse().ok(),
                        "identityfile" if host.identity_file.is_none() => {
                            host.identity_file = Some(expand_home(&unquote(&value), home));
                        }
                        "proxyjump" if host.proxy_jump.is_none() => host.proxy_jump = Some(unquote(&value)),
                        _ => {}
                    }
                }
            }
        }
    }
}

/// `key value` or `key=value` (with optional spaces around `=`).
fn split(line: &str) -> Option<(String, String)> {
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..end].to_owned();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
    (!rest.is_empty()).then(|| (key, rest.to_owned()))
}

/// Space-separated words; double quotes group.
fn words(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    for c in value.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
            }
            c => word.push(c),
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

fn unquote(value: &str) -> String {
    words(value).into_iter().next().unwrap_or_default()
}

fn expand_home(value: &str, home: &Path) -> String {
    match value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
        Some(rest) => home.join(rest).to_string_lossy().into_owned(),
        None => value.to_owned(),
    }
}

/// Files an `Include` names: relative paths are under `~/.ssh`; `*` and `?` match in the last component.
fn expand_include(pattern: &str, ssh_dir: &Path, home: &Path) -> Vec<PathBuf> {
    let expanded = expand_home(pattern, home);
    let path = Path::new(&expanded);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        ssh_dir.join(path)
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Some(dir) = path.parent() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| glob(&name, &entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    files.sort();
    files
}

/// `*` and `?` wildcard match.
fn glob(pattern: &str, text: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_keywords_patterns_and_first_value_wins() {
        let home = Path::new("/home/me");
        let mut hosts = Vec::new();
        parse_text(
            r#"
# comment
Host build prod-db
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_deploy
  IdentityFile ~/.ssh/second
Host *.internal !secret
  User nobody
Host "quoted name"
  HostName=example.com
  Port = 22
Match host build
  User matched
Host build
  User ignored-second-block
  ProxyJump jump
"#,
            Path::new("/home/me/.ssh"),
            home,
            0,
            &mut hosts,
        );
        let names: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, ["build", "prod-db", "quoted name"]);
        let build = &hosts[0];
        assert_eq!(build.host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(
            build.user.as_deref(),
            Some("deploy"),
            "first value wins, Match is skipped"
        );
        assert_eq!(build.port, Some(2222));
        // Compare as paths: Windows joins with a backslash.
        assert_eq!(
            build.identity_file.as_deref().map(Path::new),
            Some(home.join(".ssh/id_deploy").as_path())
        );
        assert_eq!(build.proxy_jump.as_deref(), Some("jump"));
        assert_eq!(hosts[1].user.as_deref(), Some("deploy"));
        assert_eq!(hosts[2].host_name.as_deref(), Some("example.com"));
        assert_eq!(hosts[2].port, Some(22));
    }

    #[test]
    fn includes_resolve_relative_and_globbed_and_stop_at_a_loop() {
        let home = tempfile::tempdir().unwrap();
        let ssh = home.path().join(".ssh");
        std::fs::create_dir_all(ssh.join("conf.d")).unwrap();
        std::fs::write(ssh.join("config"), "Include conf.d/*.conf\nInclude config\nHost main\n").unwrap();
        std::fs::write(ssh.join("conf.d/a.conf"), "Host alpha\n  User a\n").unwrap();
        std::fs::write(ssh.join("conf.d/b.conf"), "Host beta\n").unwrap();
        std::fs::write(ssh.join("conf.d/skip.txt"), "Host never\n").unwrap();
        let hosts = read_ssh_config(home.path());
        let names: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, ["alpha", "beta", "main"]);
        assert_eq!(hosts[0].user.as_deref(), Some("a"));
    }

    #[test]
    fn a_missing_config_is_an_empty_list_and_bad_ports_are_ignored() {
        let home = tempfile::tempdir().unwrap();
        assert!(read_ssh_config(home.path()).is_empty());
        let mut hosts = Vec::new();
        parse_text("Host x\n Port nope\n", home.path(), home.path(), 0, &mut hosts);
        assert_eq!(hosts[0].port, None);
        assert!(glob("*.conf", "a.conf") && !glob("*.conf", "a.txt") && glob("h?st", "host"));
    }
}
