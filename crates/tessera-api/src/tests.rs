use super::*;
fn server() -> (tempfile::TempDir, Endpoint, Server) {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint = Endpoint::new(tmp.path());
    let server = Server::start(
        endpoint.clone(),
        Arc::new(|method: &str, params: Value| {
            if method == "echo" {
                Ok(params)
            } else {
                Err(RpcError::method_not_found())
            }
        }),
    )
    .unwrap();
    (tmp, endpoint, server)
}
fn raw(endpoint: &Endpoint, request: &[u8]) -> Value {
    // Blocking with a timeout, like the real client: a non-blocking pipe on Windows reads "no data yet" as end of file.
    let mut stream = ConnectOptions::new()
        .name(endpoint.name().unwrap())
        .connect_sync()
        .unwrap();
    let _ = stream.set_recv_timeout(Some(Duration::from_millis(500)));
    let _ = write_deadline(&mut stream, request, Instant::now() + Duration::from_secs(2));
    serde_json::from_slice(&read_line(&mut stream, Instant::now() + Duration::from_secs(2)).unwrap()).unwrap()
}
#[test]
fn api_auth_unknown_parse_and_oversize_errors() {
    let (_tmp, endpoint, _server) = server();
    for auth in [None, Some("wrong")] {
        let mut request = json!({"jsonrpc":"2.0","id":4,"method":"echo"});
        if let Some(auth) = auth {
            request["auth"] = auth.into();
        }
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        let result = raw(&endpoint, &bytes);
        assert_eq!(result["error"]["code"], -32001);
        assert_eq!(result["id"], 4);
    }
    assert_eq!(
        call(endpoint.clone(), "missing".into(), json!({}), Duration::from_secs(2))
            .unwrap_err()
            .code,
        -32601
    );
    assert_eq!(raw(&endpoint, b"{bad\n")["error"]["code"], -32700);
    let mut big = vec![b' '; MAX_LINE + 1];
    big.push(b'\n');
    assert_eq!(raw(&endpoint, &big)["error"]["code"], -32600);
    assert_eq!(
        call(
            endpoint,
            "echo".into(),
            json!({"still":"alive"}),
            Duration::from_secs(2)
        )
        .unwrap()["still"],
        "alive"
    );
}
#[test]
fn api_permissions_pipe_identity_and_second_server_preserve_auth() {
    let (_tmp, endpoint, _server) = server();
    let token = endpoint.read_token().unwrap();
    assert_eq!(token.len(), 64);
    assert!(Server::start(endpoint.clone(), Arc::new(|_: &str, _: Value| Ok(Value::Null))).is_err());
    assert!(endpoint::tokens_match(&token, &endpoint.read_token().unwrap()));
    assert!(!endpoint::tokens_match(&token, "wrong"));
    assert!(!endpoint::tokens_match("", ""));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&endpoint.token_file, std::path::Path::new(&endpoint.address)] {
            assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
    let a = endpoint::pipe_name(std::path::Path::new(r"C:\Users\ME\Tessera"));
    assert_eq!(a, endpoint::pipe_name(std::path::Path::new(r"c:\users\me\tessera")));
    assert_ne!(a, endpoint::pipe_name(std::path::Path::new(r"C:\Users\ME\Tessera Dev")));
    assert_eq!(a.len(), 24);
}
#[test]
fn api_slow_client_does_not_block_another_and_calls_have_deadlines() {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint = Endpoint::new(tmp.path());
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = std::sync::Mutex::new(release_rx);
    let _server = Server::start(
        endpoint.clone(),
        Arc::new(move |method: &str, _: Value| {
            if method == "slow" {
                let _ = started_tx.send(());
                let _ = release.lock().unwrap().recv_timeout(Duration::from_secs(2));
            }
            Ok(json!(true))
        }),
    )
    .unwrap();
    let slow_endpoint = endpoint.clone();
    let slow = thread::spawn(move || call(slow_endpoint, "slow".into(), json!({}), Duration::from_secs(3)));
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        call(endpoint.clone(), "fast".into(), json!({}), Duration::from_secs(1)).unwrap(),
        true
    );
    release_tx.send(()).unwrap();
    assert!(slow.join().unwrap().is_ok());
    assert!(call(endpoint, "slow".into(), json!({}), Duration::from_millis(30)).is_err());
    let _ = release_tx.send(());
}
#[test]
fn api_batches_notifications_and_invalid_envelopes() {
    let (_tmp, endpoint, _server) = server();
    let token = endpoint.read_token().unwrap();
    let request = json!([{"jsonrpc":"2.0","auth":token,"id":"x","method":"echo","params":[1]}, {"jsonrpc":"2.0","auth":token,"method":"echo"},42]);
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    let result = raw(&endpoint, &bytes);
    assert_eq!(result.as_array().unwrap().len(), 2);
    assert_eq!(result[0]["id"], "x");
    assert_eq!(result[1]["error"]["code"], -32600);
    assert_eq!(raw(&endpoint, b"[]\n")["error"]["code"], -32600);
}
#[test]
fn api_schema_methods_dispatch_params_and_error_codes() {
    // Every §6 method name routes through the handler; the fake below stands in for the app.
    let tmp = tempfile::tempdir().unwrap();
    let endpoint = Endpoint::new(tmp.path());
    let _server = Server::start(
        endpoint.clone(),
        Arc::new(|method: &str, params: Value| match method {
            "app.info" => Ok(json!({"version":"0","api_version":1})),
            "project.list" => Ok(json!([{"id":"p"}])),
            "project.add" => Ok(json!({"id":"p","path":params["path"]})),
            "task.list" => Ok(json!([{"id":"t"}])),
            "task.create" => Ok(json!({"tasks":[{"id":"t"}],"agents":[]})),
            "task.archive" | "task.delete" => Ok(Value::Null),
            "agent.status" => Ok(json!({"status":"idle","since":1})),
            "agent.wait" => Ok(json!({"status":"idle","timed_out":false})),
            "agent.send" => Ok(Value::Null),
            "pane.read" => Ok(json!({"text":"hi"})),
            "review.diff" => Ok(json!({"patch":"diff --git a/x b/x\n"})),
            "hook.event" => Ok(Value::Null),
            "app.notify" => Ok(Value::Null),
            "missing.task" => Err(RpcError::not_found()),
            "bad.state" => Err(RpcError::invalid_state()),
            "bad.params" => Err(RpcError::new(-32602, "Invalid params")),
            _ => Err(RpcError::method_not_found()),
        }),
    )
    .unwrap();
    let rpc =
        |method: &str, params: Value| call(endpoint.clone(), method.into(), params, Duration::from_secs(2)).unwrap();
    for method in [
        "app.info",
        "project.list",
        "project.add",
        "task.list",
        "task.create",
        "task.archive",
        "task.delete",
        "agent.status",
        "agent.wait",
        "agent.send",
        "pane.read",
        "review.diff",
        "hook.event",
        "app.notify",
    ] {
        let _ = rpc(method, json!({}));
    }
    assert_eq!(rpc("project.add", json!({"path":"/x"}))["path"], "/x");
    assert_eq!(rpc("pane.read", json!({}))["text"], "hi");
    for (method, code) in [
        ("missing.task", -32002),
        ("bad.state", -32003),
        ("bad.params", -32602),
        ("unknown.method", -32601),
    ] {
        assert_eq!(
            call(endpoint.clone(), method.into(), json!({}), Duration::from_secs(2))
                .unwrap_err()
                .code,
            code
        );
    }
}
