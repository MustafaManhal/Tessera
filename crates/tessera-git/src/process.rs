//! Deadline-aware process output for Git invocations.

use std::{
    io::{self, Read},
    process::{Child, Command, ExitStatus, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use crate::GitError;

/// Run a command, draining both pipes concurrently so a full pipe cannot block Git.
pub(crate) fn output(command: &mut Command, timeout: Duration) -> Result<Output, GitError> {
    if timeout.is_zero() {
        return Err(GitError::Timeout { timeout });
    }
    let started = Instant::now();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let result = wait_with_output(&mut child, started, timeout);
    if result.is_err() {
        // Reap even if kill races with normal exit. Pipe readers own only the pipe handles.
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

fn wait_with_output(child: &mut Child, started: Instant, timeout: Duration) -> Result<Output, GitError> {
    let stdout = read_pipe(child.stdout.take().expect("stdout pipe"), "git-stdout")?;
    let stderr = read_pipe(child.stderr.take().expect("stderr pipe"), "git-stderr")?;
    let status: ExitStatus = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(GitError::Timeout { timeout });
        }
        thread::sleep(remaining.min(Duration::from_millis(2)));
    };
    let collect = |pipe: mpsc::Receiver<io::Result<Vec<u8>>>| -> Result<Vec<u8>, GitError> {
        match pipe.recv_timeout(timeout.saturating_sub(started.elapsed())) {
            Ok(result) => Ok(result?),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(GitError::Timeout { timeout }),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(io::Error::other("git output reader stopped").into()),
        }
    };
    Ok(Output {
        status,
        stdout: collect(stdout)?,
        stderr: collect(stderr)?,
    })
}

fn read_pipe(mut pipe: impl Read + Send + 'static, name: &str) -> io::Result<mpsc::Receiver<io::Result<Vec<u8>>>> {
    let (tx, rx) = mpsc::channel();
    thread::Builder::new().name(name.into()).spawn(move || {
        let mut bytes = Vec::new();
        let _ = tx.send(pipe.read_to_end(&mut bytes).map(|_| bytes));
    })?;
    Ok(rx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_child_is_terminated_at_the_call_deadline() {
        #[cfg(target_os = "macos")]
        let dir = tempfile::tempdir().unwrap();
        #[cfg(target_os = "macos")]
        let pid_file = dir.path().join("pid");
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", r#"printf '%s' "$$" > "$1"; exec /bin/sleep 30"#, "slow-fixture"])
                .arg(&pid_file);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]);
            command
        };
        let started = Instant::now();
        let timeout = Duration::from_millis(500);
        let error = output(&mut command, timeout).unwrap_err();
        assert!(matches!(error, GitError::Timeout { timeout: configured } if configured == timeout));
        assert_eq!(error.code(), "git.timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
        #[cfg(target_os = "macos")]
        {
            let pid = std::fs::read_to_string(pid_file).unwrap();
            assert!(pid.parse::<u32>().is_ok());
            let status = Command::new("/bin/kill")
                .args(["-0", &pid])
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(!status.success(), "timed out child was still running");
        }
    }
}
