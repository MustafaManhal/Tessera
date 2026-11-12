//! Optional end-to-end encrypted sync client (TRD 4.15, M11, FR-70…FR-72).
//!
//! Everything works without it (FR-72). When the user signs in with GitHub, chosen documents (settings, agent
//! profiles, the project list, later the prompt library) are sealed on the device ([`crypto`]) and stored as opaque
//! versioned blobs by the Tessera sync Worker (`services/sync`). Never terminal output, code or secrets.
//!
//! [`sync_doc`] brings one document up to date: upload when only this device changed it, take the server's copy when
//! only the server changed, merge ([`merge`]) when both did, and retry on a version conflict.

pub mod crypto;
pub mod github;
pub mod merge;
pub mod transport;

use crypto::{CryptoError, Sealed, SyncKey};
use merge::Kind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use transport::{HttpTransport, RemoteBlob, RemoteDoc, Session, Transport, sign_in};

/// Sync errors.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    /// Encryption problem (most often a wrong recovery key).
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    /// The server refused the session.
    #[error("You are signed out of sync. Sign in again.")]
    Unauthorized,
    /// Network or server trouble.
    #[error("The sync server could not be reached: {0}")]
    Network(String),
    /// The server answered something unexpected.
    #[error("The sync server sent an unexpected answer: {0}")]
    Protocol(String),
    /// A document did not settle after several conflicts in a row.
    #[error("Another device kept changing {0}; try again in a moment.")]
    Busy(String),
}

/// What this device remembers about one document between syncs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DocState {
    /// Server version of the last synced copy (0: never synced).
    pub version: i64,
    /// The last synced plaintext, the base of the next three-way merge.
    pub base: Option<Value>,
}

/// The result of syncing one document.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    /// The document as it should now be on this device.
    pub value: Value,
    /// It differs from what this device had: apply it.
    pub changed_local: bool,
    /// This device's copy was uploaded.
    pub uploaded: bool,
    /// State to remember until the next sync.
    pub state: DocState,
}

const ATTEMPTS: usize = 3;

fn seal_value(key: &SyncKey, doc: &str, value: &Value) -> Result<Sealed, SyncError> {
    let bytes = serde_json::to_vec(value).map_err(|e| SyncError::Protocol(e.to_string()))?;
    Ok(crypto::seal(key, doc, &bytes)?)
}

fn open_value(key: &SyncKey, doc: &str, blob: &RemoteBlob) -> Result<Value, SyncError> {
    let bytes = crypto::open(key, doc, &blob.sealed)?;
    serde_json::from_slice(&bytes).map_err(|e| SyncError::Protocol(e.to_string()))
}

/// Brings one document up to date. `local_modified_at` (milliseconds) decides last-writer-wins against the server
/// copy's `updated_at` when both sides changed.
///
/// # Errors
/// [`SyncError`]; nothing local changes on an error.
pub async fn sync_doc<T: Transport>(
    transport: &T,
    key: &SyncKey,
    doc: &str,
    kind: Kind,
    local: &Value,
    local_modified_at: i64,
    state: &DocState,
) -> Result<Outcome, SyncError> {
    for _ in 0..ATTEMPTS {
        let meta = transport.list().await?.into_iter().find(|d| d.doc == doc);
        let remote_version = meta.as_ref().map_or(0, |m| m.version);
        if remote_version == state.version {
            if state.base.as_ref() == Some(local) {
                return Ok(Outcome {
                    value: local.clone(),
                    changed_local: false,
                    uploaded: false,
                    state: state.clone(),
                });
            }
            match transport.put(doc, state.version, &seal_value(key, doc, local)?).await? {
                Ok(version) => {
                    return Ok(Outcome {
                        value: local.clone(),
                        changed_local: false,
                        uploaded: true,
                        state: DocState {
                            version,
                            base: Some(local.clone()),
                        },
                    });
                }
                Err(_conflict) => continue,
            }
        }
        let Some(blob) = transport.get(doc).await? else {
            continue; // deleted between list and get
        };
        let remote = open_value(key, doc, &blob)?;
        let local_newer = local_modified_at > meta.as_ref().map_or(0, |m| m.updated_at);
        let merged = merge::merge(kind, state.base.as_ref(), local, &remote, local_newer);
        let (version, uploaded) = if merged == remote {
            (blob.version, false)
        } else {
            match transport
                .put(doc, blob.version, &seal_value(key, doc, &merged)?)
                .await?
            {
                Ok(version) => (version, true),
                Err(_conflict) => continue,
            }
        };
        return Ok(Outcome {
            changed_local: &merged != local,
            value: merged.clone(),
            uploaded,
            state: DocState {
                version,
                base: Some(merged),
            },
        });
    }
    Err(SyncError::Busy(doc.to_owned()))
}

#[cfg(test)]
mod tests;
