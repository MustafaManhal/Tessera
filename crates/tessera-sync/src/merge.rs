//! Merge rules (TRD 4.15): a whole document is last-writer-wins; a list document (agent profiles, projects) is a JSON
//! array of objects with an `"id"`, merged three ways against the last synced copy so both devices' edits survive.

use serde_json::Value;
use std::collections::BTreeMap;

/// How a document merges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Last writer wins.
    Whole,
    /// Three-way merge of an id-keyed list.
    List,
}

/// Merges `local` and `remote` given the last synced `base`. For [`Kind::Whole`] with both sides changed, the newer
/// side wins (`local_newer`). For [`Kind::List`]: an item added on either side stays; an item deleted on one side and
/// untouched on the other goes; an item changed on one side takes that change; changed on both, the newer side wins.
#[must_use]
pub fn merge(kind: Kind, base: Option<&Value>, local: &Value, remote: &Value, local_newer: bool) -> Value {
    if local == remote {
        return local.clone();
    }
    if base == Some(local) {
        return remote.clone();
    }
    if base == Some(remote) {
        return local.clone();
    }
    match kind {
        Kind::Whole => {
            if local_newer {
                local.clone()
            } else {
                remote.clone()
            }
        }
        Kind::List => merge_lists(base, local, remote, local_newer),
    }
}

fn index(value: Option<&Value>) -> (Vec<String>, BTreeMap<String, Value>) {
    let mut order = Vec::new();
    let mut map = BTreeMap::new();
    if let Some(Value::Array(items)) = value {
        for item in items {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                order.push(id.to_owned());
                map.insert(id.to_owned(), item.clone());
            }
        }
    }
    (order, map)
}

fn merge_lists(base: Option<&Value>, local: &Value, remote: &Value, local_newer: bool) -> Value {
    let (_, base_map) = index(base);
    let (local_order, local_map) = index(Some(local));
    let (remote_order, remote_map) = index(Some(remote));
    let mut ids: Vec<String> = local_order.clone();
    for id in &remote_order {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    let mut out = Vec::new();
    for id in ids {
        let (b, l, r) = (base_map.get(&id), local_map.get(&id), remote_map.get(&id));
        let kept = match (l, r) {
            (Some(l), Some(r)) if l == r => Some(l.clone()),
            (Some(l), Some(r)) => Some(match b {
                Some(b) if b == l => r.clone(),
                Some(b) if b == r => l.clone(),
                _ if local_newer => l.clone(),
                _ => r.clone(),
            }),
            // Only one side has it: added there, or deleted on the other side.
            (Some(only), None) | (None, Some(only)) => match b {
                None => Some(only.clone()),    // added on one side
                Some(b) if b == only => None,  // deleted on the other, untouched here
                Some(_) => Some(only.clone()), // deleted there but edited here: keep the edit
            },
            (None, None) => None,
        };
        if let Some(item) = kept {
            out.push(item);
        }
    }
    Value::Array(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn whole_documents_take_the_changed_side_or_the_newer_one() {
        let base = json!("a");
        assert_eq!(
            merge(Kind::Whole, Some(&base), &json!("a"), &json!("b"), true),
            json!("b")
        );
        assert_eq!(
            merge(Kind::Whole, Some(&base), &json!("c"), &json!("a"), false),
            json!("c")
        );
        assert_eq!(
            merge(Kind::Whole, Some(&base), &json!("c"), &json!("b"), true),
            json!("c")
        );
        assert_eq!(
            merge(Kind::Whole, Some(&base), &json!("c"), &json!("b"), false),
            json!("b")
        );
        assert_eq!(merge(Kind::Whole, None, &json!("c"), &json!("b"), false), json!("b"));
    }

    #[test]
    fn lists_keep_both_sides_adds_edits_and_deletes() {
        let base = json!([{"id": "a", "v": 1}, {"id": "b", "v": 1}, {"id": "c", "v": 1}]);
        let local = json!([{"id": "a", "v": 2}, {"id": "b", "v": 1}, {"id": "d", "v": 1}]); // edit a, delete c, add d
        let remote = json!([{"id": "a", "v": 1}, {"id": "c", "v": 1}, {"id": "e", "v": 1}]); // delete b, add e
        let merged = merge(Kind::List, Some(&base), &local, &remote, false);
        assert_eq!(
            merged,
            json!([{"id": "a", "v": 2}, {"id": "d", "v": 1}, {"id": "e", "v": 1}])
        );
    }

    #[test]
    fn an_edit_beats_a_delete_and_a_double_edit_goes_to_the_newer_side() {
        let base = json!([{"id": "a", "v": 1}]);
        assert_eq!(
            merge(
                Kind::List,
                Some(&base),
                &json!([{"id": "a", "v": 2}]),
                &json!([]),
                false
            ),
            json!([{"id": "a", "v": 2}])
        );
        assert_eq!(
            merge(
                Kind::List,
                Some(&base),
                &json!([{"id": "a", "v": 2}]),
                &json!([{"id": "a", "v": 3}]),
                true
            ),
            json!([{"id": "a", "v": 2}])
        );
        assert_eq!(
            merge(
                Kind::List,
                Some(&base),
                &json!([{"id": "a", "v": 2}]),
                &json!([{"id": "a", "v": 3}]),
                false
            ),
            json!([{"id": "a", "v": 3}])
        );
    }
}
