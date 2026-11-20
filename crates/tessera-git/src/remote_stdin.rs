//! Deadline-aware Git stdin for both local and SSH worktrees. Kept separate from the SSH transport implementation.
use crate::{GitError, remote};
use std::{
    io::{self, Read, Write},
    path::Path,
    process::{Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
const OUTPUT_LIMIT: usize = 1024 * 1024 + 1;
fn reader(mut input: impl Read + Send + 'static) -> mpsc::Receiver<io::Result<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let result = (|| {
            let mut out = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = input.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                let take = n.min(OUTPUT_LIMIT.saturating_sub(out.len()));
                out.extend_from_slice(&buf[..take]);
            }
            Ok(out)
        })();
        let _ = tx.send(result);
    });
    rx
}
fn receive<T>(rx: mpsc::Receiver<io::Result<T>>, started: Instant, timeout: Duration) -> Result<T, GitError> {
    match rx.recv_timeout(timeout.saturating_sub(started.elapsed())) {
        Ok(value) => Ok(value?),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(GitError::Timeout { timeout }),
        Err(_) => Err(io::Error::other("Git pipe reader stopped").into()),
    }
}
/// Run Git with a stdin payload. Nonzero Git exits preserve stdout and stderr for hook/apply diagnostics.
/// SSH host identity/options/askpass are resolved by the existing transport; all arguments are quoted.
pub fn git_stdin(root: &Path, args: &[&str], input: &[u8], timeout: Duration) -> Result<Output, GitError> {
    let mut command = if let Some((alias, dir)) = remote::split(root) {
        let mut script = format!(
            "cd {} && git --no-pager -c safe.bareRepository=all",
            remote::quote(&dir)
        );
        for arg in args {
            script.push(' ');
            script.push_str(&remote::quote(arg));
        }
        remote::host(&alias)?.command(&script)
    } else {
        let mut command = Command::new("git");
        crate::NoWindow::no_window(&mut command);
        command.args(["--no-pager", "-c", "safe.bareRepository=all"]);
        #[cfg(windows)]
        command.args(["-c", "core.longpaths=true"]);
        #[cfg(windows)]
        let root = crate::windows_path::git_path(root);
        command.arg("-C").arg(root).args(args);
        command
    };
    let started = Instant::now();
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = reader(child.stdout.take().expect("stdout pipe"));
    let stderr = reader(child.stderr.take().expect("stderr pipe"));
    let mut stdin = child.stdin.take().expect("stdin pipe");
    let bytes = input.to_vec();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(stdin.write_all(&bytes));
    });
    let result = (|| {
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if started.elapsed() >= timeout {
                return Err(GitError::Timeout { timeout });
            }
            thread::sleep(Duration::from_millis(2));
        };
        let written = receive(rx, started, timeout);
        let stdout = receive(stdout, started, timeout)?;
        let stderr = receive(stderr, started, timeout)?;
        if status.success() {
            written?;
        }
        if remote::is_remote(root) && status.code() == Some(255) {
            return Err(GitError::Remote {
                message: String::from_utf8_lossy(&stderr).into_owned(),
            });
        }
        Ok(Output { status, stdout, stderr })
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn remote_stdin_uses_transport_options_quotes_and_preserves_failures() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo '界");
        std::fs::create_dir(&root).unwrap();
        assert!(Command::new("git").arg("init").arg(&root).status().unwrap().success());
        let ssh = tmp.path().join("fixture-ssh");
        std::fs::write(
            &ssh,
            "#!/bin/sh\nfor arg do script=\"$arg\"; done\nexec /bin/sh -c \"$script\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        remote::set_resolver(move |alias| {
            (alias == "stdin-transport-fixture").then(|| remote::RemoteHost {
                program: ssh.clone(),
                options: vec!["-p".into(), "2222".into()],
                target: "fixture.invalid".into(),
                env: Default::default(),
            })
        });
        let address = remote::encode("stdin-transport-fixture", root.to_str().unwrap());
        let payload = vec![b'x'; 131072];
        let local = git_stdin(&root, &["hash-object", "--stdin"], &payload, Duration::from_secs(5)).unwrap();
        let routed = git_stdin(
            Path::new(&address),
            &["hash-object", "--stdin"],
            &payload,
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(routed.status.success());
        assert_eq!(routed.stdout, local.stdout);
        let failed = git_stdin(
            Path::new(&address),
            &["not-a-real-git-command"],
            b"",
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(!failed.status.success());
        assert!(String::from_utf8_lossy(&failed.stderr).contains("not-a-real-git-command"));
        let timed = git_stdin(
            &root,
            &["-c", "alias.fixture-wait=!sleep 1", "fixture-wait"],
            b"",
            Duration::from_millis(30),
        );
        assert!(matches!(timed, Err(GitError::Timeout { .. })));
    }
}
