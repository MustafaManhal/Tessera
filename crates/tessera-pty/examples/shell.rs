//! Run the default shell in a Tessera PTY and bridge it to the current terminal.
//!
//! ```sh
//! cargo run -p tessera-pty --example shell
//! ```
//!
//! The example puts the terminal in raw mode with `stty` (no extra crate), forwards
//! keystrokes and prints PTY output. Type `exit` in the shell, or press Ctrl-D, to
//! return; the terminal is restored on the way out.

use std::io::{Read, Write};
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use tessera_pty::{EventSink, PtyEvent, PtyHost, SpawnSpec};

struct RawMode;

impl RawMode {
    fn enable() -> Self {
        let _ = Command::new("stty").args(["raw", "-echo"]).status();
        Self
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = Command::new("stty").arg("sane").status();
    }
}

fn terminal_size() -> (u16, u16) {
    let output = Command::new("stty").arg("size").output();
    let text = output
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string());
    let parsed = text.as_deref().and_then(|text| {
        let mut parts = text.split_whitespace();
        let rows = parts.next()?.parse().ok()?;
        let cols = parts.next()?.parse().ok()?;
        Some((cols, rows))
    });
    parsed.unwrap_or((80, 24))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let host = PtyHost::new();
    let (cols, rows) = terminal_size();
    let mut spec = SpawnSpec::new(cwd);
    spec.cols = cols;
    spec.rows = rows;

    let (exit_tx, exit_rx) = mpsc::channel::<u32>();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let sink: EventSink = {
        let stdout = Arc::clone(&stdout);
        Arc::new(move |event| match event {
            PtyEvent::Data(bytes) => {
                let mut out = stdout.lock().expect("stdout lock");
                let _ = out.write_all(&bytes);
                let _ = out.flush();
            }
            PtyEvent::Exit { code } => {
                let _ = exit_tx.send(code);
            }
        })
    };

    let id = host.spawn_with_sink(spec, Some(sink))?;
    println!("Tessera PTY session {id}. Type `exit` (or press Ctrl-D) to quit.\r");

    let _raw = RawMode::enable();
    let input_host = host.clone();
    let _input = thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut stdin = stdin.lock();
        let mut buffer = [0_u8; 1024];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if input_host.write(&id, &buffer[..read]).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let code = exit_rx.recv().unwrap_or(1);
    drop(_raw);
    host.kill(&id).ok();
    println!("\r\n[process exited with code {code}]");
    Ok(())
}
