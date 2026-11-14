//! The prompt library (FR-43) and the prompt bar's history (S-23, FR-40): reusable named prompts with
//! variables/tags, and the last prompts sent, capped at 500 rows.
use crate::{Store, StoreError, repositories::new_id};
use rusqlite::{OptionalExtension, params};

/// `prompt_history` keeps the newest 500 rows (05-backend-schema).
pub const HISTORY_LIMIT: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    pub id: String,
    pub name: String,
    pub body: String,
    /// JSON array of variable names the body references.
    pub variables: String,
    /// JSON array of tags.
    pub tags: String,
    pub uses: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptHistoryEntry {
    pub id: String,
    pub text: String,
    /// JSON array of target ids (task or agent session ids, as the caller recorded them).
    pub targets: String,
    pub at: i64,
}

pub struct Prompts<'a>(&'a Store);

impl Store {
    pub fn prompts(&self) -> Prompts<'_> {
        Prompts(self)
    }
}

impl Prompts<'_> {
    fn read_prompt(row: &rusqlite::Row<'_>) -> rusqlite::Result<Prompt> {
        Ok(Prompt {
            id: row.get(0)?,
            name: row.get(1)?,
            body: row.get(2)?,
            variables: row.get(3)?,
            tags: row.get(4)?,
            uses: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    }

    fn read_history(row: &rusqlite::Row<'_>) -> rusqlite::Result<PromptHistoryEntry> {
        Ok(PromptHistoryEntry {
            id: row.get(0)?,
            text: row.get(1)?,
            targets: row.get(2)?,
            at: row.get(3)?,
        })
    }

    /// Newest use first would hide recently edited prompts; list is name order, `query` filters name/body/tags.
    pub fn list(&self, query: Option<&str>) -> Result<Vec<Prompt>, StoreError> {
        let mut stmt = self
            .0
            .conn
            .prepare("SELECT id,name,body,variables,tags,uses,created_at,updated_at FROM prompts ORDER BY name")?;
        let rows = stmt.query_map([], Self::read_prompt)?.collect::<Result<Vec<_>, _>>()?;
        let needle = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
        Ok(match needle {
            None => rows,
            Some(needle) => rows
                .into_iter()
                .filter(|p| {
                    format!("{} {} {}", p.name, p.body, p.tags)
                        .to_lowercase()
                        .contains(&needle)
                })
                .collect(),
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<Prompt>, StoreError> {
        Ok(self
            .0
            .conn
            .query_row(
                "SELECT id,name,body,variables,tags,uses,created_at,updated_at FROM prompts WHERE id=?1",
                [id],
                Self::read_prompt,
            )
            .optional()?)
    }

    /// Inserts a new prompt or updates the named fields of an existing one (`updated_at` always bumps).
    pub fn save(&self, prompt: &Prompt) -> Result<(), StoreError> {
        self.0.conn.execute(
            "INSERT INTO prompts(id,name,body,variables,tags,uses,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8) \
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body, \
             variables=excluded.variables,tags=excluded.tags,uses=excluded.uses,updated_at=excluded.updated_at",
            params![
                prompt.id,
                prompt.name,
                prompt.body,
                prompt.variables,
                prompt.tags,
                prompt.uses,
                prompt.created_at,
                prompt.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self.0.conn.execute("DELETE FROM prompts WHERE id=?1", [id])? > 0)
    }

    /// `uses += 1` after the prompt was sent; returns the new count.
    pub fn mark_used(&self, id: &str, at: i64) -> Result<Option<i64>, StoreError> {
        let changed = self.0.conn.execute(
            "UPDATE prompts SET uses=uses+1, updated_at=?2 WHERE id=?1",
            params![id, at],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(self
            .0
            .conn
            .query_row("SELECT uses FROM prompts WHERE id=?1", [id], |r| r.get(0))
            .optional()?)
    }

    pub fn history_list(&self, limit: usize) -> Result<Vec<PromptHistoryEntry>, StoreError> {
        let mut stmt = self
            .0
            .conn
            .prepare("SELECT id,text,targets,at FROM prompt_history ORDER BY at DESC, rowid DESC LIMIT ?1")?;
        Ok(stmt
            .query_map([limit as i64], Self::read_history)?
            .collect::<Result<_, _>>()?)
    }

    /// Adds a history row and prunes beyond the newest 500.
    pub fn history_add(&self, text: &str, targets: &str, at: i64) -> Result<PromptHistoryEntry, StoreError> {
        let entry = PromptHistoryEntry {
            id: new_id(),
            text: text.to_string(),
            targets: targets.to_string(),
            at,
        };
        self.0.conn.execute(
            "INSERT INTO prompt_history(id,text,targets,at) VALUES(?1,?2,?3,?4)",
            params![entry.id, entry.text, entry.targets, entry.at],
        )?;
        self.0.conn.execute(
            "DELETE FROM prompt_history WHERE id NOT IN \
             (SELECT id FROM prompt_history ORDER BY at DESC, rowid DESC LIMIT ?1)",
            [HISTORY_LIMIT as i64],
        )?;
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DataDirs, Store};

    fn fixture() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&DataDirs::from_root(tmp.path())).unwrap();
        (tmp, store)
    }

    fn prompt(id: &str, name: &str) -> Prompt {
        Prompt {
            id: id.into(),
            name: name.into(),
            body: format!("body of {name}"),
            variables: "[\"task\"]".into(),
            tags: "[\"git\"]".into(),
            uses: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn save_list_search_mark_used_and_delete() {
        let (_tmp, store) = fixture();
        let p = store.prompts();
        p.save(&prompt("p1", "Review")).unwrap();
        p.save(&prompt("p2", "Ship it")).unwrap();
        assert_eq!(p.list(None).unwrap().len(), 2);
        assert_eq!(p.list(Some("ship")).unwrap()[0].id, "p2");
        assert_eq!(p.list(Some("git")).unwrap().len(), 2); // tags match
        assert_eq!(p.mark_used("p1", 2).unwrap(), Some(1));
        assert_eq!(p.get("p1").unwrap().unwrap().uses, 1);
        // Save again keeps uses and bumps updated_at.
        let mut again = prompt("p1", "Review v2");
        again.uses = 1;
        again.updated_at = 9;
        p.save(&again).unwrap();
        assert_eq!(p.get("p1").unwrap().unwrap().name, "Review v2");
        assert!(p.delete("p1").unwrap());
        assert!(!p.delete("p1").unwrap());
    }

    #[test]
    fn history_keeps_only_the_newest_500() {
        let (_tmp, store) = fixture();
        let p = store.prompts();
        for i in 0..(HISTORY_LIMIT + 5) {
            p.history_add(&format!("prompt {i}"), "[]", i as i64).unwrap();
        }
        let list = p.history_list(600).unwrap();
        assert_eq!(list.len(), HISTORY_LIMIT);
        assert_eq!(list[0].text, format!("prompt {}", HISTORY_LIMIT + 4)); // newest first
        assert_eq!(list.last().unwrap().text, "prompt 5");
    }

    #[test]
    fn previous_schema_fixture_migrates() {
        use crate::db::MIGRATION_LIST;
        use rusqlite_migration::Migrations;
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path());
        {
            // Every migration before prompts (0012, the 11th in the list).
            let old = Migrations::from_slice(&MIGRATION_LIST[..10]);
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            assert_eq!(store.schema_version().unwrap(), 10);
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), crate::db::SCHEMA_VERSION);
        store.prompts().save(&prompt("p1", "x")).unwrap();
        assert_eq!(store.prompts().list(None).unwrap().len(), 1);
    }
}
