//! The initial cursor inheritance exchange used by portable-pty's ConPTY backend.

use std::io::{self, Write};

const QUERY: &[u8] = b"\x1b[6n";
const REPLY: &[u8] = b"\x1b[1;1R";

#[derive(Default)]
pub(crate) struct InitialCursorQuery {
    pending: Vec<u8>,
    done: bool,
}

impl InitialCursorQuery {
    /// Answers the first cursor query at the head of the stream and removes it from the UI output.
    /// Any later terminal queries pass through to the actual emulator.
    pub(crate) fn feed(
        &mut self,
        mut bytes: Vec<u8>,
        mut reply: impl FnMut(&[u8]) -> io::Result<()>,
    ) -> (Vec<u8>, io::Result<usize>) {
        if self.done {
            return (bytes, Ok(0));
        }
        if !self.pending.is_empty() {
            self.pending.append(&mut bytes);
            bytes = std::mem::take(&mut self.pending);
        }
        if bytes.len() < QUERY.len() && QUERY.starts_with(&bytes) {
            self.pending = bytes;
            return (Vec::new(), Ok(0));
        }
        self.done = true;
        if bytes.starts_with(QUERY) {
            match reply(REPLY) {
                Ok(()) => {
                    bytes.drain(..QUERY.len());
                    (bytes, Ok(QUERY.len()))
                }
                // If the native reply failed, forward the original query as a fallback.
                Err(error) => (bytes, Err(error)),
            }
        } else {
            (bytes, Ok(0))
        }
    }

    pub(crate) fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

pub(crate) fn write_reply(writer: &mut dyn Write, bytes: &[u8]) -> io::Result<()> {
    writer.write_all(bytes)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_query_is_answered_in_the_host_across_all_read_boundaries() {
        for split in 0..=QUERY.len() {
            let mut startup = InitialCursorQuery::default();
            let mut wire = Vec::new();
            let mut reply = |bytes: &[u8]| write_reply(&mut wire, bytes);
            let first = startup.feed(QUERY[..split].to_vec(), &mut reply);
            let second = startup.feed([&QUERY[split..], b"prompt"].concat(), &mut reply);
            assert_eq!([first.0, second.0].concat(), b"prompt");
            assert_eq!(first.1.unwrap() + second.1.unwrap(), QUERY.len());
            let later = startup.feed(QUERY.to_vec(), &mut reply);
            assert_eq!(later.0, QUERY);
            assert_eq!(later.1.unwrap(), 0);
            assert_eq!(wire, REPLY);
        }
    }

    #[test]
    fn nonmatching_output_and_failed_replies_are_forwarded() {
        let mut startup = InitialCursorQuery::default();
        let fail = |_: &[u8]| Err(io::Error::other("pipe failed"));
        let (bytes, replied) = startup.feed(QUERY.to_vec(), fail);
        assert_eq!(bytes, QUERY);
        assert!(replied.is_err());

        let mut startup = InitialCursorQuery::default();
        let (bytes, _) = startup.feed(b"\x1b[6".to_vec(), |_| panic!("not a complete query"));
        assert!(bytes.is_empty());
        assert_eq!(startup.finish(), b"\x1b[6");

        let mut startup = InitialCursorQuery::default();
        let output = b"prompt\x1b[6n";
        let (bytes, replied) = startup.feed(output.to_vec(), |_| panic!("forward application query"));
        assert_eq!(bytes, output);
        assert_eq!(replied.unwrap(), 0);
    }
}
