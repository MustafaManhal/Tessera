//! Pull requests, CI checks and merge (FR-49..FR-51). REST calls reuse `github::api_get`'s conventions:
//! bearer auth, rate-limit headers, ETag conditional GETs. Tests run against the local mock server.

use crate::ForgeError;
use crate::github::{ApiResponse, api_get};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: i64,
    pub title: String,
    /// open | closed (draft is a flag, merged shows as closed + merged_at).
    pub state: String,
    pub draft: bool,
    pub merged: bool,
    pub html_url: String,
    pub head_sha: Option<String>,
    /// mergeable | mergeable_state from GET /pulls/{n} (None until GitHub computes it).
    pub mergeable: Option<bool>,
    pub mergeable_state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckRun {
    pub name: String,
    /// queued | in_progress | completed
    pub status: String,
    /// success | failure | neutral | cancelled | skipped | timed_out | action_required | None
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub html_url: Option<String>,
    pub id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitStatus {
    pub context: String,
    /// error | failure | pending | success
    pub state: String,
    pub target_url: Option<String>,
}

/// One row of the S-09 checks list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckEntry {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub duration_ms: Option<i64>,
    pub url: Option<String>,
}

/// `ci_state` values stored on the task row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CiState {
    Pending,
    Success,
    Failing,
}
impl CiState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Success => "success",
            Self::Failing => "failing",
        }
    }
}

fn client() -> Result<reqwest::Client, ForgeError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| ForgeError::Network(e.to_string()))
}

async fn send(request: reqwest::RequestBuilder) -> Result<ApiResponse, ForgeError> {
    let response = request
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.without_url().to_string()))?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let remaining = headers
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let reset = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let etag = headers.get("etag").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let rate = |body| ApiResponse {
        status,
        body,
        rate_remaining: remaining,
        rate_reset: reset,
        etag,
    };
    if (status == 403 || status == 429) && remaining == Some(0) {
        return Err(ForgeError::RateLimited {
            until: reset.unwrap_or(0),
        });
    }
    if status == 304 {
        return Ok(rate(serde_json::Value::Null));
    }
    let body_text = response.text().await.map_err(|e| ForgeError::Network(e.to_string()))?;
    let body = serde_json::from_str(&body_text).unwrap_or(serde_json::Value::String(body_text));
    if !(200..300).contains(&status) {
        let detail = body.get("message").and_then(|m| m.as_str()).unwrap_or("request failed");
        return Err(ForgeError::Protocol(format!("GitHub API error {status}: {detail}")));
    }
    Ok(rate(body))
}

fn repo(owner: &str, repo: &str) -> String {
    format!("/repos/{owner}/{repo}")
}

#[allow(clippy::too_many_arguments)]
pub async fn create_pr(
    base: &str,
    token: &str,
    owner: &str,
    repo_name: &str,
    title: &str,
    body: &str,
    head: &str,
    base_branch: &str,
    draft: bool,
) -> Result<PullRequest, ForgeError> {
    let request = client()?
        .post(format!("{base}{}{}", repo(owner, repo_name), "/pulls"))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .json(&serde_json::json!({
            "title": title,
            "body": body,
            "head": head,
            "base": base_branch,
            "draft": draft,
        }));
    let response = send(request).await?;
    serde_json::from_value(response.body).map_err(|e| ForgeError::Protocol(e.to_string()))
}

/// The PR for `head` branch (any state), newest first; None when absent.
pub async fn find_pr(
    base: &str,
    token: &str,
    owner: &str,
    repo_name: &str,
    head: &str,
) -> Result<Option<PullRequest>, ForgeError> {
    let path = format!(
        "{}{}?state=all&head={}&per_page=5",
        repo(owner, repo_name),
        "/pulls",
        encode(head)
    );
    let response = api_get(base, token, &path, None).await?;
    let list: Vec<PullRequest> =
        serde_json::from_value(response.body).map_err(|e| ForgeError::Protocol(e.to_string()))?;
    Ok(list.into_iter().next())
}

pub async fn get_pr(
    base: &str,
    token: &str,
    owner: &str,
    repo_name: &str,
    number: i64,
) -> Result<PullRequest, ForgeError> {
    get_pr_etag(base, token, owner, repo_name, number, None)
        .await?
        .0
        .ok_or_else(|| ForgeError::Protocol("empty pull request response".into()))
}

