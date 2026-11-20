//! MCP 2025-06-18 over newline-delimited stdio, backed by the authenticated local API.
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Read, Write},
    time::Duration,
};
use tessera_api::{Endpoint, MAX_LINE, RpcError};
const VERSION: &str = "2025-06-18";
const STATUSES: [&str; 6] = ["starting", "working", "needs_input", "idle", "error", "exited"];
fn tools() -> Value {
    let string = json!({"type":"string","minLength":1});
    let task = json!({"task":string});
    let definitions = [
        ("list_projects", "List registered projects.", json!({}), vec![]),
        (
            "list_tasks",
            "List tasks, optionally filtered by project and task state.",
            json!({"project":string,"status":{"type":"string","enum":["backlog","setting_up","active","archived","error"]}}),
            vec![],
        ),
        (
            "create_task",
            "Side effect: create a task/worktree and optionally launch agents with a prompt.",
            json!({"project":string,"prompt":{"type":"string"},"agents":{"type":"array","items":string},"base":string,"name":string}),
            vec![],
        ),
        (
            "get_status",
            "Read the newest agent session status for a task.",
            task.clone(),
            vec!["task"],
        ),
        (
            "wait_status",
            "Wait until the task's agent status changes, or the timeout expires (at most 300 seconds).",
            json!({"task":string,"timeout":{"type":"integer","minimum":0,"maximum":300,"default":300}}),
            vec!["task"],
        ),
        (
            "send_message",
            "Side effect: send text to the task's agent pane and submit it with Enter.",
            json!({"task":string,"text":string}),
            vec!["task", "text"],
        ),
        (
            "get_diff",
            "Read the unified task diff against its base branch.",
            task,
            vec!["task"],
        ),
        (
            "read_pane",
            "Read scrollback from a task's agent pane or a PTY/agent session.",
            json!({"task":string,"session":string,"lines":{"type":"integer","minimum":1,"maximum":5000,"default":200}}),
            vec![],
        ),
    ];
    Value::Array(definitions.into_iter().map(|(name, description, properties, required)| {
        let mut schema = json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
        if name == "read_pane" { schema["oneOf"] = json!([{"required":["task"]},{"required":["session"]}]); }
        json!({"name":name,"description":description,"inputSchema":schema,"annotations":{"readOnlyHint":!matches!(name,"create_task"|"send_message"),"openWorldHint":false}})
    }).collect())
}
fn invalid() -> RpcError {
    RpcError::new(-32602, "Invalid tool arguments")
}
/// Validate the deliberately small JSON Schema vocabulary used by these tools before forwarding input.
fn validate(value: &Value, schema: &Value) -> bool {
    match schema["type"].as_str() {
        Some("object") => {
            let Some(object) = value.as_object() else { return false };
            if object
                .iter()
                .any(|(key, v)| schema["properties"].get(key).is_none_or(|s| !validate(v, s)))
            {
                return false;
            }
            if schema["required"]
                .as_array()
                .is_some_and(|keys| keys.iter().any(|k| !object.contains_key(k.as_str().unwrap_or(""))))
            {
                return false;
            }
            if schema["oneOf"].as_array().is_some_and(|choices| {
                choices
                    .iter()
                    .filter(|choice| {
                        choice["required"]
                            .as_array()
                            .is_some_and(|keys| keys.iter().all(|k| object.contains_key(k.as_str().unwrap_or(""))))
                    })
                    .count()
                    != 1
            }) {
                return false;
            }
            true
        }
        Some("string") => value.as_str().is_some_and(|v| {
            (schema["minLength"] != 1 || !v.is_empty())
                && schema["enum"].as_array().is_none_or(|options| options.contains(value))
        }),
        Some("integer") => value.as_u64().is_some_and(|n| {
            n >= schema["minimum"].as_u64().unwrap_or(0) && n <= schema["maximum"].as_u64().unwrap_or(u64::MAX)
        }),
        Some("array") => value
            .as_array()
            .is_some_and(|items| items.iter().all(|v| validate(v, &schema["items"]))),
        _ => false,
    }
}
fn api(endpoint: &Endpoint, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
    tessera_api::call(endpoint.clone(), method.into(), params, timeout)
}
fn tool(endpoint: &Endpoint, name: &str, mut args: Value) -> Result<Value, RpcError> {
    let definitions = tools();
    let definition = definitions
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .ok_or_else(|| RpcError::new(-32602, "Unknown tool"))?;
    if !validate(&args, &definition["inputSchema"]) {
        return Err(invalid());
    }
    let method = match name {
        "list_projects" => "project.list",
        "list_tasks" => "task.list",
        "create_task" => {
            args.as_object_mut().unwrap().entry("project").or_insert(json!(""));
            "task.create"
        }
        "get_status" => "agent.status",
        "send_message" => "agent.send",
        "get_diff" => "review.diff",
        "read_pane" => "pane.read",
        "wait_status" => {
            let current = api(
                endpoint,
                "agent.status",
                json!({"task":args["task"]}),
                Duration::from_secs(30),
            )?;
            let seconds = args["timeout"].as_u64().unwrap_or(300);
            return api(
                endpoint,
                "agent.wait",
                json!({"task":args["task"],"statuses":STATUSES.into_iter().filter(|s| current["status"] != *s).collect::<Vec<_>>(),"timeout_ms":seconds*1000}),
                Duration::from_secs(seconds + 15),
            );
        }
        _ => unreachable!(),
    };
    api(
        endpoint,
        method,
        args,
        Duration::from_secs(if method == "review.diff" { 120 } else { 30 }),
    )
}
fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn respond(request: Value, endpoint: &Endpoint, initialized: &mut bool) -> Option<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let valid_id = id.is_string() || id.is_i64() || id.is_u64();
    if !request.is_object()
        || request["jsonrpc"] != "2.0"
        || !request["method"].is_string()
        || (request.get("id").is_some() && !valid_id)
    {
        return Some(error(
            if valid_id { id } else { Value::Null },
            -32600,
            "Invalid request",
        ));
    }
    // Never execute a side effect from a notification. MCP initialized/cancelled notifications need no reply.
    request.get("id")?;
    let params = request.get("params").cloned().unwrap_or(json!({}));
    if !params.is_object() {
        return Some(error(id, -32602, "Params must be an object"));
    }
    let result = match request["method"].as_str().unwrap() {
        "initialize" => {
            if *initialized
                || !params["protocolVersion"].is_string()
                || !params["capabilities"].is_object()
                || !params["clientInfo"]["name"].is_string()
                || !params["clientInfo"]["version"].is_string()
            {
                return Some(error(id, -32602, "Invalid initialize request"));
            }
            *initialized = true;
            json!({"protocolVersion":VERSION,"capabilities":{"tools":{}},"serverInfo":{"name":"tessera","version":env!("CARGO_PKG_VERSION")}})
        }
        "ping" => json!({}),
        _ if !*initialized => return Some(error(id, -32000, "Initialize the MCP session first")),
        "tools/list" => {
            if params.get("cursor").is_some() {
                return Some(error(id, -32602, "There is no next tools page"));
            }
            json!({"tools":tools()})
        }
        "tools/call" => {
            let Some(name) = params["name"].as_str() else {
                return Some(error(id, -32602, "Tool name is required"));
            };
            // Unknown tools are protocol errors; execution/argument/API failures are tool results.
            if !tools().as_array().unwrap().iter().any(|t| t["name"] == name) {
                return Some(error(id, -32602, "Unknown tool"));
            }
            match tool(endpoint, name, params.get("arguments").cloned().unwrap_or(json!({}))) {
                Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}],"isError":false}),
                Err(e) => {
                    json!({"content":[{"type":"text","text":json!({"code":e.code,"message":e.message}).to_string()}],"isError":true})
                }
            }
        }
        _ => return Some(error(id, -32601, "Method not found")),
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}
pub fn run(dev: bool, force: bool) -> Result<(), String> {
    let endpoint = Endpoint::from_environment(dev).map_err(|e| e.to_string())?;
    if !force {
        let info = api(&endpoint, "app.info", json!({}), Duration::from_secs(2)).map_err(|e| {
            format!(
                "MCP is disabled or the app is unavailable: {}. Enable api.mcp-server in Settings.",
                e.message
            )
        })?;
        if info["mcp_server"] != true {
            return Err("MCP is disabled. Enable api.mcp-server in Settings, or use --force for tests.".into());
        }
    }
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut initialized = false;
    loop {
        let mut line = Vec::new();
        let size = (&mut input)
            .take((MAX_LINE + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        let response = if size > MAX_LINE {
            // Drain only this oversized frame, keeping subsequent messages usable without unbounded allocation.
            while !line.ends_with(b"\n") {
                line.clear();
                if (&mut input)
                    .take((MAX_LINE + 1) as u64)
                    .read_until(b'\n', &mut line)
                    .map_err(|e| e.to_string())?
                    == 0
                {
                    break;
                }
            }
            Some(error(Value::Null, -32600, "MCP message exceeds 1 MiB"))
        } else {
            match serde_json::from_slice(&line) {
                Ok(request) => respond(request, &endpoint, &mut initialized),
                Err(_) => Some(error(Value::Null, -32700, "Parse error")),
            }
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut output, &response).map_err(|e| e.to_string())?;
            output
                .write_all(b"\n")
                .and_then(|()| output.flush())
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
