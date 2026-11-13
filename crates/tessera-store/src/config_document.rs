//! Source locations from TOML's parser, also used for surgical settings edits.

use crate::ConfigError;
use toml::{
    Spanned,
    de::{DeTable, DeValue},
};

pub(crate) struct Document<'a> {
    pub text: &'a str,
    pub root: Spanned<DeTable<'a>>,
}

impl<'a> Document<'a> {
    pub fn parse(text: &'a str) -> Result<Self, ConfigError> {
        let root = DeTable::parse(text).map_err(|error| ConfigError::Syntax {
            key: key_at(
                DeTable::parse_recoverable(text).0.get_ref(),
                text,
                error.span().map_or(0, |span| span.start),
            ),
            line: line_at(text, error.span().map_or(0, |span| span.start)),
            message: error.message().into(),
        })?;
        Ok(Self { text, root })
    }

    pub fn value(&self, key: &[&str]) -> Option<&Spanned<DeValue<'a>>> {
        let (first, rest) = key.split_first()?;
        let mut value = self.root.get_ref().get(*first)?;
        for key in rest {
            value = value.get_ref().as_table()?.get(*key)?;
        }
        Some(value)
    }

    pub fn line(&self, key: &[&str]) -> usize {
        line_at(self.text, self.value(key).map_or(0, |value| value.span().start))
    }

    pub fn invalid(&self, key: &[&str], message: impl Into<String>) -> ConfigError {
        ConfigError::Invalid {
            key: key.join("."),
            line: self.line(key),
            message: message.into(),
        }
    }

    pub fn syntax_error(&self, error: toml::de::Error) -> ConfigError {
        ConfigError::Syntax {
            key: key_at(
                self.root.get_ref(),
                self.text,
                error.span().map_or(0, |span| span.start),
            ),
            line: line_at(self.text, error.span().map_or(0, |s| s.start)),
            message: error.message().into(),
        }
    }
}

fn line_at(text: &str, byte: usize) -> usize {
    text.as_bytes()[..byte.min(text.len())]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

// Recoverable parsing supplies real key/value spans even for many broken value edits.
fn key_at(table: &DeTable<'_>, text: &str, offset: usize) -> Option<String> {
    for (key, value) in table {
        if let Some(table) = value.get_ref().as_table() {
            if let Some(child) = key_at(table, text, offset) {
                return Some(format!("{}.{}", key.get_ref(), child));
            }
        } else if value.span().contains(&offset) || line_at(text, key.span().start) == line_at(text, offset) {
            return Some(key.get_ref().to_string());
        }
    }
    None
}
