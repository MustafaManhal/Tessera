//! Shared host latency measurement, also exercised by the integration test.
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use tessera_pty::{EventSink, PtyEvent, PtyHost, SessionId, SpawnSpec};

/// Measures actual one-byte write/read round trips after the child signals readiness.
pub fn latency(runs: usize) -> Result<Vec<f64>, Box<dyn std::error::Error>> {
    latency_under_load(runs, 0, 0)
}

/// The same measurement while `busy` background sessions print continuously (like running agents) and `idle`
/// sessions just sit there (like open panes): NFR-13 asks that the focused pane keeps its latency.
pub fn latency_under_load(runs: usize, busy: usize, idle: usize) -> Result<Vec<f64>, Box<dyn std::error::Error>> {
    let host = PtyHost::new();
    let mut background = Vec::new();
    for index in 0..busy + idle {
        let id = SessionId::new();
        let ack_host = host.clone();
        let sink: EventSink = Arc::new(move |event| {
            if let PtyEvent::Data(bytes) = &event {
                // The UI acknowledges what it has drawn; without it flow control would pause the producer.
                let _ = ack_host.ack(&id, bytes.len());
                if bytes.windows(4).any(|part| part == b"\x1b[6n") {
                    let _ = ack_host.write(&id, b"\x1b[1;1R");
                }
            }
        });
        let mut spec = SpawnSpec::new(std::env::current_dir()?);
        spec.session_id = Some(id);
        let is_busy = index < busy;
        #[cfg(target_os = "macos")]
        {
            spec.program = Some("sh".into());
            spec.args = vec![
                "-c".into(),
                if is_busy {
                    "while :; do printf 'agent output: working on the task, reading files and thinking\\n'; sleep 0.005; done"
                } else {
                    "exec cat"
                }
                .into(),
            ];
        }
        #[cfg(windows)]
        {
            spec.program = Some("powershell.exe".into());
            spec.args = vec![
                "-NoProfile".into(),
                "-Command".into(),
                if is_busy {
                    "while ($true) { [Console]::WriteLine('agent output: working on the task'); Start-Sleep -Milliseconds 5 }"
                } else {
                    "while ($true) { Start-Sleep -Seconds 1 }"
                }
                .into(),
            ];
        }
        host.spawn_with_sink(spec, Some(sink))?;
        background.push(id);
    }
    let result = measure(&host, runs);
    for id in background {
        let _ = host.kill(&id);
    }
    result
}

fn measure(host: &PtyHost, runs: usize) -> Result<Vec<f64>, Box<dyn std::error::Error>> {
    let host = host.clone();
    let id = SessionId::new();
    let (tx, rx) = mpsc::channel();
    let ack_host = host.clone();
    let sink: EventSink = Arc::new(move |event| {
        if let PtyEvent::Data(bytes) = &event {
            let _ = ack_host.ack(&id, bytes.len());
            // ConPTY's initial cursor query must be answered in headless benchmarks.
            if bytes.windows(4).any(|part| part == b"\x1b[6n") {
                let _ = ack_host.write(&id, b"\x1b[1;1R");
            }
        }
        let _ = tx.send(event);
    });
    let mut spec = SpawnSpec::new(std::env::current_dir()?);
    spec.session_id = Some(id);
    #[cfg(target_os = "macos")]
    {
        spec.program = Some("sh".into());
        spec.args = vec!["-c".into(), "stty raw -echo; printf READY; exec cat".into()];
    }
    #[cfg(windows)]
    {
        spec.program = Some("powershell.exe".into());
        spec.args = vec![
            "-NoProfile".into(),
            "-Command".into(),
            "[Console]::Write('READY'); while ($true) { $k=[Console]::ReadKey($true); [Console]::Write($k.KeyChar) }"
                .into(),
        ];
    }
    host.spawn_with_sink(spec, Some(sink))?;
    let result = (|| {
        let timeout = Duration::from_secs(if cfg!(windows) { 30 } else { 10 });
        let deadline = Instant::now() + timeout;
        let mut ready = Vec::new();
        while !ready.windows(5).any(|part| part == b"READY") {
            if let PtyEvent::Data(bytes) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))? {
                ready.extend(bytes);
            }
        }
        let mut samples = Vec::with_capacity(runs);
        for _ in 0..runs {
            let start = Instant::now();
            host.write(&id, b"x")?;
            loop {
                match rx.recv_timeout(timeout)? {
                    PtyEvent::Data(bytes) if bytes.contains(&b'x') => break,
                    PtyEvent::Data(_) => {}
                    PtyEvent::Exit { code } => return Err(format!("echo child exited {code}").into()),
                }
            }
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        Ok(samples)
    })();
    let _ = host.kill(&id);
    result
}
