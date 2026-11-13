//! Sending feedback from the app (reports, ideas, screenshots) to the Worker's `POST /v1/feedback`. It runs only when a
//! person presses Send; the Worker keeps no network address, only a salted hash for a rate limit.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Feedback {
    /// `bug`, `idea`, `design` or `other`.
    pub kind: String,
    pub title: String,
    pub body: String,
    pub contact: String,
    pub app_version: String,
    pub os: String,
    pub report: String,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FeedbackError {
    /// The Worker refused the content (the text says why).
    #[error("{0}")]
    Refused(String),
    #[error("Too many reports from this connection in the last hour. Try again later.")]
    TooMany,
    #[error("The report is too large. Remove a screenshot or shorten the text.")]
    TooLarge,
    #[error("Could not reach the feedback server: {0}")]
    Network(String),
}

#[derive(Deserialize)]
struct Sent {
    id: String,
}

#[derive(Deserialize)]
struct Refusal {
    error: Option<String>,
}

/// Sends one report and returns its reference (for example `F-1a2b3c4d`).
pub async fn send(base: &str, feedback: &Feedback) -> Result<String, FeedbackError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| FeedbackError::Network(e.to_string()))?;
    let response = client
        .post(format!("{}/v1/feedback", base.trim_end_matches('/')))
        .json(feedback)
        .send()
        .await
        .map_err(|e| FeedbackError::Network(e.without_url().to_string()))?;
    let status = response.status().as_u16();
    match status {
        200 => response
            .json::<Sent>()
            .await
            .map(|s| s.id)
            .map_err(|e| FeedbackError::Network(e.to_string())),
        429 => Err(FeedbackError::TooMany),
        413 => Err(FeedbackError::TooLarge),
        400 => {
            let reason = response.json::<Refusal>().await.ok().and_then(|r| r.error);
            Err(FeedbackError::Refused(
                reason.unwrap_or_else(|| "The server did not accept the report.".into()),
            ))
        }
        other => Err(FeedbackError::Network(format!("the server answered {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    fn mock(status: u16, body: &str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let body = body.to_owned();
        let handle = std::thread::spawn(move || {
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
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
            }
            let mut sent = vec![0u8; length];
            reader.read_exact(&mut sent).unwrap();
            let mut stream = stream;
            write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            format!("{}\n{}", first.trim(), String::from_utf8_lossy(&sent))
        });
        (base, handle)
    }

    fn feedback() -> Feedback {
        Feedback {
            kind: "bug".into(),
            title: "It broke".into(),
            body: "Details".into(),
            contact: String::new(),
            app_version: "0.1.2".into(),
            os: "macos".into(),
            report: "log".into(),
            attachments: vec![Attachment {
                name: "a.png".into(),
                mime: "image/png".into(),
                data_base64: "QUJD".into(),
            }],
        }
    }

    #[tokio::test]
    async fn a_report_is_posted_as_json_and_the_reference_comes_back() {
        let (base, seen) = mock(200, r#"{"id":"F-1a2b3c4d"}"#);
        assert_eq!(send(&base, &feedback()).await.unwrap(), "F-1a2b3c4d");
        let request = seen.join().unwrap();
        assert!(request.starts_with("POST /v1/feedback HTTP/1.1"));
        assert!(request.contains(r#""kind":"bug""#));
        assert!(request.contains(r#""data_base64":"QUJD""#));
    }

    #[tokio::test]
    async fn refusals_rate_limit_size_and_server_errors_are_told_apart() {
        let (base, _) = mock(400, r#"{"error":"a title is required"}"#);
        assert_eq!(
            send(&base, &feedback()).await,
            Err(FeedbackError::Refused("a title is required".into()))
        );
        let (base, _) = mock(429, "{}");
        assert_eq!(send(&base, &feedback()).await, Err(FeedbackError::TooMany));
        let (base, _) = mock(413, "{}");
        assert_eq!(send(&base, &feedback()).await, Err(FeedbackError::TooLarge));
        let (base, _) = mock(500, "{}");
        assert!(matches!(send(&base, &feedback()).await, Err(FeedbackError::Network(_))));
        assert!(matches!(
            send("http://127.0.0.1:9", &feedback()).await,
            Err(FeedbackError::Network(_))
        ));
    }
}
