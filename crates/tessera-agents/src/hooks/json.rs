use super::*;
use serde_json::{Value, json};
use std::ops::Range;
#[derive(Debug)]
struct Node {
    span: Range<usize>,
    members: Vec<(String, Range<usize>, Node)>,
    elements: Vec<Node>,
}
fn parse(text: &str) -> Result<Node, HookError> {
    let value: Value = serde_json::from_str(text).map_err(|e| HookError::Unparseable {
        line: e.line(),
        message: e.to_string(),
    })?;
    if !value.is_object() {
        return Err(HookError::Unparseable {
            line: 1,
            message: "The settings root must be an object".into(),
        });
    }
    let mut p = Parser {
        b: text.as_bytes(),
        pos: 0,
    };
    let root = p.node();
    fn unique(node: &Node) -> bool {
        let mut keys = std::collections::BTreeSet::new();
        node.members
            .iter()
            .all(|(key, _, value)| keys.insert(key) && unique(value))
            && node.elements.iter().all(unique)
    }
    if !unique(&root) {
        return Err(HookError::Unparseable {
            line: 1,
            message: "Duplicate JSON keys cannot be edited safely".into(),
        });
    }
    Ok(root)
}
struct Parser<'a> {
    b: &'a [u8],
    pos: usize,
}
impl Parser<'_> {
    fn ws(&mut self) {
        while self.pos < self.b.len() && self.b[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }
    fn string(&mut self) -> Range<usize> {
        let start = self.pos;
        self.pos += 1;
        while self.pos < self.b.len() {
            match self.b[self.pos] {
                b'\\' => self.pos += 2,
                b'"' => {
                    self.pos += 1;
                    break;
                }
                _ => self.pos += 1,
            }
        }
        start..self.pos
    }
    fn node(&mut self) -> Node {
        self.ws();
        let start = self.pos;
        let mut members = Vec::new();
        let mut elements = Vec::new();
        match self.b[self.pos] {
            b'{' => {
                self.pos += 1;
                self.ws();
                while self.b[self.pos] != b'}' {
                    let key_span = self.string();
                    let key = serde_json::from_slice(&self.b[key_span.clone()]).expect("validated key");
                    self.ws();
                    self.pos += 1;
                    let value = self.node();
                    members.push((key, key_span, value));
                    self.ws();
                    if self.b[self.pos] != b',' {
                        break;
                    }
                    self.pos += 1;
                    self.ws();
                }
                self.pos += 1;
            }
            b'[' => {
                self.pos += 1;
                self.ws();
                while self.b[self.pos] != b']' {
                    elements.push(self.node());
                    self.ws();
                    if self.b[self.pos] != b',' {
                        break;
                    }
                    self.pos += 1;
                    self.ws();
                }
                self.pos += 1;
            }
            b'"' => {
                self.string();
            }
            _ => {
                while self.pos < self.b.len() && !b",]} \t\r\n".contains(&self.b[self.pos]) {
                    self.pos += 1;
                }
            }
        }
        Node {
            span: start..self.pos,
            members,
            elements,
        }
    }
}
impl Node {
    fn member(&self, key: &str) -> Option<&Node> {
        self.members.iter().find(|m| m.0 == key).map(|m| &m.2)
    }
    fn value(&self, text: &str) -> Value {
        serde_json::from_str(&text[self.span.clone()]).expect("validated subtree")
    }
    fn object(&self, text: &str) -> bool {
        text.as_bytes()[self.span.start] == b'{'
    }
    fn array(&self, text: &str) -> bool {
        text.as_bytes()[self.span.start] == b'['
    }
}
fn expected(kind: Kind, cli: &str, event: &str) -> Value {
    let mut hook = json!({"type":"command","command":command(cli,event),"_tessera":true});
    if kind == Kind::Claude && windows_path(cli) {
        hook["shell"] = "powershell".into();
    }
    if kind == Kind::Gemini {
        hook["name"] = format!("tessera-{event}").into();
    }
    json!({"_tessera":true,"hooks":[hook]})
}
fn owned(node: &Node, text: &str) -> bool {
    node.member("_tessera").is_some_and(|n| n.value(text) == true)
}
fn hooks<'a>(root: &'a Node, text: &str) -> Result<Option<&'a Node>, HookError> {
    let node = root.member("hooks");
    if node.is_some_and(|n| !n.object(text)) {
        return Err(HookError::Unparseable {
            line: 1,
            message: "The hooks setting must be an object".into(),
        });
    }
    if let Some(node) = node {
        for (_, _, event) in &node.members {
            if !event.array(text) {
                return Err(HookError::Unparseable {
                    line: 1,
                    message: "Hook events must contain arrays".into(),
                });
            }
        }
    }
    Ok(node)
}
pub(super) fn inspect(kind: Kind, text: &str, cli: &str) -> Result<State, HookError> {
    let root = parse(text)?;
    let Some(hooks) = hooks(&root, text)? else {
        return Ok(State::None);
    };
    let mut any = false;
    let mut count = 0;
    let mut exact = true;
    let mut found = std::collections::BTreeSet::new();
    for (event, _, array) in &hooks.members {
        for group in &array.elements {
            if owned(group, text)
                || group
                    .member("hooks")
                    .is_some_and(|h| h.elements.iter().any(|n| owned(n, text)))
            {
                any = true;
                count += 1;
                found.insert(event.as_str());
                if !kind.events().contains(&event.as_str()) || group.value(text) != expected(kind, cli, event) {
                    exact = false;
                }
            }
        }
    }
    Ok(if !any {
        State::None
    } else if exact && count == kind.events().len() && found == kind.events().iter().copied().collect() {
        State::Installed
    } else {
        State::Outdated
    })
}
struct Edit {
    range: Range<usize>,
    text: String,
}
fn apply(text: &str, mut edits: Vec<Edit>) -> String {
    edits.sort_by_key(|e| std::cmp::Reverse(e.range.start));
    let mut text = text.to_string();
    for e in edits {
        text.replace_range(e.range, &e.text);
    }
    text
}
fn add(node: &Node, text: &str, key: Option<&str>, value: &str) -> Edit {
    let last = if key.is_some() {
        node.members.last().map(|m| m.2.span.end)
    } else {
        node.elements.last().map(|n| n.span.end)
    };
    let pos = last.unwrap_or(node.span.start + 1);
    let comma = if last.is_some() { "," } else { "" };
    let member = key
        .map(|k| format!("{}:", serde_json::to_string(k).unwrap()))
        .unwrap_or_default();
    let _ = text;
    Edit {
        range: pos..pos,
        text: format!("{comma}{member}{value}"),
    }
}
fn delete(text: &str, node: &Node, index: usize, object: bool) -> Vec<Edit> {
    let spans: Vec<_> = if object {
        node.members.iter().map(|(_, k, v)| k.start..v.span.end).collect()
    } else {
        node.elements.iter().map(|n| n.span.clone()).collect()
    };
    let mut edits = vec![Edit {
        range: spans[index].clone(),
        text: String::new(),
    }];
    let separator = if index > 0 {
        Some(spans[index - 1].end..spans[index].start)
    } else if spans.len() > 1 {
        Some(spans[index].end..spans[index + 1].start)
    } else {
        None
    };
    if let Some(span) = separator
        && let Some(offset) = text.as_bytes()[span.clone()].iter().position(|b| *b == b',')
    {
        edits.push(Edit {
            range: span.start + offset..span.start + offset + 1,
            text: String::new(),
        });
    }
    edits
}
/// Remove one tagged group per pass, reparsing spans so adjacent deletions cannot consume user commas/whitespace.
fn strip(text: &str) -> Result<(String, bool), HookError> {
    let mut result = text.to_string();
    let mut changed = false;
    loop {
        let root = parse(&result)?;
        let Some(hooks) = hooks(&root, &result)? else { break };
        let mut edit = None;
        'outer: for (_, _, array) in &hooks.members {
            for (i, group) in array.elements.iter().enumerate() {
                if !owned(group, &result) {
                    if let Some(inner) = group.member("hooks")
                        && let Some(j) = inner.elements.iter().position(|n| owned(n, &result))
                    {
                        edit = Some(delete(&result, inner, j, false));
                        break 'outer;
                    }
                    continue;
                }
                let own_only = group
                    .members
                    .iter()
                    .all(|m| matches!(m.0.as_str(), "_tessera" | "hooks"))
                    && group
                        .member("hooks")
                        .is_some_and(|h| h.elements.iter().all(|n| owned(n, &result)));
                if own_only {
                    edit = Some(delete(&result, array, i, false));
                    break 'outer;
                }
                if let Some(inner) = group.member("hooks")
                    && let Some(j) = inner.elements.iter().position(|n| owned(n, &result))
                {
                    edit = Some(delete(&result, inner, j, false));
                    break 'outer;
                }
                // Only the marker field is ours when the group now contains user material.
                if let Some(j) = group.members.iter().position(|m| m.0 == "_tessera") {
                    edit = Some(delete(&result, group, j, true));
                    break 'outer;
                }
            }
        }
        let Some(edits) = edit else { break };
        result = apply(&result, edits);
        changed = true;
    }
    Ok((result, changed))
}
fn cleanup(mut text: String, ownership: &Ownership) -> Result<String, HookError> {
    for event in &ownership.created_events {
        let root = parse(&text)?;
        if let Some(hooks) = hooks(&root, &text)?
            && let Some(i) = hooks
                .members
                .iter()
                .position(|m| &m.0 == event && m.2.array(&text) && m.2.elements.is_empty())
        {
            text = apply(&text, delete(&text, hooks, i, true));
        }
    }
    if ownership.created_hooks {
        let root = parse(&text)?;
        if let Some(i) = root
            .members
            .iter()
            .position(|m| m.0 == "hooks" && m.2.object(&text) && m.2.members.is_empty())
        {
            text = apply(&text, delete(&text, &root, i, true));
        }
    }
    Ok(text)
}
pub(super) fn change(
    kind: Kind,
    text: &str,
    cli: &str,
    action: Action,
    ownership: &Ownership,
) -> Result<(String, Ownership), HookError> {
    let mut ownership = ownership.clone();
    if matches!(action, Action::Install) && inspect(kind, text, cli)? == State::Installed {
        return Ok((text.into(), ownership));
    }
    let (mut result, stripped) = strip(text)?;
    if stripped {
        result = cleanup(result, &ownership)?;
    }
    if matches!(action, Action::Remove) {
        return Ok((result, ownership));
    }
    for event in kind.events() {
        let root = parse(&result)?;
        let value = expected(kind, cli, event).to_string();
        let edit = if let Some(hooks) = hooks(&root, &result)? {
            if let Some(array) = hooks.member(event) {
                add(array, &result, None, &value)
            } else {
                ownership.created_events.insert((*event).into());
                add(hooks, &result, Some(event), &format!("[{value}]"))
            }
        } else {
            ownership.created_hooks = true;
            ownership.created_events.insert((*event).into());
            add(
                &root,
                &result,
                Some("hooks"),
                &format!("{{{}:[{value}]}}", serde_json::to_string(event).unwrap()),
            )
        };
        result = apply(&result, vec![edit]);
    }
    parse(&result)?;
    Ok((result, ownership))
}