/// `get_pr` with an optional `If-None-Match`; `(None, etag)` means unchanged (304).
pub async fn get_pr_etag(
    base: &str,
    token: &str,
    owner: &str,
    repo_name: &str,
    number: i64,
    etag: Option<&str>,
) -> Result<(Option<PullRequest>, Option<String>), ForgeError> {
    let response = api_get(base, token, &format!("{}/pulls/{number}", repo(owner, repo_name)), etag).await?;
    let out_etag = response.etag.clone();
    if response.status == 304 {
        return Ok((None, out_etag));
    }
    let pr: PullRequest = serde_json::from_value(response.body).map_err(|e| ForgeError::Protocol(e.to_string()))?;
    Ok((Some(pr), out_etag))
}

/// Check runs for a commit sha; follows pagination only one page (enough for chips).
pub async fn check_runs(
    base: &str,
    token: &str,
    owner: &str,
    repo_name: &str,
    sha: &str,
) -> Result<Vec<CheckRun>, ForgeError> {
    let path = format!("{}/commits/{sha}/check-runs?per_page=100", repo(owner, repo_name));
    let response = api_get(base, token, &path, None).await?;
    #[derive(Deserialize)]
    struct Runs {
        check_runs: Vec<CheckRun>,
    }
    let runs: Runs = serde_json::from_value(response.body).map_err(|e| ForgeError::Protocol(e.to_string()))?;
    Ok(runs.check_runs)
}

pub async fn commit_statuses(
    base: &str,
    token: &str,
    owner: &str,
    repo_name: &str,
    sha: &str,
) -> Result<Vec<CommitStatus>, ForgeError> {
    let path = format!("{}/commits/{sha}/status?per_page=100", repo(owner, repo_name));
    let response = api_get(base, token, &path, None).await?;
    #[derive(Deserialize)]
    struct Statuses {
        statuses: Vec<CommitStatus>,
    }
    let statuses: Statuses = serde_json::from_value(response.body).map_err(|e| ForgeError::Protocol(e.to_string()))?;
    Ok(statuses.statuses)
}

/// The checks list for S-09: check runs plus legacy commit statuses, deduplicated by name.
pub async fn checks(
    base: &str,
    token: &str,
    owner: &str,
    repo_name: &str,
    sha: &str,
) -> Result<Vec<CheckEntry>, ForgeError> {
    let runs = check_runs(base, token, owner, repo_name, sha).await.unwrap_or_default();
    let statuses = commit_statuses(base, token, owner, repo_name, sha)
        .await
        .unwrap_or_default();
    let mut entries: Vec<CheckEntry> = runs
        .into_iter()
        .map(|run| CheckEntry {
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            duration_ms: duration_ms(&run.started_at, &run.completed_at),
            url: run.html_url,
        })
        .collect();
    for status in statuses {
        if entries.iter().any(|e| e.name == status.context) {
            continue;
        }
        entries.push(CheckEntry {
            name: status.context,
            status: if status.state == "pending" {
                "pending".into()
            } else {
                "completed".into()
            },
            conclusion: match status.state.as_str() {
                "success" => Some("success".into()),
                "failure" | "error" => Some("failure".into()),
                _ => None,
            },
            duration_ms: None,
            url: status.target_url,
        });
    }
    Ok(entries)
}

/// RFC 3339 (`2024-01-01T00:00:00Z`, optional fractional seconds and offset) → unix seconds.
fn rfc3339_epoch(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') || bytes.get(10) != Some(&b'T') {
        return None;
    }
    let num = |a: usize, b: usize| text.get(a..b)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    // Days from civil (Howard Hinnant's algorithm), then an offset in seconds.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut secs = days * 86400 + hour * 3600 + minute * 60 + second;
    // Offset: `Z` or `±HH:MM` after the seconds.
    let tail = text.get(19..).unwrap_or("");
    if let Some(tz) = tail.strip_prefix('Z') {
        if !tz.is_empty() && !tz.starts_with('.') {
            return None;
        }
    } else {
        let sign_idx = tail.find(['+', '-'])?;
        let sign = if tail.as_bytes()[sign_idx] == b'-' { -1 } else { 1 };
        let off = &tail[sign_idx + 1..];
        let (h, m) = off.split_once(':')?;
        secs += sign * (h.parse::<i64>().ok()? * 3600 + m.parse::<i64>().ok()? * 60);
    }
    Some(secs)
}

fn duration_ms(started: &Option<String>, completed: &Option<String>) -> Option<i64> {
    let start = rfc3339_epoch(started.as_deref()?)?;
    let end = rfc3339_epoch(completed.as_deref()?)?;
    Some((end - start) * 1000)
}

