//! Authenticated newline-delimited JSON-RPC on local sockets. One request (or batch) per connection.
pub mod endpoint;
pub use endpoint::Endpoint;
use interprocess::{
    ConnectWaitMode,
    local_socket::{ConnectOptions, ListenerNonblockingMode, ListenerOptions, Stream, prelude::*},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
pub const MAX_LINE: usize = 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}
impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn not_found() -> Self {
        Self::new(-32002, "NotFound")
    }
    pub fn invalid_state() -> Self {
        Self::new(-32003, "InvalidState")
    }
    pub fn method_not_found() -> Self {
        Self::new(-32601, "Method not found")
    }
}
pub trait Handler: Send + Sync + 'static {
    fn handle(&self, method: &str, params: Value) -> Result<Value, RpcError>;
}
impl<F> Handler for F
where
    F: Fn(&str, Value) -> Result<Value, RpcError> + Send + Sync + 'static,
{
    fn handle(&self, m: &str, p: Value) -> Result<Value, RpcError> {
        self(m, p)
    }
}
pub struct Server {
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    /// Bind before replacing the token, so a second app cannot invalidate a live server.
    pub fn start(endpoint: Endpoint, handler: Arc<dyn Handler>) -> io::Result<Self> {
        let root = endpoint
            .token_file
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "The token file needs a parent folder."))?;
        std::fs::create_dir_all(root)?;
        let create = || {
            let options = ListenerOptions::new().name(endpoint.name()?);
            options.create_sync()
        };
        let listener = match create() {
            Ok(l) => l,
            Err(error) if !cfg!(windows) && error.kind() == io::ErrorKind::AddrInUse => {
                if ConnectOptions::new()
                    .name(endpoint.name()?)
                    .wait_mode(ConnectWaitMode::Timeout(Duration::from_millis(100)))
                    .connect_sync()
                    .is_ok()
                {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "The local API is already running.",
                    ));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::FileTypeExt;
                    if !std::fs::symlink_metadata(&endpoint.address)?.file_type().is_socket() {
                        return Err(error);
                    }
                }
                std::fs::remove_file(&endpoint.address)?;
                create()?
            }
            Err(e) => return Err(e),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&endpoint.address, std::fs::Permissions::from_mode(0o600))?;
        }
        // Only accept() polls (so the stop flag is seen); connections are blocking streams with timeouts. Non-blocking
        // named pipes on Windows report "no data yet" like end of file, which broke every request there.
        listener.set_nonblocking(ListenerNonblockingMode::Accept)?;
        let token = endpoint.create_token()?;
        let stop = Arc::new(AtomicBool::new(false));
        let quit = stop.clone();
        let active = Arc::new(AtomicUsize::new(0));
        let worker = thread::Builder::new().name("tessera-api".into()).spawn(move || {
            while !quit.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok(stream) => {
                        if active.load(Ordering::Relaxed) >= 64 {
                            continue;
                        }
                        active.fetch_add(1, Ordering::Relaxed);
                        let active = active.clone();
                        let handler = handler.clone();
                        let token = token.clone();
                        let failure_active = active.clone();
                        if thread::Builder::new()
                            .name("tessera-api-client".into())
                            .spawn(move || {
                                struct Active(Arc<AtomicUsize>);
                                impl Drop for Active {
                                    fn drop(&mut self) {
                                        self.0.fetch_sub(1, Ordering::Relaxed);
                                    }
                                }
                                let _active = Active(active);
                                serve(stream, &token, handler.as_ref());
                            })
                            .is_err()
                        {
                            failure_active.fetch_sub(1, Ordering::Relaxed);
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                    Err(_) => thread::sleep(Duration::from_millis(20)),
                }
            }
        })?;
        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn failure(id: Value, error: RpcError) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":error})
}
fn dispatch(value: Value, token: &str, handler: &dyn Handler) -> Option<Value> {
    if let Some(batch) = value.as_array() {
        if batch.is_empty() {
            return Some(failure(Value::Null, RpcError::new(-32600, "Invalid Request")));
        }
        let results: Vec<_> = batch
            .iter()
            .filter_map(|v| {
                if v.is_array() {
                    Some(failure(Value::Null, RpcError::new(-32600, "Invalid Request")))
                } else {
                    dispatch(v.clone(), token, handler)
                }
            })
            .collect();
        return (!results.is_empty()).then_some(Value::Array(results));
    }
    let Some(object) = value.as_object() else {
        return Some(failure(Value::Null, RpcError::new(-32600, "Invalid Request")));
    };
    let valid_id = object
        .get("id")
        .is_none_or(|id| id.is_null() || id.is_number() || id.is_string());
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !valid_id
        || !object.get("method").is_some_and(Value::is_string)
    {
        return Some(failure(Value::Null, RpcError::new(-32600, "Invalid Request")));
    }
    let id = object.get("id").cloned();
    let unauthorized = !endpoint::tokens_match(token, object.get("auth").and_then(Value::as_str).unwrap_or(""));
    let result = if unauthorized {
        Err(RpcError::new(-32001, "Unauthorized"))
    } else if object.get("params").is_some_and(|p| !p.is_object() && !p.is_array()) {
        Err(RpcError::new(-32602, "Invalid params"))
    } else {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handler.handle(
                value["method"].as_str().unwrap(),
                object.get("params").cloned().unwrap_or(json!({})),
            )
        }))
        .unwrap_or_else(|_| Err(RpcError::new(-32603, "Internal error")))
    };
    let id = id?;
    Some(match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(error) => failure(id, error),
    })
}
fn serve(mut stream: Stream, token: &str, handler: &dyn Handler) {
    let deadline = Instant::now() + Duration::from_secs(5);
    // A silent client times out instead of holding its thread forever.
    let _ = stream.set_recv_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_send_timeout(Some(Duration::from_secs(2)));
    let response = match read_line(&mut stream, deadline) {
        Ok(line) => match serde_json::from_slice(&line) {
            Ok(v) => dispatch(v, token, handler),
            Err(_) => Some(failure(Value::Null, RpcError::new(-32700, "Parse error"))),
        },
        Err(e) if e.kind() == io::ErrorKind::InvalidData => Some(failure(
            Value::Null,
            RpcError::new(-32600, "The request exceeds 1 MiB."),
        )),
        Err(_) => None,
    };
    if let Some(response) = response
        && let Ok(mut bytes) = serde_json::to_vec(&response)
    {
        if bytes.len() > MAX_LINE {
            bytes = serde_json::to_vec(&failure(
                response.get("id").cloned().unwrap_or(Value::Null),
                RpcError::invalid_state(),
            ))
            .unwrap();
        }
        bytes.push(b'\n');
        let _ = write_deadline(&mut stream, &bytes, Instant::now() + Duration::from_secs(2));
    }
}
fn read_line(stream: &mut impl Read, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        match stream.read(&mut buf) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => {
                let end = buf[..n].iter().position(|b| *b == b'\n');
                let count = end.unwrap_or(n);
                if result.len() + count > MAX_LINE {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                result.extend_from_slice(&buf[..count]);
                if end.is_some() {
                    return Ok(result);
                }
            }
            // A receive timeout: check the deadline and read again.
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}
fn write_deadline(stream: &mut impl Write, bytes: &[u8], deadline: Instant) -> io::Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        match stream.write(&bytes[offset..]) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(n) => offset += n,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(2)),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
/// Includes authentication-file reading, connection, writing and reading in the overall deadline.
/// The token and raw request are never present in errors or logging.
pub fn call(endpoint: Endpoint, method: String, params: Value, timeout: Duration) -> Result<Value, RpcError> {
    let deadline = Instant::now() + timeout;
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (|| {
            let token = endpoint
                .read_token()
                .map_err(|_| RpcError::new(-32003, "The API authentication file is unavailable."))?;
            let mut stream = ConnectOptions::new()
                .name(endpoint.name().map_err(|_| RpcError::invalid_state())?)
                .wait_mode(ConnectWaitMode::Timeout(
                    deadline.saturating_duration_since(Instant::now()),
                ))
                .connect_sync()
                .map_err(|_| RpcError::new(-32003, "The local API is unavailable."))?;
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1));
            let _ = stream.set_recv_timeout(Some(remaining.min(Duration::from_millis(500))));
            let _ = stream.set_send_timeout(Some(remaining));
            let mut request = serde_json::to_vec(
                &json!({"jsonrpc":"2.0","api_version":1,"id":1,"auth":token,"method":method,"params":params}),
            )
            .map_err(|_| RpcError::invalid_state())?;
            if request.len() > MAX_LINE {
                return Err(RpcError::new(-32600, "The request exceeds 1 MiB."));
            }
            request.push(b'\n');
            write_deadline(&mut stream, &request, deadline).map_err(|_| RpcError::invalid_state())?;
            let response: Value =
                serde_json::from_slice(&read_line(&mut stream, deadline).map_err(|_| RpcError::invalid_state())?)
                    .map_err(|_| RpcError::invalid_state())?;
            if response["jsonrpc"] != "2.0" || response["id"] != 1 {
                return Err(RpcError::invalid_state());
            }
            if let Some(error) = response.get("error") {
                return Err(serde_json::from_value(error.clone()).unwrap_or_else(|_| RpcError::invalid_state()));
            }
            response.get("result").cloned().ok_or_else(RpcError::invalid_state)
        })();
        let _ = tx.send(result);
    });
    rx.recv_timeout(timeout)
        .unwrap_or_else(|_| Err(RpcError::new(-32003, "The local API request timed out.")))
}

#[cfg(test)]
mod tests;
