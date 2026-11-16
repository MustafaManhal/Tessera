//! Run `node scripts/bridge.mjs [port]` for a local real-shell WebSocket URL.
//! Direct use: set TESSERA_BRIDGE_TOKEN to a random secret and run
//! `cargo run -p tessera-pty --example pty_bridge -- [port]`. Port 0 selects a free port.
//! Send spawn JSON first, then raw input or JSON resize/ack/kill controls. Output is
//! binary (0 + data, or 1 + exit code as little-endian u32). Closing stdin stops the bridge.

use serde_json::Value;
use std::io;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
use tessera_pty::{PtyEvent, PtyHost, SpawnSpec};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::protocol::{CloseFrame, Message, WebSocketConfig, frame::coding::CloseCode};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid PTY bridge message")
}

fn dimension(value: &Value, field: &str) -> Result<u16> {
    value[field]
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| invalid().into())
}

fn optional_string<'a>(value: &'a Value, field: &str) -> Result<Option<&'a str>> {
    match value.get(field) {
        None => Ok(None),
        Some(value) => value.as_str().map(Some).ok_or_else(|| invalid().into()),
    }
}

fn spec(message: Message, data: &std::path::Path) -> Result<SpawnSpec> {
    let Message::Text(text) = message else {
        return Err(invalid().into());
    };
    let value: Value = serde_json::from_str(text.as_str())?;
    let mut spec = SpawnSpec::new(match optional_string(&value, "cwd")? {
        Some("~") => std::env::home_dir().ok_or_else(|| io::Error::other("home directory unavailable"))?,
        Some(cwd) => cwd.into(),
        None => std::env::current_dir()?,
    });
    spec.cols = dimension(&value, "cols")?;
    spec.rows = dimension(&value, "rows")?;
    spec.program = optional_string(&value, "shell")?.map(str::to_owned);
    if value["integration"].as_bool().ok_or_else(invalid)? {
        let env = std::env::vars().collect();
        let program = spec
            .program
            .clone()
            .unwrap_or_else(|| tessera_pty::default_shell(&env, tessera_pty::Platform::current()));
        let args = if spec.program.is_none() && !cfg!(windows) {
            vec!["-l".into()]
        } else {
            Vec::new()
        };
        match tessera_shell::prepare_installed_launch(&program, &args, &env, data, true) {
            Ok(plan) if plan.injected => {
                spec.program = Some(program);
                spec.args = plan.args;
                spec.env = plan.env;
            }
            Err(error) => tracing::warn!(%error, "shell integration scripts unavailable; starting without them"),
            Ok(_) => {}
        }
    }
    Ok(spec)
}

// Tungstenite defines the handshake callback error as a full HTTP response.
#[allow(clippy::result_large_err)]
fn serve(stream: TcpStream, token: &str, host: &PtyHost) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    let mut socket = tungstenite::accept_hdr_with_config(
        stream,
        |request: &Request, response: Response| {
            if request.uri().query().and_then(|query| query.strip_prefix("token=")) == Some(token) {
                Ok(response)
            } else {
                let mut denied = tungstenite::http::Response::new(None);
                *denied.status_mut() = StatusCode::FORBIDDEN;
                Err(denied)
            }
        },
        Some(config),
    )
    .map_err(|error| io::Error::other(error.to_string()))?;
    let data = tempfile::tempdir()?;
    let spec = match spec(socket.read()?, data.path()) {
        Ok(spec) => spec,
        Err(_) => {
            socket.close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: "Invalid spawn message".into(),
            }))?;
            return Ok(());
        }
    };
    socket.get_ref().set_read_timeout(Some(Duration::from_millis(8)))?;
    let (tx, rx) = mpsc::channel();
    let id = host.spawn_with_sink(
        spec,
        Some(Arc::new(move |event| {
            let _ = tx.send(event);
        })),
    )?;
    let result = (|| -> Result<()> {
        loop {
            for event in rx.try_iter().take(32) {
                let (frame, exited) = match event {
                    PtyEvent::Data(bytes) => {
                        let mut frame = Vec::with_capacity(bytes.len() + 1);
                        frame.push(0);
                        frame.extend(bytes);
                        (frame, false)
                    }
                    PtyEvent::Exit { code } => {
                        let mut frame = vec![1];
                        frame.extend(code.to_le_bytes());
                        (frame, true)
                    }
                };
                socket.send(Message::binary(frame))?;
                if exited {
                    socket.close(None)?;
                    return Ok(());
                }
            }
            match socket.read() {
                Ok(Message::Binary(bytes)) => host.write(&id, &bytes)?,
                Ok(Message::Text(text)) => {
                    let value: Value = serde_json::from_str(text.as_str())?;
                    match value["type"].as_str() {
                        Some("resize") => {
                            host.resize(&id, dimension(&value, "cols")?, dimension(&value, "rows")?, 0, 0)?
                        }
                        Some("ack") => {
                            let bytes = value["bytes"]
                                .as_u64()
                                .and_then(|n| usize::try_from(n).ok())
                                .ok_or_else(invalid)?;
                            host.ack(&id, bytes)?;
                        }
                        Some("kill") => return Ok(()),
                        _ => return Err(invalid().into()),
                    }
                }
                Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => return Ok(()),
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
                Err(error) => return Err(error.into()),
            }
        }
    })();
    let _ = host.kill(&id);
    result
}

