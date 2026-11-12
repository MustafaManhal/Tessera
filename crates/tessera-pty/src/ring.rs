//! The Rust-side scrollback ring: the last N bytes of a session.
//!
//! The UI keeps its own scrollback in xterm.js. This copy is for restore (FR-23),
//! the M8 daemon and the local API, so a pane can be reconstructed after the
//! window closes or a session is reattached.

use std::collections::VecDeque;

/// A fixed-capacity byte ring that keeps the most recent output.
///
/// Pushing more than the capacity keeps the tail, so a single huge write can
/// never grow the ring past its limit.
#[derive(Debug, Clone)]
pub struct ScrollbackRing {
    capacity: usize,
    bytes: VecDeque<u8>,
}

impl ScrollbackRing {
    /// Creates a ring that keeps at most `capacity` bytes.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            bytes: VecDeque::with_capacity(capacity.min(64 * 1024)),
        }
    }

    /// Appends output, dropping the oldest bytes once the ring is full.
    pub fn push(&mut self, bytes: &[u8]) {
        if self.capacity == 0 {
            return;
        }
        if bytes.len() >= self.capacity {
            self.bytes.clear();
            self.bytes.extend(&bytes[bytes.len() - self.capacity..]);
            return;
        }
        let overflow = (self.bytes.len() + bytes.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.bytes.drain(..overflow);
        }
        self.bytes.extend(bytes);
    }

    /// A copy of the buffered output, oldest first.
    #[must_use]
    pub fn snapshot(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }

    /// The number of bytes currently buffered.
    #[must_use]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// True when nothing has been written yet.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// The maximum number of bytes the ring keeps.
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_tail_after_wrap_around() {
        let mut ring = ScrollbackRing::new(8);
        ring.push(b"abcdef");
        ring.push(b"ghij");
        assert_eq!(ring.len(), 8);
        assert_eq!(ring.snapshot(), b"cdefghij");
    }

    #[test]
    fn a_single_write_larger_than_the_ring_keeps_the_last_bytes() {
        let mut ring = ScrollbackRing::new(4);
        ring.push(b"0123456789");
        assert_eq!(ring.snapshot(), b"6789");
        assert_eq!(ring.len(), 4);
    }

    #[test]
    fn an_empty_ring_is_empty() {
        let ring = ScrollbackRing::new(16);
        assert!(ring.is_empty());
        assert_eq!(ring.snapshot(), Vec::<u8>::new());
        assert_eq!(ring.capacity(), 16);
    }

    #[test]
    fn a_zero_capacity_ring_discards_everything() {
        let mut ring = ScrollbackRing::new(0);
        ring.push(b"anything");
        assert!(ring.is_empty());
    }
}
