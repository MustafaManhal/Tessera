use super::*;
use std::ops::Range;
use toml::{
    Spanned,
    de::{DeTable, DeValue},
};
fn document(text: &str) -> Result<Spanned<DeTable<'_>>, HookError> {
    DeTable::parse(text).map_err(|e| HookError::Unparseable {
        line: text[..e.span().map_or(0, |s| s.start)]
            .bytes()
            .filter(|b| *b == b'\n')
            .count()
            + 1,
        message: e.message().into(),
    })
}
fn scalar_ranges(value: &Spanned<DeValue<'_>>, out: &mut Vec<Range<usize>>) {
    if let Some(t) = value.get_ref().as_table() {
        for (_, v) in t {
            scalar_ranges(v, out)
        }
    } else {
        out.push(value.span());
    }
}
fn block(text: &str, root: &DeTable<'_>) -> Result<Option<Range<usize>>, HookError> {
    let mut ranges = Vec::new();
    for (_, v) in root {
        scalar_ranges(v, &mut ranges)
    }
    let (mut start, mut end) = (None, None);
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        if !ranges.iter().any(|r| r.contains(&offset)) {
            if content == START {
                if start.is_some() {
                    return Err(HookError::Conflict("multiple managed blocks".into()));
                }
                start = Some(offset);
            }
            if content == END {
                if end.is_some() {
                    return Err(HookError::Conflict("multiple managed blocks".into()));
                }
                end = Some(offset + line.len());
            }
        }
        offset += line.len();
    }
    match (start, end) {
        (None, None) => Ok(None),
        (Some(a), Some(b)) if a < b => Ok(Some(a..b)),
        _ => Err(HookError::Conflict("an incomplete managed block".into())),
    }
}
fn expected(cli: &str) -> toml::Value {
    toml::Value::Array(vec![cli.into(), "hook".into(), "agent-turn-complete".into()])
}
pub(super) fn inspect(text: &str, cli: &str) -> Result<State, HookError> {
    let root = document(text)?;
    let managed = block(text, root.get_ref())?;
    let value: toml::Value = toml::from_str(text).map_err(|e| HookError::Unparseable {
        line: 1,
        message: e.to_string(),
    })?;
    match (value.get("notify"), managed) {
        (None, None) => Ok(State::None),
        (Some(current), Some(range))
            if root
                .get_ref()
                .get("notify")
                .is_some_and(|v| range.start <= v.span().start && v.span().end <= range.end) =>
        {
            Ok(if current == &expected(cli) {
                State::Installed
            } else {
                State::Outdated
            })
        }
        (Some(current), _) => Err(HookError::Conflict(current.to_string())),
        (None, Some(_)) => Err(HookError::Conflict("a managed block without a notify program".into())),
    }
}
pub(super) fn change(text: &str, cli: &str, action: Action) -> Result<String, HookError> {
    let state = inspect(text, cli)?;
    let root = document(text)?;
    let range = block(text, root.get_ref())?;
    if matches!(action, Action::Install) {
        if state == State::Installed {
            return Ok(text.into());
        }
        let value =
            toml::to_string(&toml::Table::from_iter([("notify".into(), expected(cli))])).expect("string array TOML");
        if range.is_some() {
            let span = root.get_ref().get("notify").unwrap().span();
            let mut result = text.to_string();
            let encoded = value.trim().strip_prefix("notify = ").unwrap();
            result.replace_range(span, encoded);
            document(&result)?;
            return Ok(result);
        }
        let result = format!("{START}\n{value}{END}\n{text}");
        document(&result)?;
        return Ok(result);
    }
    let Some(range) = range else {
        return Ok(text.into());
    };
    let key = root.get_ref().iter().find(|(k, _)| k.get_ref() == "notify").unwrap();
    let assignment = key.0.span().start..key.1.span().end;
    // Remove only marker lines and the owned assignment, preserving any user comments inserted in the block.
    let mut edits = Vec::new();
    let mut offset = range.start;
    for line in text[range.clone()].split_inclusive('\n') {
        let end = offset + line.len();
        let clean = line.trim_end_matches(['\r', '\n']);
        if clean == START || clean == END {
            edits.push(offset..end);
        } else if offset <= assignment.start && assignment.end <= end {
            if text[offset..assignment.start].trim().is_empty() && text[assignment.end..end].trim().is_empty() {
                edits.push(offset..end);
            } else {
                edits.push(assignment.clone());
            }
        }
        offset = end;
    }
    // Multiline notify values span several lines: remove the assignment as one range, plus marker lines.
    if !edits
        .iter()
        .any(|r| r.start <= assignment.start && assignment.end <= r.end)
    {
        edits.retain(|r| r.end <= assignment.start || r.start >= assignment.end);
        edits.push(assignment);
    }
    edits.sort_by_key(|r| std::cmp::Reverse(r.start));
    let mut result = text.to_string();
    for range in edits {
        result.replace_range(range, "");
    }
    document(&result)?;
    Ok(result)
}