/// Roll check runs + commit statuses up into the stored `ci_state`.
pub fn ci_state(runs: &[CheckRun], statuses: &[CommitStatus]) -> CiState {
    let mut pending = false;
    let mut failing = false;
    for run in runs {
        match run.status.as_str() {
            "queued" | "in_progress" | "waiting" | "requested" | "pending" => pending = true,
            "completed" => match run.conclusion.as_deref() {
                Some("success" | "neutral" | "skipped") | None => {}
                _ => failing = true,
            },
            _ => pending = true,
        }
    }
    for status in statuses {
        match status.state.as_str() {
            "pending" => pending = true,
            "failure" | "error" => failing = true,
            _ => {}
        }
    }
    if failing {
        CiState::Failing
    } else if pending {
        CiState::Pending
    } else {
        CiState::Success
    }
}

/// Last `lines` of a failing job's log. The check run's html_url carries `/job/{id}`; the logs endpoint
/// 302s to a text download which reqwest follows.
pub async fn job_log_tail(
    base: &str,
    token: &str,
    owner: &str,
    repo_name: &str,
    run: &CheckRun,
    lines: usize,
) -> Result<String, ForgeError> {
    let job_id = run
        .html_url
        .as_deref()
        .and_then(|url| url.rsplit("/job/").next())
        .and_then(|tail| tail.split('/').next())
        .and_then(|id| id.parse::<i64>().ok())
        .ok_or_else(|| ForgeError::Protocol("the check run has no job link".into()))?;
    let request = client()?
        .get(format!("{base}{}/actions/jobs/{job_id}/logs", repo(owner, repo_name)))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json");
    let response = send(request).await?;
    let text = match response.body {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    };
    Ok(tail_lines(&text, lines))
}

fn tail_lines(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeResult {
    pub merged: bool,
    pub sha: Option<String>,
    pub message: Option<String>,
}

pub async fn merge_pr(
    base: &str,
    token: &str,
    owner: &str,
    repo_name: &str,
    number: i64,
    method: MergeMethod,
) -> Result<MergeResult, ForgeError> {
    let request = client()?
        .put(format!("{base}{}/pulls/{number}/merge", repo(owner, repo_name)))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "merge_method": method }));
    let response = send(request).await?;
    serde_json::from_value(response.body).map_err(|e| ForgeError::Protocol(e.to_string()))
}

fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    struct Mock {
        base: String,
        requests: Arc<Mutex<Vec<String>>>,
    }

    /// Canned replies matched in order; each entry is (status, body, content_type).
    fn mock(replies: Vec<(u16, String)>) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            for (status, body) in replies {
                let Ok((stream, _)) = listener.accept() else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    request.push_str(&line);
                    if line == "\r\n" {
                        break;
                    }
                }
                // Drain a JSON body if present so the next accept is clean.
                if let Some(pos) = request.find("\r\n\r\n") {
                    let head = &request[..pos];
                    let len: usize = head
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    let mut rest = reader.take(len as u64);
                    let mut buf = vec![0u8; len];
                    let _ = rest.read_exact(&mut buf);
                    request.push_str(&String::from_utf8_lossy(&buf));
                }
                seen.lock().unwrap().push(request);
                let mut stream = stream;
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            }
        });
        Mock {
            base: format!("http://127.0.0.1:{port}"),
            requests,
        }
    }

    fn pr_json(number: i64, state: &str, draft: bool, merged: bool) -> String {
        format!(
            r#"{{"number":{number},"title":"T","state":"{state}","draft":{draft},"merged":{merged},"merged_at":{},"html_url":"https://github.com/o/r/pull/{number}","head":{{"sha":"abc123"}},"mergeable":true,"mergeable_state":"clean"}}"#,
            if merged { r#""2024-01-01T00:00:00Z""# } else { "null" }
        )
    }

    #[tokio::test]
    async fn create_and_find_pr() {
        let m = mock(vec![
            (201, pr_json(7, "open", true, false)),
            (200, format!("[{}]", pr_json(7, "open", false, false))),
        ]);
        let created = create_pr(&m.base, "tok", "o", "r", "Title", "Body", "feature", "main", true)
            .await
            .unwrap();
        assert_eq!(created.number, 7);
        assert!(created.draft);
        let found = find_pr(&m.base, "tok", "o", "r", "feature").await.unwrap().unwrap();
        assert_eq!(found.number, 7);
        let requests = m.requests.lock().unwrap();
        assert!(requests[0].starts_with("POST /repos/o/r/pulls"));
        assert!(requests[0].contains("\"draft\":true"));
        assert!(requests[1].contains("head=o%3Afeature") || requests[1].contains("head=feature"));
    }

    #[tokio::test]
    async fn create_pr_validation_error_surfaces() {
        let m = mock(vec![(
            422,
            r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest"}]}"#.into(),
        )]);
        let err = create_pr(&m.base, "tok", "o", "r", "T", "", "h", "b", false)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("422"));
        assert!(err.to_string().contains("Validation Failed"));
    }

    #[tokio::test]
    async fn checks_merge_and_log_tail() {
        let run = r#"{"id":42,"name":"build","status":"completed","conclusion":"failure","started_at":"2024-01-01T00:00:00Z","completed_at":"2024-01-01T00:01:30Z","html_url":"https://github.com/o/r/actions/runs/9/job/42"}"#;
        let m = mock(vec![
            (200, format!(r#"{{"total_count":1,"check_runs":[{run}]}}"#)),
            (200, format!(r#"{{"total_count":1,"check_runs":[{run}]}}"#)),
            (200, r#"{"state":"failure","statuses":[{"context":"ci/legacy","state":"success","target_url":"https://x"}]}"#.into()),
            (200, r#"{"merged":true,"sha":"deadbeef","message":"Merged"}"#.into()),
            (200, "line1\nline2\nline3\nline4\nline5".into()),
        ]);
        let runs = check_runs(&m.base, "tok", "o", "r", "abc").await.unwrap();
        assert_eq!(runs[0].conclusion.as_deref(), Some("failure"));
        let entries = checks(&m.base, "tok", "o", "r", "abc").await.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].duration_ms, Some(90_000));
        assert_eq!(ci_state(&runs, &[]), CiState::Failing);
        let merged = merge_pr(&m.base, "tok", "o", "r", 7, MergeMethod::Squash)
            .await
            .unwrap();
        assert!(merged.merged);
        let tail = job_log_tail(&m.base, "tok", "o", "r", &runs[0], 3).await.unwrap();
        assert_eq!(tail, "line3\nline4\nline5");
        let requests = m.requests.lock().unwrap();
        assert!(requests[3].starts_with("PUT /repos/o/r/pulls/7/merge"));
        assert!(requests[3].contains("\"merge_method\":\"squash\""));
        assert!(requests[4].starts_with("GET /repos/o/r/actions/jobs/42/logs"));
    }

    #[tokio::test]
    async fn rate_limit_and_not_mergeable_surface() {
        let m = mock(vec![
            (403, "{}".into()),
            (
                200,
                pr_json(7, "open", false, false)
                    .replace("\"mergeable\":true", "\"mergeable\":false")
                    .replace("\"mergeable_state\":\"clean\"", "\"mergeable_state\":\"dirty\""),
            ),
        ]);
        // Rate limit needs the headers; this mock doesn't send them, so 403 → Protocol. Use a headered mock instead.
        let _ = m;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut stream = stream;
            let mut buf = [0u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut buf);
            write!(
                stream,
                "HTTP/1.1 403 X\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: 1900000000\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}"
            )
            .unwrap();
        });
        let err = api_get(&format!("http://127.0.0.1:{port}"), "tok", "/x", None)
            .await
            .unwrap_err();
        assert!(matches!(err, ForgeError::RateLimited { until: 1900000000 }));
        let pr = serde_json::from_str::<PullRequest>(
            &pr_json(7, "open", false, false).replace("\"mergeable\":true", "\"mergeable\":false"),
        )
        .unwrap();
        assert_eq!(pr.mergeable, Some(false));
    }

    #[test]
    fn ci_state_rollup() {
        let run = |status: &str, conclusion: Option<&str>| CheckRun {
            name: "x".into(),
            status: status.into(),
            conclusion: conclusion.map(str::to_owned),
            started_at: None,
            completed_at: None,
            html_url: None,
            id: 1,
        };
        assert_eq!(ci_state(&[run("in_progress", None)], &[]), CiState::Pending);
        assert_eq!(ci_state(&[run("completed", Some("success"))], &[]), CiState::Success);
        assert_eq!(ci_state(&[run("completed", Some("failure"))], &[]), CiState::Failing);
        assert_eq!(
            ci_state(
                &[],
                &[CommitStatus {
                    context: "c".into(),
                    state: "pending".into(),
                    target_url: None
                }]
            ),
            CiState::Pending
        );
        assert_eq!(
            ci_state(
                &[],
                &[CommitStatus {
                    context: "c".into(),
                    state: "error".into(),
                    target_url: None
                }]
            ),
            CiState::Failing
        );
    }
}
