//! Offline runtime fixture: cargo build -p tessera-agents --example fake_agent.
//! --version prints 1.2.3; --version-file PATH reads a version fixture; --hang-version hangs. FAKE_AGENT_VERSION overrides the version.
//! Arg prompt after `--` or `--prompt`; otherwise reads stdin (also models typed PTY input).
//! FAKE_AGENT_NEEDS_INPUT emits a line, FAKE_AGENT_NOTIFY emits OSC 9,
//! FAKE_AGENT_REPORT_CONTEXT prints only Tessera identity/cwd for offline tests.
//! FAKE_AGENT_WAIT_MS delays exit; FAKE_AGENT_EXIT_CODE chooses the exit status.
use std::{
    io::{self, BufRead, Write},
    time::Duration,
};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--hang-version") {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    if args.iter().any(|a| a == "--version") {
        let version = args
            .windows(2)
            .find(|a| a[0] == "--version-file")
            .and_then(|a| std::fs::read_to_string(&a[1]).ok())
            .unwrap_or_else(|| std::env::var("FAKE_AGENT_VERSION").unwrap_or("1.2.3".into()));
        println!("fake-agent {version}");
        return;
    }
    println!(">");
    io::stdout().flush().unwrap();
    let prompt = args
        .windows(2)
        .find(|a| a[0] == "--" || a[0] == "--prompt")
        .map(|a| a[1].clone())
        .unwrap_or_else(|| {
            let mut line = String::new();
            io::stdin().lock().read_line(&mut line).unwrap();
            line.trim_end().into()
        });
    let prompt = prompt.replace("\x1b[200~", "").replace("\x1b[201~", "");
    println!("prompt: {prompt}");
    if std::env::var_os("FAKE_AGENT_REPORT_CONTEXT").is_some() {
        println!(
            "agent-session: {}",
            std::env::var("TESSERA_AGENT_SESSION_ID").unwrap_or_default()
        );
        println!(
            "host-session: {}",
            std::env::var("TESSERA_SESSION_ID").unwrap_or_default()
        );
        println!("cwd: {}", std::env::current_dir().unwrap().display());
    }
    if let Ok(line) = std::env::var("FAKE_AGENT_NEEDS_INPUT") {
        println!("{line}");
    }
    if let Ok(message) = std::env::var("FAKE_AGENT_NOTIFY") {
        print!("\x1b]9;{message}\x07");
    }
    io::stdout().flush().unwrap();
    if let Ok(ms) = std::env::var("FAKE_AGENT_WAIT_MS") {
        std::thread::sleep(Duration::from_millis(ms.parse().unwrap_or(0)));
    }
    std::process::exit(
        std::env::var("FAKE_AGENT_EXIT_CODE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
    );
}
