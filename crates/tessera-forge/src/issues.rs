//! Issue pickers (FR-54, FR-55): GitHub issues of the project's repository and Linear issues. Both turn into the same
//! `Issue` so the new-task dialog does not care where it came from. Base URLs are injectable for tests.

use crate::{ForgeError, github};
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const LINEAR_API: &str = "https://api.linear.app/graphql";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    /// `github` or `linear`.
    pub provider: String,
    /// The provider's own id (GitHub issue id, Linear uuid).
    pub id: String,
    /// What people call it: `#12` or `ENG-42`.
    pub key: String,
    /// The number part (GitHub issue number, Linear number).
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
    pub labels: Vec<String>,
    pub assignee: Option<String>,
}

/// `owner/repo` of a GitHub remote URL (https, scp-style ssh and ssh://). `None` for any other host.
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("ssh://git@github.com:22/"))
        .or_else(|| {
            // https://user:token@github.com/o/r.git
            url.strip_prefix("https://")
                .and_then(|r| r.split_once('@'))
                .and_then(|(_, r)| r.strip_prefix("github.com/"))
        })?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_owned(), repo.to_owned()))
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

fn github_issue(value: &serde_json::Value) -> Option<Issue> {
    // The issues endpoint also lists pull requests; those are not tasks.
    if value.get("pull_request").is_some() {
        return None;
    }
    let number = value.get("number")?.as_u64()?;
    Some(Issue {
        provider: "github".into(),
        id: value.get("id").map(|v| v.to_string()).unwrap_or_default(),
        key: format!("#{number}"),
        number,
        title: value.get("title")?.as_str()?.to_owned(),
        body: value
            .get("body")
            .and_then(|b| b.as_str())
            .unwrap_or_default()
            .to_owned(),
        url: value
            .get("html_url")
            .and_then(|u| u.as_str())
            .unwrap_or_default()
            .to_owned(),
        labels: value
            .get("labels")
            .and_then(|l| l.as_array())
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        assignee: value
            .get("assignee")
            .and_then(|a| a.get("login"))
            .and_then(|l| l.as_str())
            .map(str::to_owned),
    })
}

/// Open issues of `owner/repo`. An empty query lists the latest; a number (`12` or `#12`) fetches that issue; any
/// other text searches titles and bodies.
pub async fn github_issues(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    query: Option<&str>,
) -> Result<Vec<Issue>, ForgeError> {
    let query = query.map(str::trim).filter(|q| !q.is_empty());
    if let Some(number) = query.and_then(|q| q.trim_start_matches('#').parse::<u64>().ok()) {
        let response = github::api_get(base, token, &format!("/repos/{owner}/{repo}/issues/{number}"), None).await;
        return match response {
            Ok(r) => Ok(github_issue(&r.body).into_iter().collect()),
            // A number that is not an issue is an empty result, not an error.
            Err(ForgeError::Protocol(message)) if message.contains("404") => Ok(Vec::new()),
            Err(e) => Err(e),
        };
    }
    let path = match query {
        None => format!("/repos/{owner}/{repo}/issues?state=open&sort=updated&per_page=50"),
        Some(q) => format!(
            "/search/issues?q={}&per_page=30",
            encode(&format!("repo:{owner}/{repo} is:issue is:open {q}"))
        ),
    };
    let response = github::api_get(base, token, &path, None).await?;
    let list = if query.is_some() {
        response.body.get("items").cloned().unwrap_or_default()
    } else {
        response.body
    };
    Ok(list
        .as_array()
        .map(|items| items.iter().filter_map(github_issue).collect())
        .unwrap_or_default())
}

/// Open issues of `owner/repo` carrying `label`, newest first (for the label trigger of automations).
pub async fn github_issues_labeled(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    label: &str,
) -> Result<Vec<Issue>, ForgeError> {
    let path = format!(
        "/repos/{owner}/{repo}/issues?state=open&labels={}&sort=created&direction=desc&per_page=50",
        encode(label)
    );
    let response = github::api_get(base, token, &path, None).await?;
    Ok(response
        .body
        .as_array()
        .map(|items| items.iter().filter_map(github_issue).collect())
        .unwrap_or_default())
}