fn main() -> Result<()> {
    let port = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("TESSERA_BRIDGE_PORT").ok())
        .unwrap_or_else(|| "0".into())
        .parse()?;
    let token = std::env::var("TESSERA_BRIDGE_TOKEN")?;
    if token.len() < 32 || !token.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "provide a random alphanumeric bridge token of at least 32 characters",
        )
        .into());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
    let active = Arc::new(Mutex::new(std::collections::HashMap::<_, PtyHost>::new()));
    let shutdown = Arc::clone(&active);
    std::thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        let hosts = shutdown.lock().expect("active bridge connections");
        for host in hosts.values() {
            for id in host.list() {
                let _ = host.kill(&id);
            }
        }
        std::process::exit(0);
    });
    println!("listening {}", listener.local_addr()?.port());
    for stream in listener.incoming() {
        let stream = stream?;
        let token = token.clone();
        let active = Arc::clone(&active);
        std::thread::spawn(move || {
            let key = std::thread::current().id();
            let host = PtyHost::new();
            active
                .lock()
                .expect("active bridge connections")
                .insert(key, host.clone());
            if let Err(error) = serve(stream, &token, &host) {
                tracing::debug!(%error, "bridge connection ended");
            }
            active.lock().expect("active bridge connections").remove(&key);
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::{WebSocket, connect};

    const TOKEN: &str = "test012345678901234567890123456789";

    fn fixture() -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let _ = serve(stream, TOKEN, &PtyHost::new());
        });
        format!("ws://{addr}/?token={TOKEN}")
    }

    fn client() -> WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>> {
        let (socket, _) = connect(fixture()).unwrap();
        let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_ref() else {
            panic!("expected loopback TCP");
        };
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        socket
    }

    #[test]
    fn rejects_wrong_token_and_invalid_spawn() {
        let url = fixture().replace(TOKEN, "wrong");
        assert!(
            matches!(connect(url), Err(tungstenite::Error::Http(response)) if response.status() == StatusCode::FORBIDDEN)
        );
        let mut socket = client();
        socket
            .send(Message::text(r#"{"cols":0,"rows":24,"integration":true}"#))
            .unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Close(Some(frame)) if frame.code == CloseCode::Policy));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn real_shell_markers_resize_and_exit() {
        use serde_json::json;
        let cwd = tempfile::tempdir().unwrap();
        for integration in [true, false] {
            let mut socket = client();
            socket
                .send(Message::text(
                    json!({
                        "cols": 80, "rows": 24, "cwd": cwd.path(), "shell": "/bin/bash", "integration": integration
                    })
                    .to_string(),
                ))
                .unwrap();
            socket
                .send(Message::text(r#"{"type":"resize","cols":96,"rows":37}"#))
                .unwrap();
            let mut output = Vec::new();
            let mut sent = false;
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                assert!(std::time::Instant::now() < deadline, "shell timed out");
                let Message::Binary(frame) = socket.read().unwrap() else {
                    panic!("expected binary PTY frame");
                };
                if frame[0] == 1 {
                    assert_eq!(&frame[..], &[1, 7, 0, 0, 0]);
                    break;
                }
                assert_eq!(frame[0], 0);
                output.extend_from_slice(&frame[1..]);
                socket
                    .send(Message::text(json!({"type":"ack","bytes":frame.len()-1}).to_string()))
                    .unwrap();
                if !sent && (!integration || output.windows(7).any(|p| p == b"\x1b]133;B")) {
                    socket
                        .send(Message::binary(b"echo tessera-ok; stty size\r".to_vec()))
                        .unwrap();
                    socket.send(Message::binary(b"exit 7\r".to_vec())).unwrap();
                    sent = true;
                }
            }
            let text = String::from_utf8_lossy(&output);
            assert!(
                text.contains("\r\ntessera-ok\r\n") || text.contains("\x07tessera-ok\r\n"),
                "{text:?}"
            );
            assert!(text.contains("\n37 96\r\n"), "{text:?}");
            for mark in ["\x1b]133;A", "\x1b]133;B", "\x1b]133;C", "\x1b]133;D", "\x1b]7;"] {
                assert_eq!(text.contains(mark), integration, "{mark:?} in {text:?}");
            }
        }
    }
}
