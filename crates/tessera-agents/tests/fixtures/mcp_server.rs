//! Standalone fixture compiled by the probe test; emits only MCP protocol messages.
use std::io::{BufRead, Write};
fn main() {
    if std::env::args().any(|a| a == "--sleep") { std::thread::sleep(std::time::Duration::from_secs(30)); return; }
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.contains("initialize") && !line.contains("notifications/") {
            println!(r#"{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":"2025-06-18","capabilities":{{"tools":{{}}}},"serverInfo":{{"name":"fixture","version":"1"}}}}}}"#);
        } else if line.contains("tools/list") {
            println!(r#"{{"jsonrpc":"2.0","id":2,"result":{{"tools":[{{"name":"fixture_tool","inputSchema":{{"type":"object"}}}}]}}}}"#);
        }
        std::io::stdout().flush().unwrap();
    }
}
