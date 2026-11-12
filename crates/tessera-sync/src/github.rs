//! GitHub sign-in by device flow (no browser redirect, no client secret): the app shows a short code, the user enters
//! it at github.com/login/device, and the app polls until GitHub hands out a token. The token is used once, to sign in
//! to the sync server, and is not stored.

use crate::SyncError;
use serde::{Deserialize, Serialize};

/// The public OAuth client id of the Tessera GitHub app (O-4). Device flow needs no secret.
pub const CLIENT_ID: &str = match option_env!("TESSERA_GITHUB_CLIENT_ID") {
    Some(id) => id,
    None => "Ov23li0Re0ll2FYkPB6S",
};

/// What the user needs to finish sign-in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceStart {
    /// Kept by the app to poll.
    pub device_code: String,
    /// Shown to the user, for example `WDJB-MJHT`.
    pub user_code: String,
    /// Where to type it.
    pub verification_uri: String,
    /// Seconds until the code expires.
    pub expires_in: u64,
    /// Minimum seconds between polls.
    pub interval: u64,
}

/// One poll's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePoll {
    /// The user has not finished yet.
    Pending,
    /// Poll more slowly (the new interval in seconds).
    SlowDown(u64),
    /// Signed in: the GitHub access token.
    Token(String),
    /// The code expired or the user declined.
    Failed(String),
}

fn client() -> Result<reqwest::Client, SyncError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| SyncError::Network(e.to_string()))
}

/// Starts the device flow.
///
/// # Errors
/// Network errors; [`SyncError::Protocol`] when GitHub refuses (for example device flow not enabled for the app).
pub async fn device_start() -> Result<DeviceStart, SyncError> {
    let response = client()?
        .post("https://github.com/login/device/code")
        .header("accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", "")])
        .send()
        .await
        .map_err(|e| SyncError::Network(e.without_url().to_string()))?;
    let value: serde_json::Value = response.json().await.map_err(|e| SyncError::Network(e.to_string()))?;
    if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
        return Err(SyncError::Protocol(format!("GitHub refused the sign-in: {error}")));
    }
    serde_json::from_value(value).map_err(|e| SyncError::Protocol(e.to_string()))
}

/// Polls once for the token.
///
/// # Errors
/// Network errors.
pub async fn device_poll(device_code: &str) -> Result<DevicePoll, SyncError> {
    let response = client()?
        .post("https://github.com/login/oauth/access_token")
        .header("accept", "application/json")
        .form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| SyncError::Network(e.without_url().to_string()))?;
    let value: serde_json::Value = response.json().await.map_err(|e| SyncError::Network(e.to_string()))?;
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
        Some("expired_token") => DevicePoll::Failed("The sign-in code expired. Start again.".into()),
        Some("access_denied") => DevicePoll::Failed("Sign-in was cancelled on GitHub.".into()),
        Some(other) => DevicePoll::Failed(format!("GitHub refused the sign-in: {other}")),
        None => DevicePoll::Failed("GitHub sent an unexpected answer.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn poll_answers_map_to_states() {
        assert_eq!(
            interpret(&json!({"access_token": "gho_x", "token_type": "bearer"})),
            DevicePoll::Token("gho_x".into())
        );
        assert_eq!(
            interpret(&json!({"error": "authorization_pending"})),
            DevicePoll::Pending
        );
        assert_eq!(
            interpret(&json!({"error": "slow_down", "interval": 15})),
            DevicePoll::SlowDown(15)
        );
        assert!(matches!(
            interpret(&json!({"error": "expired_token"})),
            DevicePoll::Failed(_)
        ));
        assert!(matches!(
            interpret(&json!({"error": "access_denied"})),
            DevicePoll::Failed(_)
        ));
        assert!(matches!(interpret(&json!({})), DevicePoll::Failed(_)));
    }
}
