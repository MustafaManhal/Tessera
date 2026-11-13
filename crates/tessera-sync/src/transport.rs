//! The sync server API (05-backend-schema §8) and its HTTPS client.

use crate::SyncError;
use crate::crypto::Sealed;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// One document in the server's list.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct RemoteDoc {
    /// Document name.
    pub doc: String,
    /// Server version.
    pub version: i64,
    /// Last change, milliseconds.
    pub updated_at: i64,
}

/// A sealed document with its version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteBlob {
    /// Server version.
    pub version: i64,
    /// Ciphertext and nonce.
    pub sealed: Sealed,
}

/// A signed-in session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    /// Bearer token for the sync server.
    pub session_token: String,
    /// Account id (the salt of the document key).
    pub user_id: String,
}

/// The server operations the engine needs. `put` answers `Ok(Ok(new_version))`, or `Ok(Err(current_version))` when
/// `base_version` is stale (HTTP 409).
#[allow(async_fn_in_trait)]
pub trait Transport {
    /// All documents of the account.
    async fn list(&self) -> Result<Vec<RemoteDoc>, SyncError>;
    /// One document, or `None` when it does not exist.
    async fn get(&self, doc: &str) -> Result<Option<RemoteBlob>, SyncError>;
    /// Stores a new version if `base_version` is still current.
    async fn put(&self, doc: &str, base_version: i64, sealed: &Sealed) -> Result<Result<i64, i64>, SyncError>;
    /// Deletes the account and every document (FR-71).
    async fn delete_account(&self) -> Result<(), SyncError>;
}

/// HTTPS client of the Worker.
pub struct HttpTransport {
    base: String,
    token: String,
    client: reqwest::Client,
}

fn network(error: reqwest::Error) -> SyncError {
    SyncError::Network(error.without_url().to_string())
}

impl HttpTransport {
    /// A client for `base_url` (for example `https://tessera-sync.<account>.workers.dev`) with a session token.
    #[must_use]
    pub fn new(base_url: &str, session_token: &str) -> Self {
        Self {
            base: base_url.trim_end_matches('/').to_owned(),
            token: session_token.to_owned(),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn check(status: reqwest::StatusCode) -> Result<(), SyncError> {
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(SyncError::Unauthorized);
        }
        if !status.is_success() {
            return Err(SyncError::Protocol(format!("HTTP {status}")));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct DocBody {
    version: i64,
    ciphertext: String,
    nonce: String,
}

#[derive(Deserialize)]
struct VersionBody {
    version: i64,
}

impl Transport for HttpTransport {
    async fn list(&self) -> Result<Vec<RemoteDoc>, SyncError> {
        let response = self
            .client
            .get(self.url("/v1/docs"))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(network)?;
        Self::check(response.status())?;
        response.json().await.map_err(network)
    }

    async fn get(&self, doc: &str) -> Result<Option<RemoteBlob>, SyncError> {
        let response = self
            .client
            .get(self.url(&format!("/v1/docs/{doc}")))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(network)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Self::check(response.status())?;
        let body: DocBody = response.json().await.map_err(network)?;
        Ok(Some(RemoteBlob {
            version: body.version,
            sealed: Sealed {
                ciphertext: body.ciphertext,
                nonce: body.nonce,
            },
        }))
    }

    async fn put(&self, doc: &str, base_version: i64, sealed: &Sealed) -> Result<Result<i64, i64>, SyncError> {
        let response = self
            .client
            .put(self.url(&format!("/v1/docs/{doc}")))
            .bearer_auth(&self.token)
            .json(&json!({"base_version": base_version, "ciphertext": sealed.ciphertext, "nonce": sealed.nonce}))
            .send()
            .await
            .map_err(network)?;
        if response.status() == reqwest::StatusCode::CONFLICT {
            let body: VersionBody = response.json().await.map_err(network)?;
            return Ok(Err(body.version));
        }
        Self::check(response.status())?;
        let body: VersionBody = response.json().await.map_err(network)?;
        Ok(Ok(body.version))
    }

    async fn delete_account(&self) -> Result<(), SyncError> {
        let response = self
            .client
            .delete(self.url("/v1/account"))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(network)?;
        Self::check(response.status())
    }
}

/// Exchanges a GitHub access token (from the device flow) for a sync session. The Worker only asks GitHub who the
/// token belongs to; it keeps neither the token nor anything else from GitHub.
///
/// # Errors
/// [`SyncError::Unauthorized`] when GitHub rejects the token; network errors.
pub async fn sign_in(base_url: &str, github_token: &str) -> Result<Session, SyncError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("Tessera/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(network)?;
    let response = client
        .post(format!("{}/v1/auth/github", base_url.trim_end_matches('/')))
        .json(&json!({"access_token": github_token}))
        .send()
        .await
        .map_err(network)?;
    HttpTransport::check(response.status())?;
    response.json().await.map_err(network)
}

/// Ends a session on the server (best effort on sign-out).
///
/// # Errors
/// Network errors.
pub async fn logout(base_url: &str, session_token: &str) -> Result<(), SyncError> {
    let transport = HttpTransport::new(base_url, session_token);
    let response = transport
        .client
        .post(transport.url("/v1/auth/logout"))
        .bearer_auth(&transport.token)
        .send()
        .await
        .map_err(network)?;
    HttpTransport::check(response.status())
}
