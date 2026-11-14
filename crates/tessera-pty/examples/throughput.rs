//! Throughput baseline: push 100 MiB through the host into a null sink and print MiB/s.
//!
//! ```sh
//! cargo run --release -p tessera-pty --example throughput
//! ```

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tessera_pty::{EventSink, PtyEvent, PtyHost, SessionId, SpawnSpec};

const MEBI: usize = 1024 * 1024;
const TOTAL: usize = 100 * MEBI;

/// Windows producer: a PowerShell process writing the file to stdout in one large stream write (like a real program),
/// falling back to `cmd /c type`, which goes through the console one line at a time and is far slower.
#[cfg(windows)]
fn windows_producer(path: &std::path::Path) -> (String, Vec<String>) {
    let quoted = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$o=[Console]::OpenStandardOutput(); $f=[IO.File]::OpenRead('{quoted}'); $b=New-Object byte[] 1048576; while(($n=$f.Read($b,0,$b.Length)) -gt 0){{ $o.Write($b,0,$n) }}; $o.Flush()"
    );
    for shell in ["pwsh", "powershell"] {
        if std::process::Command::new(shell)
            .arg("-NoProfile")
            .arg("-Command")
            .arg("exit 0")
            .output()
            .is_ok_and(|o| o.status.success())
        {
            return (shell.to_string(), vec!["-NoProfile".into(), "-Command".into(), script]);
        }
    }
    (
        "cmd".into(),
        vec!["/c".into(), "type".into(), path.to_string_lossy().into_owned()],
    )
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let host = PtyHost::new();
    let id = SessionId::new();
    let mut spec = SpawnSpec::new(cwd);
    spec.session_id = Some(id);

    let path = std::env::temp_dir().join(format!("tessera-throughput-{}.txt", std::process::id()));
    let mut text = vec![b'x'; TOTAL];
    for newline in text.iter_mut().skip(4095).step_by(4096) {
        *newline = b'\n';
    }
    std::fs::write(&path, text)?;
    #[cfg(windows)]
    {
        let (program, args) = windows_producer(&path);
        spec.program = Some(program);
        spec.args = args;
    }
    #[cfg(target_os = "macos")]
    {
        spec.program = Some("cat".into());
        spec.args = vec![path.to_string_lossy().into_owned()];
    }
    if std::env::args().any(|arg| arg == "--short-lines") {
        #[cfg(target_os = "macos")]
        {
            spec.program = Some("sh".into());
            spec.args = vec!["-c".into(), format!("yes tessera | head -c {TOTAL}")];
        }
    }
    run(&host, spec, id, Some(path))
}

fn run(
    host: &PtyHost,
    spec: SpawnSpec,
    id: SessionId,
    cleanup: Option<std::path::PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let (exit_tx, exit_rx) = mpsc::channel();
    let received = Arc::new(Mutex::new(0_usize));
    let host_for_sink = host.clone();
    let sink: EventSink = {
        let received = Arc::clone(&received);
        Arc::new(move |event| match event {
            PtyEvent::Data(bytes) => {
                let _ = host_for_sink.ack(&id, bytes.len());
                if bytes.windows(4).any(|part| part == b"\x1b[6n") {
                    let _ = host_for_sink.write(&id, b"\x1b[1;1R");
                }
                *received.lock().expect("counter lock") += bytes.len();
            }
            PtyEvent::Exit { code } => {
                let _ = exit_tx.send(code);
            }
        })
    };

    let started = Instant::now();
    host.spawn_with_sink(spec, Some(sink))?;
    let code = exit_rx.recv_timeout(Duration::from_secs(120))?;
    let elapsed = started.elapsed();
    let bytes = *received.lock().expect("counter lock");
    let mib_per_second = bytes as f64 / MEBI as f64 / elapsed.as_secs_f64();

    println!(
        "{bytes} bytes in {:.2} s: {mib_per_second:.2} MiB/s (exit {code})",
        elapsed.as_secs_f64()
    );
    if let Some(metrics) = host.metrics(&id)? {
        println!("{metrics:?}");
    }
    let _ = host.kill(&id);
    if let Some(path) = cleanup {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}
