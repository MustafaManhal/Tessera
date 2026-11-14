//! The engine against an in-memory server with the same rules as the Worker (versions, 409 on a stale base).

use super::*;
use crate::crypto::{derive_key, new_recovery_key};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Default)]
struct Memory {
    docs: Mutex<BTreeMap<String, (i64, i64, Sealed)>>,
    clock: Mutex<i64>,
    /// Puts to fail with a conflict before succeeding (another device racing).
    races: Mutex<usize>,
}

impl Memory {
    fn tick(&self) -> i64 {
        let mut clock = self.clock.lock().unwrap();
        *clock += 10;
        *clock
    }
}

impl Transport for Memory {
    async fn list(&self) -> Result<Vec<RemoteDoc>, SyncError> {
        Ok(self
            .docs
            .lock()
            .unwrap()
            .iter()
            .map(|(doc, (version, at, _))| RemoteDoc {
                doc: doc.clone(),
                version: *version,
                updated_at: *at,
            })
            .collect())
    }
    async fn get(&self, doc: &str) -> Result<Option<RemoteBlob>, SyncError> {
        Ok(self
            .docs
            .lock()
            .unwrap()
            .get(doc)
            .map(|(version, _, sealed)| RemoteBlob {
                version: *version,
                sealed: sealed.clone(),
            }))
    }
    async fn put(&self, doc: &str, base: i64, sealed: &Sealed) -> Result<Result<i64, i64>, SyncError> {
        let at = self.tick();
        let mut docs = self.docs.lock().unwrap();
        let current = docs.get(doc).map_or(0, |d| d.0);
        let mut races = self.races.lock().unwrap();
        if *races > 0 {
            *races -= 1;
            return Ok(Err(current));
        }
        if base != current {
            return Ok(Err(current));
        }
        docs.insert(doc.into(), (current + 1, at, sealed.clone()));
        Ok(Ok(current + 1))
    }
    async fn delete_account(&self) -> Result<(), SyncError> {
        self.docs.lock().unwrap().clear();
        Ok(())
    }
}

#[tokio::test]
async fn two_devices_converge_and_the_server_only_sees_ciphertext() {
    let server = Memory::default();
    let key = derive_key(&new_recovery_key().unwrap(), "7").unwrap();
    let settings = json!({"theme": "dark"});

    // Device A uploads.
    let a = sync_doc(
        &server,
        &key,
        "settings",
        Kind::Whole,
        &settings,
        1,
        &DocState::default(),
    )
    .await
    .unwrap();
    assert!(a.uploaded && !a.changed_local);
    let stored = server.docs.lock().unwrap().get("settings").unwrap().2.clone();
    assert!(!stored.ciphertext.contains("dark"));

    // Device B, never synced, has nothing: it takes the server copy.
    let b = sync_doc(
        &server,
        &key,
        "settings",
        Kind::Whole,
        &json!(null),
        0,
        &DocState::default(),
    )
    .await
    .unwrap();
    assert!(b.changed_local);
    assert_eq!(b.value, settings);

    // Nothing changed: no upload.
    let again = sync_doc(&server, &key, "settings", Kind::Whole, &settings, 2, &a.state)
        .await
        .unwrap();
    assert!(!again.uploaded && !again.changed_local);
}

#[tokio::test]
async fn lists_edited_on_both_devices_merge_three_ways() {
    let server = Memory::default();
    let key = derive_key(&new_recovery_key().unwrap(), "7").unwrap();
    let base = json!([{"id": "p1", "model": "a"}, {"id": "p2", "model": "a"}]);
    let first = sync_doc(
        &server,
        &key,
        "agent-profiles",
        Kind::List,
        &base,
        1,
        &DocState::default(),
    )
    .await
    .unwrap();
    let mut b_state = first.state.clone();

    // A edits p1 and uploads.
    let a_local = json!([{"id": "p1", "model": "b"}, {"id": "p2", "model": "a"}]);
    sync_doc(&server, &key, "agent-profiles", Kind::List, &a_local, 5, &first.state)
        .await
        .unwrap();

    // B (still on the old base) deletes p2 and adds p3.
    let b_local = json!([{"id": "p1", "model": "a"}, {"id": "p3", "model": "c"}]);
    let merged = sync_doc(&server, &key, "agent-profiles", Kind::List, &b_local, 6, &b_state)
        .await
        .unwrap();
    assert_eq!(
        merged.value,
        json!([{"id": "p1", "model": "b"}, {"id": "p3", "model": "c"}])
    );
    assert!(merged.uploaded && merged.changed_local);
    b_state = merged.state;
    assert_eq!(b_state.version, 3);
}

#[tokio::test]
async fn a_conflict_is_retried_and_a_wrong_key_changes_nothing() {
    let server = Memory::default();
    let key = derive_key(&new_recovery_key().unwrap(), "7").unwrap();
    *server.races.lock().unwrap() = 1;
    let outcome = sync_doc(
        &server,
        &key,
        "settings",
        Kind::Whole,
        &json!({"a": 1}),
        1,
        &DocState::default(),
    )
    .await
    .unwrap();
    assert!(outcome.uploaded);

    let wrong = derive_key(&new_recovery_key().unwrap(), "7").unwrap();
    let error = sync_doc(
        &server,
        &wrong,
        "settings",
        Kind::Whole,
        &json!({"a": 2}),
        1,
        &DocState::default(),
    )
    .await;
    assert!(matches!(error, Err(SyncError::Crypto(_))));

    *server.races.lock().unwrap() = 10;
    let busy = sync_doc(
        &server,
        &key,
        "settings",
        Kind::Whole,
        &json!({"a": 3}),
        9,
        &outcome.state,
    )
    .await;
    assert!(matches!(busy, Err(SyncError::Busy(_))));
}
