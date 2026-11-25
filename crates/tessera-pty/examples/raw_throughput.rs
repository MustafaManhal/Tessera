//! Kernel PTY ceiling, without coalescing, scrollback or acknowledgement.
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pair = native_pty_system().openpty(PtySize::default())?;
    #[cfg(target_os = "macos")]
    let mut command = CommandBuilder::new("sh");
    #[cfg(target_os = "macos")]
    command.args(["-c", "yes tessera | head -c 104857600"]);
    #[cfg(windows)]
    let mut command = CommandBuilder::new("powershell.exe");
    #[cfg(windows)]
    command.args(["-NoProfile", "-Command", "[Console]::Write(('x' * 104857600))"]);
    let path = std::env::temp_dir().join(format!("tessera-raw-{}.txt", std::process::id()));
    if !std::env::args().any(|arg| arg == "--short-lines") {
        let mut data = vec![b'x'; 104857600];
        for newline in data.iter_mut().skip(4095).step_by(4096) {
            *newline = b'\n';
        }
        std::fs::write(&path, data)?;
        #[cfg(target_os = "macos")]
        {
            command = CommandBuilder::new("cat");
            command.arg(&path);
        }
        #[cfg(windows)]
        {
            command = CommandBuilder::new("cmd");
            command.args(["/c", "type"]);
            command.arg(&path);
        }
    }
    let start = Instant::now();
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let mut buffer = vec![0; 65536];
    let mut bytes = 0usize;
    let mut reads = 0usize;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if buffer[..n].windows(4).any(|part| part == b"\x1b[6n") {
                    writer.write_all(b"\x1b[1;1R")?;
                    writer.flush()?;
                }
                bytes += n;
                reads += 1;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    child.wait()?;
    println!(
        "raw {bytes} bytes, {reads} reads in {:.3} s: {:.2} MiB/s",
        start.elapsed().as_secs_f64(),
        bytes as f64 / 1048576.0 / start.elapsed().as_secs_f64()
    );
    let _ = std::fs::remove_file(path);
    Ok(())
}
