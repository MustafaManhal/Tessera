//! GitHub device flow + minimal REST client. The base URL is injectable so tests run against a local mock.

use crate::ForgeError;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Public OAuth client id (O-4); device flow needs no secret.
pub const CLIENT_ID: &str = "Ov23li0Re0ll2FYkPB6S";
const SCOPES: &str = "repo read:org";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePoll {
    Pending,
    SlowDown(u64),
    Token(String),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubUser {
    pub login: String,
    pub id: u64,
    pub avatar_url: Option<String>,
}

/// What one REST call reports back alongside the body.
#[derive(Debug, Clone)]
pub struct ApiResponse {
    pub status: u16,
    pub body: serde_json::Value,
    /// `x-ratelimit-remaining` after this call.
    pub rate_remaining: Option<u32>,
    /// `x-ratelimit-reset` (unix seconds) when remaining hits zero.
    pub rate_reset: Option<i64>,
    pub etag: Option<String>,
}

fn http() -> Result<reqwest::Client, ForgeError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| ForgeError::Network(e.to_string()))
}

pub async fn device_start(base: &str) -> Result<DeviceStart, ForgeError> {
    let response = http()?
        .post(format!("{base}/login/device/code"))
        .header("accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPES)])
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.without_url().to_string()))?;
    let value: serde_json::Value = response.json().await.map_err(|e| ForgeError::Network(e.to_string()))?;
    if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
        return Err(ForgeError::Protocol(format!("GitHub refused the sign-in: {error}")));
    }
    serde_json::from_value(value).map_err(|e| ForgeError::Protocol(e.to_string()))
}

pub async fn device_poll(base: &str, device_code: &str) -> Result<DevicePoll, ForgeError> {
    let response = http()?
        .post(format!("{base}/login/oauth/access_token"))
        .header("accept", "application/json")
        .form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.without_url().to_string()))?;
    let value: serde_json::Value = response.json().await.map_err(|e| ForgeError::Network(e.to_string()))?;
    Ok(interpret(&value))
}

fn interpret(value: &serde_json::Value) -> DevicePoll {
    if let Some(token) = value.get("access_token").and_then(|t| t.as_str()) {
        return DevicePoll::Token(token.to_owned());
    }
    match value.get("error").and_then(|e| e.as_str()) {
        Some("authorization_pending") => DevicePoll::Pending,
        Some("slow_down") => {
            DevicePoll::SlowDown(value.get("interval").and_then(serde_json::Value::as_u64).unwrap_or(10))
        }
        Some("expired_token") => DevicePoll::Failed("expired".into()),
        Some("access_denied") => DevicePoll::Failed("denied".into()),
        Some(other) => DevicePoll::Failed(other.to_owned()),
        None => DevicePoll::Failed("unexpected".into()),
    }
}

/// `gh auth token` from the login PATH; `None` when gh is missing or not logged in.
pub fn gh_token() -> Option<String> {
    let output = std::process::Command::new("gh").args(["auth", "token"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!token.is_empty()).then_some(token)
}

/// GET against the API with bearer auth; records rate-limit headers, honours `If-None-Match` (304 → body null).
pub async fn api_get(base: &str, token: &str, path: &str, etag: Option<&str>) -> Result<ApiResponse, ForgeError> {
    let mut request = http()?
        .get(format!("{base}{path}"))
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json");
    if let Some(etag) = etag {
        request = request.header("if-none-match", etag);
    }
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
    let etag_out = headers.get("etag").and_then(|v| v.to_str().ok()).map(str::to_owned);
    if status == 304 {
        return Ok(ApiResponse {
            status,
            body: serde_json::Value::Null,
            rate_remaining: remaining,
            rate_reset: reset,
            etag: etag_out,
        });
    }
    if status == 403 || status == 429 {
        if remaining == Some(0) {
            return Err(ForgeError::RateLimited {
                until: reset.unwrap_or(0),
            });
        }
        return Err(ForgeError::Protocol(format!("GitHub API error {status}")));
    }
    if !(200..300).contains(&status) {
        return Err(ForgeError::Protocol(format!("GitHub API error {status}")));
    }
    let body = response.json().await.map_err(|e| ForgeError::Network(e.to_string()))?;
    Ok(ApiResponse {
        status,
        body,
        rate_remaining: remaining,
        rate_reset: reset,
        etag: etag_out,
    })
}

pub async fn me(base: &str, token: &str) -> Result<GithubUser, ForgeError> {
    let response = api_get(base, token, "/user", None).await?;
    serde_json::from_value(response.body).map_err(|e| ForgeError::Protocol(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    /// Minimal one-shot HTTP/1.1 mock: reads requests, replies with canned status+body.
    struct Mock {
        base: String,
    }

    type Reply = (u16, String, Vec<(String, String)>);

    fn mock(replies: Vec<Reply>) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        std::thread::spawn(move || {
            for (status, body, headers) in replies {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    request.push_str(&line);
                }
                seen.lock().unwrap().push(request);
                let mut stream = stream;
                write!(stream, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n").unwrap();
                for (k, v) in headers {
                    write!(stream, "{k}: {v}\r\n").unwrap();
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
        Mock {
            base: format!("http://127.0.0.1:{port}"),
        }
    }

    #[tokio::test]
    async fn device_flow_success_pending_slowdown_expired_denied() {
        // One server per scenario is simpler than sequencing; run four mocks.
        let start = mock(vec![(200, r#"{"device_code":"dc","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#.into(), vec![])]);
        let s = device_start(&start.base).await.unwrap();
        assert_eq!(s.user_code, "WDJB-MJHT");

        let poll = |body: &str| {
            let m = mock(vec![(200, body.into(), vec![])]);
            let base = m.base.clone();
            async move { device_poll(&base, "dc").await.unwrap() }
        };
        assert_eq!(
            poll(r#"{"access_token":"gho_x","token_type":"bearer"}"#).await,
            DevicePoll::Token("gho_x".into())
        );
        assert_eq!(poll(r#"{"error":"authorization_pending"}"#).await, DevicePoll::Pending);
        assert_eq!(
            poll(r#"{"error":"slow_down","interval":15}"#).await,
            DevicePoll::SlowDown(15)
        );
        assert_eq!(
            poll(r#"{"error":"expired_token"}"#).await,
            DevicePoll::Failed("expired".into())
        );
        assert_eq!(
            poll(r#"{"error":"access_denied"}"#).await,
            DevicePoll::Failed("denied".into())
        );
    }

    #[tokio::test]
    async fn rate_limit_and_etag() {
        let m = mock(vec![
            (
                403,
                "{}".into(),
                vec![
                    ("x-ratelimit-remaining".into(), "0".into()),
                    ("x-ratelimit-reset".into(), "1900000000".into()),
                ],
            ),
            (304, String::new(), vec![("etag".into(), "\"abc\"".into())]),
            (200, r#"{"login":"octo","id":1}"#.into(), vec![]),
        ]);
        let err = api_get(&m.base, "tok", "/rate_limit", None).await.unwrap_err();
        assert!(matches!(err, ForgeError::RateLimited { until: 1900000000 }));
        let cached = api_get(&m.base, "tok", "/user", Some("\"abc\"")).await.unwrap();
        assert_eq!(cached.status, 304);
        assert_eq!(cached.body, serde_json::Value::Null);
        let user = me(&m.base, "tok").await.unwrap();
        assert_eq!(user.login, "octo");
    }
}
