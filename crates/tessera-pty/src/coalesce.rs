//! Output coalescing: batch PTY reads into one event every 8 ms or 256 KiB.

use std::time::{Duration, Instant};

/// Accumulates PTY output and decides when it should become one `Data` event.
///
/// The first read after an idle interval is emitted immediately. Reads during a
/// burst are held until [`Coalescer::next_flush`] or the size limit. The timing is passed
/// in by the caller, which keeps the type pure and makes the tests deterministic.
#[derive(Debug, Clone)]
pub struct Coalescer {
    interval: Duration,
    max_bytes: usize,
    pending: Vec<u8>,
    first_pending: Option<Instant>,
    last_flush: Option<Instant>,
}

impl Coalescer {
    /// Creates a coalescer with an explicit interval and size limit.
    #[must_use]
    pub fn new(interval: Duration, max_bytes: usize) -> Self {
        Self {
            interval,
            max_bytes: max_bytes.max(1),
            pending: Vec::new(),
            first_pending: None,
            last_flush: None,
        }
    }

    /// Appends a read and returns a batch when it is full or the interval elapsed.
    pub fn push(&mut self, bytes: &[u8], now: Instant) -> Option<Vec<u8>> {
        if bytes.is_empty() {
            return self.flush_if_due(now);
        }
        if self.first_pending.is_none() {
            self.first_pending = Some(now);
        }
        self.pending.extend_from_slice(bytes);
        let idle = self
            .last_flush
            .is_none_or(|last| now.saturating_duration_since(last) >= self.interval);
        if self.pending.len() >= self.max_bytes || idle {
            return self.take(now);
        }
        self.flush_if_due(now)
    }

    /// Input-triggered output bypasses batching, including back-to-back keystrokes.
    /// Pending burst bytes are included first, preserving stream order.
    pub fn push_after_input(&mut self, bytes: &[u8], now: Instant, input_pending: bool) -> Option<Vec<u8>> {
        let batch = self.push(bytes, now);
        if batch.is_some() || !input_pending {
            batch
        } else {
            self.take(now)
        }
    }

    /// Returns the batch when the flush interval has elapsed, otherwise `None`.
    pub fn flush_if_due(&mut self, now: Instant) -> Option<Vec<u8>> {
        match self.first_pending {
            Some(first) if now.saturating_duration_since(first) >= self.interval => self.take(now),
            _ => None,
        }
    }

    /// Returns everything buffered, for a timer tick or the end of a session.
    pub fn flush(&mut self, now: Instant) -> Option<Vec<u8>> {
        self.take(now)
    }

    /// The instant at which the next timer-driven flush is due, if data is waiting.
    #[must_use]
    pub fn next_flush(&self) -> Option<Instant> {
        self.first_pending.map(|first| first + self.interval)
    }

    /// Bytes waiting for the next flush.
    #[must_use]
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    fn take(&mut self, now: Instant) -> Option<Vec<u8>> {
        if self.pending.is_empty() {
            return None;
        }
        self.first_pending = None;
        self.last_flush = Some(now);
        Some(std::mem::take(&mut self.pending))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const INTERVAL: Duration = Duration::from_millis(8);
    const MAX: usize = 256 * 1024;
    #[test]
    fn echo_after_idle_flushes_immediately() {
        let start = Instant::now();
        let mut c = Coalescer::new(INTERVAL, MAX);
        assert_eq!(c.push(b"a", start), Some(b"a".to_vec()));
        assert_eq!(c.push(b"b", start + INTERVAL), Some(b"b".to_vec()));
        assert_eq!(c.next_flush(), None);
    }
    #[test]
    fn burst_is_batched_and_silent_tail_has_a_deadline() {
        let start = Instant::now();
        let mut c = Coalescer::new(INTERVAL, MAX);
        assert_eq!(c.push(b"a", start), Some(b"a".to_vec()));
        assert_eq!(c.push(b"b", start + Duration::from_millis(1)), None);
        assert_eq!(c.push(b"c", start + Duration::from_millis(2)), None);
        assert_eq!(c.next_flush(), Some(start + Duration::from_millis(9)));
        assert_eq!(c.flush_if_due(start + Duration::from_millis(8)), None);
        assert_eq!(c.flush_if_due(start + Duration::from_millis(9)), Some(b"bc".to_vec()));
    }
    #[test]
    fn full_batch_flushes_without_waiting() {
        let start = Instant::now();
        let mut c = Coalescer::new(INTERVAL, MAX);
        c.push(b"x", start);
        let bytes = vec![b'y'; MAX];
        assert_eq!(c.push(&bytes, start), Some(bytes));
        assert_eq!(c.pending_len(), 0);
    }
    #[test]
    fn input_bypasses_batching_without_reordering_the_burst_tail() {
        let start = Instant::now();
        let mut c = Coalescer::new(INTERVAL, MAX);
        assert_eq!(c.push(b"first", start), Some(b"first".to_vec()));
        assert_eq!(c.push(b"tail", start), None);
        assert_eq!(c.push_after_input(b"echo", start, true), Some(b"tailecho".to_vec()));
        assert_eq!(c.push_after_input(b"more", start, false), None);
    }
    #[test]
    fn empty_push_does_not_reset_idle_or_flush_pending_early() {
        let start = Instant::now();
        let mut c = Coalescer::new(INTERVAL, MAX);
        assert_eq!(c.flush(start), None);
        assert_eq!(c.push(b"", start), None);
        assert_eq!(c.push(b"x", start), Some(b"x".to_vec()));
        assert_eq!(c.push(b"y", start), None);
        assert_eq!(c.push(b"", start), None);
        assert_eq!(c.flush(start), Some(b"y".to_vec()));
    }
}
