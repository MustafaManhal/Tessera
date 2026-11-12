//! Bounded MCP discovery. Always reaps the stdio process, including malformed replies and timeout.
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
// The bool marks the dedicated process group owned by a stdio probe.
struct ChildGuard(Child, bool);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let running = self.0.try_wait().ok().flatten().is_none();
        if self.1 {
            #[cfg(target_os = "macos")]
            {
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", &format!("-{}", self.0.id())])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        #[cfg(windows)]
        if running {
            let _ = Command::new("taskkill")
                .args(["/PID", &self.0.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        if running {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn initialize() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"tessera-manager","version":env!("CARGO_PKG_VERSION")}}})
}
fn validate(value: Value) -> Result<Value, String> {
    if value.get("error").is_some() {
        return Err("The MCP server returned a protocol error.".into());
    }
    value.get("result").cloned().ok_or("Missing MCP result.".into())
}
fn names(value: Value) -> Result<Vec<String>, String> {
    let tools = value["tools"]
        .as_array()
        .ok_or("The server did not return a tools list.")?;
    tools
        .iter()
        .map(|v| {
            v["name"]
                .as_str()
                .filter(|s| s.len() < 512)
                .map(String::from)
                .ok_or("Invalid tool name.".into())
        })
        .collect()
}
pub fn stdio(
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Result<Vec<String>, String> {
    let mut process = Command::new(command);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    let mut child = ChildGuard(
        process
            .args(args)
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not start the MCP command.")?,
        true,
    );
    let mut input = child.0.stdin.take().ok_or("No stdin pipe.")?;
    let output = child.0.stdout.take().ok_or("No stdout pipe.")?;
    let (tx, rx) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        let mut r = BufReader::new(output);
        loop {
            let mut bytes = Vec::new();
            match (&mut r).take(1024 * 1024 + 1).read_until(b'\n', &mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(n) if n > 1024 * 1024 => {
                    let _ = tx.send(Err("MCP response exceeds 1 MiB.".into()));
                    break;
                }
                _ => {
                    let v = serde_json::from_slice(&bytes).map_err(|_| "Invalid MCP JSON.".to_string());
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let start = Instant::now();
    let receive = |id: i64| -> Result<Value, String> {
        loop {
            let v: Value = rx
                .recv_timeout(timeout.saturating_sub(start.elapsed()))
                .map_err(|_| "The MCP test timed out or the server closed stdout.".to_string())??;
            if v["id"] == id {
                return validate(v);
            }
        }
    };
    let send = |input: &mut std::process::ChildStdin, v: Value| -> Result<(), String> {
        writeln!(input, "{v}")
            .and_then(|_| input.flush())
            .map_err(|_| "Could not send the MCP request.".into())
    };
    send(&mut input, initialize())?;
    let init = receive(1)?;
    if !init["protocolVersion"].is_string() {
        return Err("Invalid initialize result.".into());
    }
    send(
        &mut input,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )?;
    let mut result = Vec::new();
    let mut cursor = Value::Null;
    for page in 0..10 {
        let id = page + 2;
        let params = if cursor.is_null() {
            json!({})
        } else {
            json!({"cursor":cursor})
        };
        send(
            &mut input,
            json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":params}),
        )?;
        let value = receive(id)?;
        result.extend(names(value.clone())?);
        if value.get("nextCursor").is_none() {
            return Ok(result);
        }
        cursor = value["nextCursor"].clone();
    }
    Err("Too many MCP tool pages.".into())
}
fn curl(
    url: &str,
    payload: Value,
    session: Option<&str>,
    remaining: Duration,
) -> Result<(Value, Option<String>), String> {
    let seconds = remaining.as_secs_f64().max(0.001).to_string();
    let mut command = Command::new("curl");
    command.args([
        "--silent",
        "--show-error",
        "--include",
        "--suppress-connect-headers",
        "--max-time",
        &seconds,
        "--max-filesize",
        "1048576",
        "--request",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--header",
        "Accept: application/json, text/event-stream",
        "--header",
        "MCP-Protocol-Version: 2025-06-18",
        "--data-binary",
        "@-",
        "--url",
        url,
    ]);
    if let Some(session) = session {
        if session.contains(['\r', '\n']) {
            return Err("Invalid MCP session header.".into());
        }
        command.args(["--header", &format!("Mcp-Session-Id: {session}")]);
    }
    let mut child = ChildGuard(
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "curl is required to test HTTP MCP servers.")?,
        false,
    );
    let mut input = child.0.stdin.take().ok_or("No HTTP input pipe.")?;
    write!(input, "{payload}").map_err(|_| "Could not send HTTP request.")?;
    drop(input);
    let mut output = child.0.stdout.take().ok_or("No HTTP output pipe.")?;
    let (tx, rx) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut output).take(1024 * 1024 + 1).read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let bytes = rx.recv_timeout(remaining).map_err(|_| "The HTTP MCP test timed out.")?;
    if bytes.len() > 1024 * 1024 {
        return Err("HTTP response exceeds 1 MiB.".into());
    }
    let status = child.0.wait().map_err(|_| "Could not finish HTTP request.")?;
    if !status.success() {
        return Err("HTTP request failed or timed out.".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "HTTP response is not UTF-8.")?;
    let (header, body) = text.split_once("\r\n\r\n").ok_or("Invalid HTTP response.")?;
    let code = header
        .lines()
        .next()
        .and_then(|v| v.split_whitespace().nth(1))
        .unwrap_or("");
    if !matches!(code, "200" | "202" | "204") {
        return Err(format!("HTTP MCP server returned status {code}."));
    }
    let session = header.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("mcp-session-id").then(|| v.trim().to_string())
    });
    if body.trim().is_empty() {
        return Ok((Value::Null, session));
    }
    let v = serde_json::from_str(body)
        .or_else(|_| {
            let text = body
                .lines()
                .filter_map(|l| l.strip_prefix("data: "))
                .next_back()
                .unwrap_or("");
            serde_json::from_str(text)
        })
        .map_err(|_| "Invalid JSON/SSE MCP HTTP response.")?;
    Ok((v, session))
}
pub fn http(url: &str, timeout: Duration) -> Result<Vec<String>, String> {
    let start = Instant::now();
    let (init, session) = curl(url, initialize(), None, timeout)?;
    validate(init)?;
    curl(
        url,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        session.as_deref(),
        timeout.saturating_sub(start.elapsed()),
    )?;
    let (value, _) = curl(
        url,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        session.as_deref(),
        timeout.saturating_sub(start.elapsed()),
    )?;
    names(validate(value)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_server_and_deadline() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("fixture.rs");
        std::fs::write(&source, include_str!("../tests/fixtures/mcp_server.rs")).unwrap();
        let binary = tmp.path().join(if cfg!(windows) { "fixture.exe" } else { "fixture" });
        assert!(
            Command::new("rustc")
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .status()
                .unwrap()
                .success()
        );
        let tools = stdio(binary.to_str().unwrap(), &[], &BTreeMap::new(), Duration::from_secs(10)).unwrap();
        assert_eq!(tools, ["fixture_tool"]);
        let start = Instant::now();
        assert!(
            stdio(
                binary.to_str().unwrap(),
                &["--sleep".into()],
                &BTreeMap::new(),
                Duration::from_millis(50)
            )
            .is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn http_handshake_and_sse_tools() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            for index in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let head = String::from_utf8(request).unwrap();
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|s| s.trim().parse::<usize>().ok())
                    })
                    .unwrap();
                let mut body = vec![0; length];
                socket.read_exact(&mut body).unwrap();
                let payload: Value = serde_json::from_slice(&body).unwrap();
                if index > 0 {
                    assert!(head.to_lowercase().contains("mcp-session-id: fixture-session"));
                }
                let response = match index {
                    0 => json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}).to_string(),
                    1 => String::new(),
                    _ => format!(
                        "data: {}\n\n",
                        json!({"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"http_fixture"}]}})
                    ),
                };
                if index == 0 {
                    assert_eq!(payload["method"], "initialize");
                }
                write!(socket,"HTTP/1.1 {}\r\nContent-Length: {}\r\nMcp-Session-Id: fixture-session\r\nConnection: close\r\n\r\n{}",if index==1 {"202 Accepted"}else{"200 OK"},response.len(),response).unwrap();
            }
        });
        assert_eq!(http(&url, Duration::from_secs(3)).unwrap(), ["http_fixture"]);
        worker.join().unwrap();
    }
}
