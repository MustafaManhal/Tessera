//! Bounded streaming parser for semantic prompt marks and file-URL working directories.

/// A semantic shell marker, independent of terminal rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEvent {
    /// OSC 133 A: prompt rendering starts.
    PromptStart,
    /// OSC 133 B: prompt ends and editable command input begins.
    PromptEnd,
    /// OSC 133 C: command output starts.
    CommandStart,
    /// OSC 133 D: command completed.
    CommandEnd {
        /// Shell exit status, including negative native PowerShell exit codes.
        exit: i32,
    },
    /// OSC 7: percent-decoded absolute file path (URL host is not part of the path).
    Cwd {
        /// UTF-8 filesystem path; Windows drive paths retain their leading slash.
        path: String,
    },
}

#[derive(Debug, Clone, Copy, Default)]
enum State {
    #[default]
    Ground,
    Escape,
    Osc,
    OscEscape,
    Discard,
    DiscardEscape,
}

/// Incremental parser; accepts arbitrary chunk boundaries and ignores unrelated terminal bytes.
/// OSC payloads larger than 16 KiB are discarded until their terminator.
#[derive(Debug, Default)]
pub struct ShellParser {
    state: State,
    payload: Vec<u8>,
}

impl ShellParser {
    /// Consumes bytes, returning completed events in order. Handles BEL and ESC-backslash ST.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ShellEvent> {
        let mut events = Vec::new();
        for &byte in bytes {
            self.state = match (self.state, byte) {
                (State::Ground, 0x1b) => State::Escape,
                (State::Escape, b']') => {
                    self.payload.clear();
                    State::Osc
                }
                (State::Escape, 0x1b) => State::Escape,
                (State::Osc, 0x07) | (State::OscEscape, b'\\') => {
                    if let Some(event) = parse_payload(&self.payload) {
                        events.push(event);
                    }
                    self.payload.clear();
                    State::Ground
                }
                (State::Osc, 0x1b) => State::OscEscape,
                (State::Osc, 0x18 | 0x1a) => {
                    self.payload.clear();
                    State::Ground
                }
                (State::Osc, _) if self.payload.len() < 16 * 1024 => {
                    self.payload.push(byte);
                    State::Osc
                }
                (State::Osc, _) => {
                    self.payload.clear();
                    State::Discard
                }
                // A malformed OSC can be interrupted by the next OSC introducer.
                (State::OscEscape, b']') => {
                    self.payload.clear();
                    State::Osc
                }
                (State::OscEscape, 0x1b) => {
                    self.payload.clear();
                    State::Escape
                }
                (State::Discard, 0x07 | 0x18 | 0x1a) | (State::DiscardEscape, b'\\') => State::Ground,
                (State::Discard, 0x1b) => State::DiscardEscape,
                (State::Discard, _) | (State::DiscardEscape, _) => State::Discard,
                _ => State::Ground,
            };
        }
        events
    }
}

fn parse_payload(payload: &[u8]) -> Option<ShellEvent> {
    let text = std::str::from_utf8(payload).ok()?;
    if let Some(mark) = text.strip_prefix("133;") {
        let mut parts = mark.split(';');
        return match parts.next()? {
            "A" => Some(ShellEvent::PromptStart),
            "B" => Some(ShellEvent::PromptEnd),
            "C" => Some(ShellEvent::CommandStart),
            "D" => Some(ShellEvent::CommandEnd {
                exit: parts.next()?.parse().ok()?,
            }),
            _ => None,
        };
    }
    let url = text.strip_prefix("7;file://")?;
    let (host, path) = url.split_once('/')?;
    if host
        .chars()
        .any(|c| c.is_control() || matches!(c, '@' | '?' | '#' | '\\' | '%'))
    {
        return None;
    }
    let path = format!("/{path}");
    if path.contains(['?', '#', '\\']) {
        return None;
    }
    let mut decoded = Vec::with_capacity(path.len());
    let mut bytes = path.bytes();
    while let Some(byte) = bytes.next() {
        let byte = if byte == b'%' {
            (hex(bytes.next()?)? << 4) | hex(bytes.next()?)?
        } else {
            byte
        };
        if byte == 0 || byte < 0x20 || byte == 0x7f {
            return None;
        }
        decoded.push(byte);
    }
    Some(ShellEvent::Cwd {
        path: String::from_utf8(decoded).ok()?,
    })
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
