//! `tesserad --data <app data folder> [--idle-seconds N]`: the session daemon. The app starts it on demand
//! (`tesserad::start_detached`); it quits after `--idle-seconds` (default 600) with no client and no running session.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

fn main() -> ExitCode {
    let mut data: Option<PathBuf> = None;
    let mut options = tesserad::Options::default();
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--data") => data = args.next().map(PathBuf::from),
            Some("--idle-seconds") => {
                let Some(seconds) = args.next().and_then(|s| s.to_str()?.parse::<u64>().ok()) else {
                    eprintln!("--idle-seconds needs a number");
                    return ExitCode::from(2);
                };
                options.idle = Duration::from_secs(seconds);
            }
            Some("--no-login-environment") => options.login_environment = false,
            // Tests only: pretend to be another build, to exercise the update handshake.
            Some("--version-label") => match args.next().and_then(|s| s.into_string().ok()) {
                Some(label) => options.version = label,
                None => return ExitCode::from(2),
            },
            Some("--version") => {
                println!(
                    "tesserad {} (protocol {})",
                    env!("CARGO_PKG_VERSION"),
                    tesserad::PROTOCOL_VERSION
                );
                return ExitCode::SUCCESS;
            }
            _ => {
                eprintln!("usage: tesserad --data <folder> [--idle-seconds N] [--no-login-environment]");
                return ExitCode::from(2);
            }
        }
    }
    let Some(data) = data else {
        eprintln!("usage: tesserad --data <folder> [--idle-seconds N] [--no-login-environment]");
        return ExitCode::from(2);
    };
    match tesserad::server::run(&tesserad::Endpoint::new(data), options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(tesserad::StartError::AlreadyRunning(endpoint)) => {
            eprintln!("a session daemon is already running at {endpoint}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("tesserad: {error}");
            ExitCode::FAILURE
        }
    }
}
