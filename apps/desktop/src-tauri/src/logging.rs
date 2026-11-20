//! Rolling file logs and the panic hook (TRD §10, NFR-11).
//!
//! One file per day under `<data dir>/logs/`, named `tessera.YYYY-MM-DD.log`,
//! at most seven kept. `RUST_LOG` sets the filter in every build; debug builds
//! also print to stderr so `tauri dev` shows the log live.

use std::io::{self, Write};
use tessera_store::{DataDirs, redact::redact};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::{self, MakeWriter};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Starts the global logger and returns the guard that flushes the file queue.
///
/// The caller must keep the guard alive for the whole process (dropping it
/// stops the background writer and can lose the last lines).
///
/// # Errors
///
/// Returns an [`io::Error`] when the log file cannot be opened or another
/// subscriber was installed first.
pub fn init_logging(dirs: &DataDirs) -> io::Result<WorkerGuard> {
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("tessera")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&dirs.logs)
        .map_err(|error| io::Error::other(error.to_string()))?;

    let (file_writer, guard) = tracing_appender::non_blocking(appender);
    let filter = env_filter();

    let file_layer = fmt::layer()
        .with_writer(RedactingMakeWriter(file_writer))
        .with_ansi(false);
    let registry = tracing_subscriber::registry().with(filter).with(file_layer);

    #[cfg(debug_assertions)]
    let registry = registry.with(fmt::layer().with_writer(|| RedactingWriter::new(io::stderr())));

    registry
        .try_init()
        .map_err(|error| io::Error::other(error.to_string()))?;

    install_panic_hook();
    Ok(guard)
}

/// The `RUST_LOG` filter, or `info` for everything when it is missing or invalid.
fn env_filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
}

/// Logs a panic with `tracing::error!` before the normal panic handler runs.
///
/// The panic hook is process-wide. The previous hook (Rust's default, or a
/// framework's) still runs, so abort/backtrace behaviour does not change.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!(panic = %info, "panic");
        previous(info);
    }));
}

/// Wraps a log sink so every event is redacted before it is written (M12.4). The event is collected first, so a
/// secret that the formatter writes in two pieces is still seen whole.
pub struct RedactingMakeWriter<M>(pub M);

impl<'a, M: MakeWriter<'a>> MakeWriter<'a> for RedactingMakeWriter<M> {
    type Writer = RedactingWriter<M::Writer>;
    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter::new(self.0.make_writer())
    }
}

pub struct RedactingWriter<W: Write> {
    inner: W,
    buffer: Vec<u8>,
}

impl<W: Write> RedactingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner,
            buffer: Vec::new(),
        }
    }
    fn drain(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&self.buffer).into_owned();
        self.buffer.clear();
        self.inner.write_all(redact(&text).as_bytes())
    }
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.drain()?;
        self.inner.flush()
    }
}

impl<W: Write> Drop for RedactingWriter<W> {
    fn drop(&mut self) {
        let _ = self.drain();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn events_are_redacted_even_when_written_in_pieces() {
        let sink = Sink::default();
        let kept = sink.clone();
        let make = RedactingMakeWriter(move || sink.clone());
        {
            let mut writer = make.make_writer();
            writer.write_all(b"INFO login with ghp_0123456789abcd").unwrap();
            writer.write_all(b"efghijABCDEFGHIJ012345 ok\n").unwrap();
        }
        let text = String::from_utf8(kept.0.lock().unwrap().clone()).unwrap();
        assert_eq!(text, "INFO login with [REDACTED] ok\n");
    }

    #[test]
    fn plain_events_pass_through_unchanged() {
        let sink = Sink::default();
        let kept = sink.clone();
        let make = RedactingMakeWriter(move || sink.clone());
        make.make_writer().write_all(b"INFO Tessera started\n").unwrap();
        assert_eq!(kept.0.lock().unwrap().as_slice(), b"INFO Tessera started\n");
    }
}