async fn linear_post(
    base: &str,
    key: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<serde_json::Value, ForgeError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    let response = client
        .post(base)
        // Personal API keys go in the header as they are, without a Bearer prefix.
        .header("authorization", key)
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.without_url().to_string()))?;
    let status = response.status().as_u16();
    if status == 429 {
        let reset = response
            .headers()
            .get("x-ratelimit-requests-reset")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
            .map(|ms| ms / 1000)
            .unwrap_or(0);
        return Err(ForgeError::RateLimited { until: reset });
    }
    let body: serde_json::Value = response.json().await.map_err(|e| ForgeError::Network(e.to_string()))?;
    if let Some(errors) = body.get("errors").and_then(|e| e.as_array()).filter(|e| !e.is_empty()) {
        let text = errors[0]
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Linear refused the request");
        let kind = errors[0]
            .pointer("/extensions/code")
            .and_then(|c| c.as_str())
            .unwrap_or_default();
        if status == 401 || kind == "AUTHENTICATION_ERROR" || kind == "FORBIDDEN" {
            return Err(ForgeError::NotConnected);
        }
        if kind == "RATELIMITED" {
            return Err(ForgeError::RateLimited { until: 0 });
        }
        return Err(ForgeError::Protocol(format!("Linear: {text}")));
    }
    if status == 401 {
        return Err(ForgeError::NotConnected);
    }
    if !(200..300).contains(&status) {
        return Err(ForgeError::Protocol(format!("Linear API error {status}")));
    }
    Ok(body.get("data").cloned().unwrap_or_default())
}

/// The account behind a Linear API key: its id and display name. The email address is never requested.
pub async fn linear_viewer(base: &str, key: &str) -> Result<(String, String), ForgeError> {
    let data = linear_post(base, key, "query { viewer { id name } }", serde_json::json!({})).await?;
    let viewer = data.get("viewer").ok_or(ForgeError::NotConnected)?;
    Ok((
        viewer.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
        viewer
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
    ))
}

fn linear_issue(value: &serde_json::Value) -> Option<Issue> {
    let key = value.get("identifier")?.as_str()?.to_owned();
    Some(Issue {
        provider: "linear".into(),
        id: value.get("id")?.as_str()?.to_owned(),
        number: value.get("number").and_then(|n| n.as_u64()).unwrap_or(0),
        key,
        title: value.get("title")?.as_str()?.to_owned(),
        body: value
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or_default()
            .to_owned(),
        url: value.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_owned(),
        labels: value
            .pointer("/labels/nodes")
            .and_then(|l| l.as_array())
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        assignee: value
            .pointer("/assignee/name")
            .and_then(|a| a.as_str())
            .map(str::to_owned),
    })
}

