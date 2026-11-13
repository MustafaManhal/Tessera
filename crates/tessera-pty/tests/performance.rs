//! Performance gates use real PTYs and event deadlines, with no fixed sleeps.
#[path = "../examples/support/mod.rs"]
mod support;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use tessera_pty::{EventSink, PtyEvent, PtyHost, SessionId, SpawnSpec};

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

#[test]
fn single_byte_echo_averages_under_twenty_ms() {
    let samples = support::latency(100).expect("round trips");
    let average = samples.iter().sum::<f64>() / samples.len() as f64;
    assert!(average < 20.0, "average echo latency {average:.3} ms");
}

#[test]
#[ignore = "machine performance gate; run with scripts/bench/throughput.mjs"]
fn throughput_meets_nfr02() {
    let dir = tempfile::tempdir().expect("fixture directory");
    let path = dir.path().join("100m.txt");
    let total = 100 * 1024 * 1024;
    let mut data = vec![b'x'; total];
    for newline in data.iter_mut().skip(4095).step_by(4096) {
        *newline = b'\n';
    }
    std::fs::write(&path, data).expect("text fixture");
    let host = PtyHost::new();
    let id = SessionId::new();
    let mut spec = SpawnSpec::new(dir.path());
    spec.session_id = Some(id);
    #[cfg(target_os = "macos")]
    {
        spec.program = Some("cat".into());
        spec.args = vec![path.to_string_lossy().into_owned()];
    }
    #[cfg(windows)]
    {
        let (program, args) = windows_producer(&path);
        spec.program = Some(program);
        spec.args = args;
    }
    let (tx, rx) = mpsc::channel();
    let sink: EventSink = Arc::new(move |event| {
        let _ = tx.send(event);
    });
    let start = Instant::now();
    host.spawn_with_sink(spec, Some(sink)).expect("spawn");
    let deadline = start + Duration::from_secs(if cfg!(windows) { 45 } else { 5 });
    let mut received = 0;
    loop {
        match rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("NFR-02 deadline")
        {
            PtyEvent::Data(bytes) => {
                host.ack(&id, bytes.len()).expect("UI ack");
                if bytes.windows(4).any(|part| part == b"\x1b[6n") {
                    host.write(&id, b"\x1b[1;1R").expect("cursor reply");
                }
                received += bytes.len();
            }
            PtyEvent::Exit { code } => {
                assert_eq!(code, 0);
                break;
            }
        }
    }
    host.kill(&id).expect("cleanup");
    assert!(received >= total, "truncated output {received}");
    // macOS: 100 MiB in 5 s. Windows: the pseudo-console (conhost) renders everything it carries, about 9 MiB/s
    // measured on a shared runner with a PowerShell stream producer (D-16), so the gate there is 40 s.
    let limit = if cfg!(windows) { 40 } else { 5 };
    assert!(
        start.elapsed() <= Duration::from_secs(limit),
        "NFR-02 exceeded {limit} seconds"
    );
}

/// Host-only budget; Windows gets three times the event wait deadline in the shared harness.
#[test]
#[ignore = "machine latency gate; run with pnpm bench:latency"]
fn latency_meets_budget() {
    let mut samples = support::latency(1000).expect("round trips");
    samples.sort_by(f64::total_cmp);
    // Windows pseudo-console (ConPTY) paces its output in frames of about 16 ms, so a keystroke echo cannot come back
    // faster than that there (measured p95 21.7 ms on a shared runner, D-15). macOS keeps the 3 ms host budget.
    let budget = if cfg!(windows) { 40.0 } else { 3.0 };
    assert!(
        samples[949] <= budget,
        "host p95 {:.3} ms exceeds {budget} ms",
        samples[949]
    );
}

/// NFR-13: 50 open sessions, 20 of them printing like running agents, and the focused one still echoes in budget.
#[test]
#[ignore = "machine scale gate; run with pnpm bench:latency"]
fn latency_holds_with_twenty_busy_agents_and_fifty_sessions() {
    let mut samples = support::latency_under_load(300, 20, 30).expect("round trips under load");
    samples.sort_by(f64::total_cmp);
    let budget = if cfg!(windows) { 40.0 } else { 16.0 };
    let p95 = samples[(samples.len() * 95 / 100).min(samples.len() - 1)];
    println!("under load: p50={:.3} ms p95={p95:.3} ms", samples[samples.len() / 2]);
    assert!(
        p95 <= budget,
        "p95 {p95:.3} ms exceeds {budget} ms with 20 busy agents and 50 sessions"
    );
}
