//! Pipe-level MCP tests against a real authenticated local API listener with a recording fake core.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};
use tessera_api::{Endpoint, RpcError, Server};
struct Fixture {
    _tmp: tempfile::TempDir,
    _server: Server,
    endpoint: Endpoint,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
}
fn fixture(enabled: bool) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let endpoint = Endpoint::new(tmp.path());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = calls.clone();
    let server = Server::start(
        endpoint.clone(),
        Arc::new(move |method: &str, params: Value| {
            recorded.lock().unwrap().push((method.into(), params.clone()));
            if params["task"] == "missing" {
                return Err(RpcError::not_found());
            }
            Ok(match method {
                "app.info" => json!({"mcp_server":enabled}),
                "project.list" => json!([{"id":"p1"}]),
                "task.list" => json!([{"id":"t1"}]),
                "task.create" => json!({"tasks":[{"id":"new"}]}),
                "agent.status" => json!({"status":"working","since":12}),
                "agent.wait" => json!({"status":"working","timed_out":true}),
                "agent.send" => Value::Null,
                "review.diff" => json!({"patch":"diff --git a/f b/f\n+new\n"}),
                "pane.read" => json!({"text":"one\ntwo"}),
                _ => return Err(RpcError::method_not_found()),
            })
        }),
    )
    .unwrap();
    Fixture {
        _tmp: tmp,
        _server: server,
        endpoint,
        calls,
    }
}
struct Session {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Value>,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Session {
    fn start(f: &Fixture, force: bool) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tessera"));
        command.arg("mcp");
        if force {
            command.arg("--force");
        }
        let mut child = command
            .env_remove("TESSERA_ASKPASS_ALIAS")
            .env("TESSERA_SOCKET", &f.endpoint.address)
            .env("TESSERA_API_TOKEN_FILE", &f.endpoint.token_file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let value = serde_json::from_str(&line.unwrap()).expect("stdout must contain only MCP JSON");
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output: rx,
        }
    }
    fn raw(&mut self, line: &str) {
        writeln!(self.input.as_mut().unwrap(), "{line}").unwrap();
    }
    fn receive(&self) -> Value {
        self.output
            .recv_timeout(Duration::from_secs(10))
            .expect("MCP response within 10 seconds")
    }
    fn request(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.raw(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string());
        let response = self.receive();
        assert_eq!(response["id"], id);
        response
    }
    fn initialize(&mut self) {
        let response = self.request(
            1,
            "initialize",
            json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}),
        );
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert!(response["result"]["capabilities"]["tools"].is_object());
        self.raw(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    }
    fn tool(&mut self, name: &str, arguments: Value) -> Value {
        let response = self.request(2, "tools/call", json!({"name":name,"arguments":arguments}));
        assert!(response["result"]["content"][0]["text"].is_string(), "{response}");
        response["result"].clone()
    }
}
fn content(result: &Value) -> Value {
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}
#[test]
fn initialize_list_schemas_and_every_tool_roundtrip() {
    let f = fixture(true);
    let mut s = Session::start(&f, false);
    s.initialize();
    assert_eq!(s.request(3, "ping", json!({}))["result"], json!({}));
    let list = s.request(4, "tools/list", json!({}));
    let tools = list["result"]["tools"].as_array().unwrap();
    assert_eq!(
        tools.iter().map(|t| t["name"].as_str().unwrap()).collect::<Vec<_>>(),
        [
            "list_projects",
            "list_tasks",
            "create_task",
            "get_status",
            "wait_status",
            "send_message",
            "get_diff",
            "read_pane"
        ]
    );
    for tool in tools {
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert!(tool["inputSchema"]["properties"].is_object());
        assert!(tool["inputSchema"]["required"].is_array());
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    }
    for name in ["create_task", "send_message"] {
        assert!(
            tools.iter().find(|t| t["name"] == name).unwrap()["description"]
                .as_str()
                .unwrap()
                .contains("Side effect")
        );
    }
    assert_eq!(content(&s.tool("list_projects", json!({})))[0]["id"], "p1");
    assert_eq!(
        content(&s.tool("list_tasks", json!({"project":"p1","status":"active"})))[0]["id"],
        "t1"
    );
    assert_eq!(
        content(&s.tool(
            "create_task",
            json!({"prompt":"fix it","agents":["claude"],"base":"main","name":"Fix"})
        ))["tasks"][0]["id"],
        "new"
    );
    assert_eq!(
        content(&s.tool("get_status", json!({"task":"t1"})))["status"],
        "working"
    );
    assert_eq!(
        content(&s.tool("wait_status", json!({"task":"t1","timeout":0})))["timed_out"],
        true
    );
    assert!(content(&s.tool("send_message", json!({"task":"t1","text":"hello\nworld"}))).is_null());
    assert!(
        content(&s.tool("get_diff", json!({"task":"t1"})))["patch"]
            .as_str()
            .unwrap()
            .ends_with("+new\n")
    );
    assert_eq!(
        content(&s.tool("read_pane", json!({"session":"s1","lines":12})))["text"],
        "one\ntwo"
    );
    let calls = f.calls.lock().unwrap();
    assert!(calls.contains(&(
        "task.create".into(),
        json!({"project":"","prompt":"fix it","agents":["claude"],"base":"main","name":"Fix"})
    )));
    assert!(calls.contains(&(
        "agent.wait".into(),
        json!({"task":"t1","statuses":["starting","needs_input","idle","error","exited"],"timeout_ms":0})
    )));
    assert!(calls.contains(&("agent.send".into(), json!({"task":"t1","text":"hello\nworld"}))));
    assert!(calls.contains(&("pane.read".into(), json!({"session":"s1","lines":12}))));
}
#[test]
fn api_errors_invalid_arguments_unknown_tool_and_malformed_frames() {
    let f = fixture(true);
    let mut s = Session::start(&f, true);
    assert_eq!(s.request(1, "tools/list", json!({}))["error"]["code"], -32000);
    s.initialize();
    let result = s.tool("get_status", json!({"task":"missing"}));
    assert_eq!(result["isError"], true);
    assert_eq!(content(&result), json!({"code":-32002,"message":"NotFound"}));
    for (name, args) in [
        ("wait_status", json!({"task":"t1","timeout":301})),
        ("wait_status", json!({"task":"t1","timeout":-1})),
        ("wait_status", json!({"task":"t1","timeout":1.5})),
        ("send_message", json!({"task":"t1","text":""})),
        ("read_pane", json!({"task":"t1","session":"s1"})),
        ("get_diff", json!({"task":"t1","unexpected":true})),
    ] {
        let result = s.tool(name, args);
        assert_eq!(result["isError"], true);
        assert_eq!(content(&result)["code"], -32602);
    }
    assert_eq!(
        s.request(2, "tools/call", json!({"name":"delete_everything"}))["error"]["code"],
        -32602
    );
    s.raw("{broken");
    assert_eq!(s.receive()["error"]["code"], -32700);
    s.raw("[]");
    assert_eq!(s.receive()["error"]["code"], -32600);
    s.raw(&"x".repeat(tessera_api::MAX_LINE + 1));
    assert_eq!(s.receive()["error"]["code"], -32600);
    s.raw(r#"{"jsonrpc":"2.0","method":"tools/call","params":{"name":"send_message","arguments":{"task":"t1","text":"never"}}}"#);
    assert_eq!(s.request(3, "ping", json!({}))["result"], json!({}));
    assert!(!f.calls.lock().unwrap().iter().any(|(m, _)| m == "agent.send"));
}
#[test]
fn disabled_switch_exits_2_without_stdout_and_force_is_explicit() {
    let f = fixture(false);
    let out = Command::new(env!("CARGO_BIN_EXE_tessera"))
        .arg("mcp")
        .env_remove("TESSERA_ASKPASS_ALIAS")
        .env("TESSERA_SOCKET", &f.endpoint.address)
        .env("TESSERA_API_TOKEN_FILE", &f.endpoint.token_file)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("api.mcp-server"));
    let mut session = Session::start(&f, true);
    session.initialize();
    assert_eq!(content(&session.tool("list_projects", json!({})))[0]["id"], "p1");
    session.input.take();
    assert!(session.child.wait().unwrap().success());
}
