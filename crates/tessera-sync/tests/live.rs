//! Against the deployed sync server, only when asked: `TESSERA_SYNC_LIVE_TOKEN=<GitHub token> cargo test -p
//! tessera-sync --test live -- --ignored`. Two devices converge through encrypted documents; the account is deleted
//! at the end so nothing is left on the server.

use serde_json::json;
use tessera_sync::crypto::{derive_key, new_recovery_key};
use tessera_sync::merge::Kind;
use tessera_sync::{DocState, HttpTransport, Transport, sign_in, sync_doc};

const SERVER: &str = "https://tessera-sync.calli-worker.workers.dev";

#[tokio::test]
#[ignore = "needs the live server and a GitHub token"]
async fn two_devices_sync_through_the_live_server_and_the_account_is_deleted() {
    let Ok(github) = std::env::var("TESSERA_SYNC_LIVE_TOKEN") else {
        return;
    };
    let server = std::env::var("TESSERA_SYNC_URL").unwrap_or_else(|_| SERVER.into());
    let a = sign_in(&server, &github).await.expect("sign in A");
    let b = sign_in(&server, &github).await.expect("sign in B");
    assert_eq!(a.user_id, b.user_id);
    let recovery = new_recovery_key().unwrap();
    let key = derive_key(&recovery, &a.user_id).unwrap();
    let device_a = HttpTransport::new(&server, &a.session_token);
    let device_b = HttpTransport::new(&server, &b.session_token);

    let profiles = json!([{"id": "p1", "name": "Default"}]);
    let up = sync_doc(
        &device_a,
        &key,
        "agent-profiles",
        Kind::List,
        &profiles,
        1,
        &DocState::default(),
    )
    .await
    .expect("upload");
    assert!(up.uploaded);
    let down = sync_doc(
        &device_b,
        &key,
        "agent-profiles",
        Kind::List,
        &json!([]),
        0,
        &DocState::default(),
    )
    .await
    .expect("download");
    assert_eq!(down.value, profiles);

    device_a.delete_account().await.expect("delete");
    assert!(
        device_b.list().await.is_err(),
        "the other device's session ends with the account"
    );
}