/// Open Linear issues (not completed or canceled), newest activity first; `query` filters titles.
pub async fn linear_issues(base: &str, key: &str, query: Option<&str>) -> Result<Vec<Issue>, ForgeError> {
    let query = query.map(str::trim).filter(|q| !q.is_empty());
    const FIELDS: &str = "id identifier number title description url labels { nodes { name } } assignee { name }";
    let (text, variables) = match query {
        None => (
            format!(
                "query {{ issues(first: 40, orderBy: updatedAt, filter: {{ state: {{ type: {{ nin: [\"completed\", \"canceled\"] }} }} }}) {{ nodes {{ {FIELDS} }} }} }}"
            ),
            serde_json::json!({}),
        ),
        Some(q) => (
            format!(
                "query($q: String!) {{ issues(first: 40, orderBy: updatedAt, filter: {{ state: {{ type: {{ nin: [\"completed\", \"canceled\"] }} }}, title: {{ containsIgnoreCase: $q }} }}) {{ nodes {{ {FIELDS} }} }} }}"
            ),
            serde_json::json!({ "q": q }),
        ),
    };
    let data = linear_post(base, key, &text, variables).await?;
    Ok(data
        .pointer("/issues/nodes")
        .and_then(|n| n.as_array())
        .map(|nodes| nodes.iter().filter_map(linear_issue).collect())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    type Reply = (u16, String, Vec<(&'static str, &'static str)>);
    type Seen = Arc<Mutex<Vec<(String, String)>>>;

    /// Replies once per request with the canned (status, body, headers); records "METHOD path" and the body.
    fn mock(replies: Vec<Reply>) -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        std::thread::spawn(move || {
            for (status, body, headers) in replies {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut sent = vec![0u8; length];
                reader.read_exact(&mut sent).unwrap();
                record
                    .lock()
                    .unwrap()
                    .push((first.trim().to_owned(), String::from_utf8_lossy(&sent).into_owned()));
                let mut stream = stream;
                write!(stream, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n").unwrap();
                for (name, value) in headers {
                    write!(stream, "{name}: {value}\r\n").unwrap();
                }
                write!(
                    stream,
                    "content-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        (base, seen)
    }

    #[test]
    fn github_remotes_in_every_common_form() {
        let want = Some(("octo".to_owned(), "repo".to_owned()));
        for url in [
            "https://github.com/octo/repo",
            "https://github.com/octo/repo.git",
            "https://github.com/octo/repo/",
            "git@github.com:octo/repo.git",
            "ssh://git@github.com/octo/repo.git",
            "https://user:tok@github.com/octo/repo.git",
        ] {
            assert_eq!(parse_github_remote(url), want, "{url}");
        }
        for url in [
            "https://gitlab.com/octo/repo.git",
            "git@github.com:octo",
            "",
            "/local/path",
            "https://github.com/octo/a/b",
        ] {
            assert_eq!(parse_github_remote(url), None, "{url}");
        }
    }

    #[test]
    fn query_text_is_percent_encoded() {
        assert_eq!(encode("a b&c#é"), "a%20b%26c%23%C3%A9");
    }

    #[tokio::test]
    async fn github_list_skips_pull_requests_and_reads_labels() {
        let body = r#"[
          {"id":1,"number":12,"title":"Login crash","body":"It crashes","html_url":"https://github.com/o/r/issues/12","labels":[{"name":"bug"}],"assignee":{"login":"me"}},
          {"id":2,"number":13,"title":"A pull request","pull_request":{},"html_url":"x"},
          {"id":3,"number":14,"title":"No body","body":null,"html_url":"https://github.com/o/r/issues/14","labels":[],"assignee":null}
        ]"#;
        let (base, seen) = mock(vec![(200, body.into(), vec![])]);
        let issues = github_issues(&base, "tok", "o", "r", None).await.unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].key, "#12");
        assert_eq!(issues[0].labels, ["bug"]);
        assert_eq!(issues[0].assignee.as_deref(), Some("me"));
        assert_eq!(issues[1].body, "");
        assert!(
            seen.lock().unwrap()[0]
                .0
                .starts_with("GET /repos/o/r/issues?state=open")
        );
    }

    #[tokio::test]
    async fn github_number_query_fetches_one_issue_and_unknown_number_is_empty() {
        let one = r#"{"id":9,"number":7,"title":"Seven","body":"b","html_url":"u","labels":[]}"#;
        let (base, seen) = mock(vec![(200, one.into(), vec![]), (404, "{}".into(), vec![])]);
        let found = github_issues(&base, "t", "o", "r", Some("#7")).await.unwrap();
        assert_eq!(found[0].title, "Seven");
        assert_eq!(seen.lock().unwrap()[0].0, "GET /repos/o/r/issues/7 HTTP/1.1");
        assert!(github_issues(&base, "t", "o", "r", Some("8")).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn github_text_query_searches_the_repository() {
        let (base, seen) = mock(vec![(
            200,
            r#"{"items":[{"id":1,"number":3,"title":"Match","html_url":"u"}]}"#.into(),
            vec![],
        )]);
        let found = github_issues(&base, "t", "o", "r", Some("login bug")).await.unwrap();
        assert_eq!(found[0].key, "#3");
        let request = seen.lock().unwrap()[0].0.clone();
        assert!(
            request.starts_with("GET /search/issues?q=repo%3Ao%2Fr%20is%3Aissue%20is%3Aopen%20login%20bug"),
            "{request}"
        );
    }

    #[tokio::test]
    async fn labeled_issues_ask_for_the_label_and_skip_pull_requests() {
        let body = r#"[{"id":1,"number":5,"title":"Do it","html_url":"u"},{"id":2,"number":6,"title":"PR","pull_request":{},"html_url":"u"}]"#;
        let (base, seen) = mock(vec![(200, body.into(), vec![])]);
        let found = github_issues_labeled(&base, "t", "o", "r", "needs tessera")
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        let request = seen.lock().unwrap()[0].0.clone();
        assert!(request.contains("labels=needs%20tessera"), "{request}");
    }

    #[tokio::test]
    async fn github_rate_limit_is_reported() {
        let (base, _) = mock(vec![(
            403,
            "{}".into(),
            vec![("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "1700000000")],
        )]);
        match github_issues(&base, "t", "o", "r", None).await {
            Err(ForgeError::RateLimited { until }) => assert_eq!(until, 1_700_000_000),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn linear_viewer_sends_the_key_as_is_and_never_asks_for_the_email() {
        let (base, seen) = mock(vec![(
            200,
            r#"{"data":{"viewer":{"id":"u1","name":"Ada"}}}"#.into(),
            vec![],
        )]);
        assert_eq!(
            linear_viewer(&base, "lin_api_key").await.unwrap(),
            ("u1".into(), "Ada".into())
        );
        let body = seen.lock().unwrap()[0].1.clone();
        assert!(body.contains("viewer { id name }"));
        assert!(!body.contains("email"));
    }

    #[tokio::test]
    async fn linear_issues_parse_and_filter() {
        let data = r#"{"data":{"issues":{"nodes":[
          {"id":"i1","identifier":"ENG-42","number":42,"title":"Fix login","description":"Steps","url":"https://linear.app/x/issue/ENG-42","labels":{"nodes":[{"name":"Bug"}]},"assignee":{"name":"Ada"}},
          {"id":"i2","identifier":"ENG-43","number":43,"title":"No extras","description":null,"url":"u","labels":{"nodes":[]},"assignee":null}
        ]}}}"#;
        let (base, seen) = mock(vec![(200, data.into(), vec![]), (200, data.into(), vec![])]);
        let all = linear_issues(&base, "k", None).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].key, "ENG-42");
        assert_eq!(all[0].labels, ["Bug"]);
        assert_eq!(all[1].body, "");
        linear_issues(&base, "k", Some("login")).await.unwrap();
        let sent = seen.lock().unwrap();
        assert!(!sent[0].1.contains("containsIgnoreCase"));
        assert!(sent[1].1.contains("containsIgnoreCase"));
        assert!(sent[1].1.contains("\"q\":\"login\""));
    }

    #[tokio::test]
    async fn linear_bad_key_and_rate_limit_map_to_typed_errors() {
        let bad = r#"{"errors":[{"message":"nope","extensions":{"code":"AUTHENTICATION_ERROR"}}]}"#;
        let (base, _) = mock(vec![
            (400, bad.into(), vec![]),
            (429, "{}".into(), vec![("x-ratelimit-requests-reset", "1700000000000")]),
        ]);
        assert!(matches!(
            linear_viewer(&base, "bad").await,
            Err(ForgeError::NotConnected)
        ));
        assert!(matches!(
            linear_issues(&base, "k", None).await,
            Err(ForgeError::RateLimited { until: 1_700_000_000 })
        ));
    }
}
