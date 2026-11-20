//! Automatic error reports and usage events, sent to the Worker's `POST /v1/reports` (on by default; Settings, Privacy
//! turns it off). The app redacts everything before it gets here; the Worker keeps no network address.

use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct ReportEvent {
    /// Milliseconds since the Unix epoch.
    pub at: i64,
    /// `crash`, `error`, `warning`, `event` or `usage`.
    pub kind: String,
    pub name: String,
    pub message: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportBatch {
    /// A random id made at install (the Worker stores only its hash).
    pub install_id: String,
    pub session: String,
    pub app_version: String,
    pub build: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub locale: String,
    pub log_tail: String,
    pub events: Vec<ReportEvent>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReportError {
    /// The Worker refused the batch for good (malformed or too large): it is dropped, not retried.
    #[error("the server refused the batch: {0}")]
    Refused(u16),
    /// Try again later (offline, rate limited, server error).
    #[error("could not send: {0}")]
    Retry(String),
}

/// Sends one batch.
pub async fn send(base: &str, batch: &ReportBatch) -> Result<(), ReportError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| ReportError::Retry(e.to_string()))?;
    let response = client
        .post(format!("{}/v1/reports", base.trim_end_matches('/')))
        .json(batch)
        .send()
        .await
        .map_err(|e| ReportError::Retry(e.without_url().to_string()))?;
    match response.status().as_u16() {
        200..=299 => Ok(()),
        status @ (400 | 413) => Err(ReportError::Refused(status)),
        other => Err(ReportError::Retry(format!("the server answered {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    fn mock(status: u16) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                head.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let mut stream = stream;
            write!(stream, "HTTP/1.1 {status} X\r\ncontent-length: 2\r\n\r\n{{}}").unwrap();
            format!("{head}{}", String::from_utf8(body).unwrap())
        });
        (base, handle)
    }

    fn batch() -> ReportBatch {
        ReportBatch {
            install_id: "0f3c1d2e-aaaa".into(),
            session: "s".into(),
            app_version: "0.1.20".into(),
            build: "release".into(),
            os: "macos".into(),
            os_version: "15".into(),
            arch: "aarch64".into(),
            locale: "en".into(),
            log_tail: String::new(),
            events: vec![ReportEvent {
                at: 1,
                kind: "error".into(),
                name: "pty.spawn".into(),
                message: "failed".into(),
                data: serde_json::json!({}),
            }],
        }
    }

    #[tokio::test]
    async fn a_batch_is_posted_and_refusals_are_told_from_retries() {
        let (base, server) = mock(200);
        send(&base, &batch()).await.unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/reports"));
        assert!(request.contains("\"name\":\"pty.spawn\""));
        let (base, server) = mock(400);
        assert_eq!(send(&base, &batch()).await, Err(ReportError::Refused(400)));
        server.join().unwrap();
        let (base, server) = mock(429);
        assert!(matches!(send(&base, &batch()).await, Err(ReportError::Retry(_))));
        server.join().unwrap();
    }
}
