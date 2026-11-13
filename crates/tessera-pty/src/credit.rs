//! Credit-based flow control counters.

/// Tracks how many bytes the UI may still receive before it acknowledges some.
///
/// The pure counter is unit-tested here; the host wraps it in a mutex and a
/// condition variable so the reader thread blocks instead of spinning when the
/// credit is exhausted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditCounter {
    limit: usize,
    used: usize,
}

impl CreditCounter {
    /// Creates a counter with `limit` bytes available.
    #[must_use]
    pub const fn new(limit: usize) -> Self {
        Self { limit, used: 0 }
    }

    /// Bytes the UI has been sent but not yet acknowledged.
    #[must_use]
    pub const fn used(&self) -> usize {
        self.used
    }

    /// Bytes that may still be sent.
    #[must_use]
    pub const fn available(&self) -> usize {
        self.limit.saturating_sub(self.used)
    }

    /// Takes up to `want` bytes of credit and returns how many were taken.
    pub fn take(&mut self, want: usize) -> usize {
        let taken = want.min(self.available());
        self.used += taken;
        taken
    }

    /// Returns credit after the UI has written bytes to xterm.js.
    ///
    /// Extra acknowledgements are clamped, so a buggy or duplicated ack can
    /// never grant more than the limit.
    pub fn ack(&mut self, bytes: usize) {
        self.used = self.used.saturating_sub(bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMIT: usize = 2 * 1024 * 1024;

    #[test]
    fn taking_more_than_available_takes_only_the_credit() {
        let mut credit = CreditCounter::new(10);
        assert_eq!(credit.take(4), 4);
        assert_eq!(credit.available(), 6);
        assert_eq!(credit.take(100), 6);
        assert_eq!(credit.take(1), 0);
        assert_eq!(credit.available(), 0);
        assert_eq!(credit.used(), 10);
    }

    #[test]
    fn ack_returns_credit_and_is_clamped() {
        let mut credit = CreditCounter::new(LIMIT);
        assert_eq!(credit.take(LIMIT), LIMIT);
        credit.ack(1024);
        assert_eq!(credit.available(), 1024);
        credit.ack(LIMIT * 4);
        assert_eq!(credit.available(), LIMIT);
        assert_eq!(credit.used(), 0);
    }

    #[test]
    fn ack_more_than_outstanding_never_goes_negative() {
        let mut credit = CreditCounter::new(8);
        credit.ack(1000);
        assert_eq!(credit.used(), 0);
        assert_eq!(credit.available(), 8);
    }
}
