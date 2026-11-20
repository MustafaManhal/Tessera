//! The S-16 inbox: attention events (agent needs input, a command finished, ...) kept for 14 days.
//! Rows are written by the desktop when an attention signal fires; reads power the "Needs you" popover.
use crate::{Store, StoreError, repositories::new_id};
use rusqlite::params;

/// How long a notification stays in the inbox (schema doc: prune after 14 days).
pub const RETENTION_SECONDS: i64 = 14 * 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub id: String,
    /// `agent`, `command`, `ci`, `automation`, `update` (schema doc §3).
    pub source: String,
    pub task_id: Option<String>,
    pub pane_session_id: Option<String>,
    pub title: String,
    pub body: String,
    pub is_read: bool,
    /// Unix seconds.
    pub at: i64,
}

pub struct Notifications<'a>(&'a Store);

impl Store {
    pub fn notifications(&self) -> Notifications<'_> {
        Notifications(self)
    }
}

const SELECT: &str = "SELECT id,source,task_id,pane_session_id,title,body,is_read,at FROM notifications";

impl Notifications<'_> {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Notification> {
        Ok(Notification {
            id: row.get(0)?,
            source: row.get(1)?,
            task_id: row.get(2)?,
            pane_session_id: row.get(3)?,
            title: row.get(4)?,
            body: row.get(5)?,
            is_read: row.get::<_, i64>(6)? != 0,
            at: row.get(7)?,
        })
    }

    /// Records an attention event. `at` is Unix seconds (callers pass `now_seconds`).
    pub fn insert(&self, notification: &Notification) -> Result<(), StoreError> {
        self.0.conn.execute(
            "INSERT INTO notifications (id,source,task_id,pane_session_id,title,body,is_read,at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                notification.id,
                notification.source,
                notification.task_id,
                notification.pane_session_id,
                notification.title,
                notification.body,
                notification.is_read as i64,
                notification.at
            ],
        )?;
        Ok(())
    }

    /// A fresh row with a generated id, for callers that only know the content.
    pub fn record(
        &self,
        source: &str,
        task_id: Option<&str>,
        pane_session_id: Option<&str>,
        title: &str,
        body: &str,
        at: i64,
    ) -> Result<Notification, StoreError> {
        let notification = Notification {
            id: new_id(),
            source: source.to_string(),
            task_id: task_id.map(str::to_string),
            pane_session_id: pane_session_id.map(str::to_string),
            title: title.to_string(),
            body: body.to_string(),
            is_read: false,
            at,
        };
        self.insert(&notification)?;
        Ok(notification)
    }

    /// Newest first; unread rows sort ahead of read ones at the same time is not needed — `at` orders.
    pub fn list(&self, limit: usize) -> Result<Vec<Notification>, StoreError> {
        let mut stmt = self
            .0
            .conn
            .prepare(&format!("{SELECT} ORDER BY is_read, at DESC LIMIT ?1"))?;
        Ok(stmt.query_map([limit as i64], Self::read)?.collect::<Result<_, _>>()?)
    }

    pub fn unread_count(&self) -> Result<i64, StoreError> {
        Ok(self
            .0
            .conn
            .query_row("SELECT COUNT(*) FROM notifications WHERE is_read=0", [], |row| {
                row.get(0)
            })?)
    }

    /// `ids` marks those rows; `None` marks everything. Returns how many rows changed.
    pub fn mark_read(&self, ids: Option<&[String]>) -> Result<usize, StoreError> {
        let changed = match ids {
            Some(ids) if !ids.is_empty() => {
                let marks = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let sql = format!("UPDATE notifications SET is_read=1 WHERE is_read=0 AND id IN ({marks})");
                self.0.conn.execute(&sql, rusqlite::params_from_iter(ids.iter()))?
            }
            Some(_) => 0,
            None => self
                .0
                .conn
                .execute("UPDATE notifications SET is_read=1 WHERE is_read=0", [])?,
        };
        Ok(changed)
    }

    pub fn clear(&self) -> Result<usize, StoreError> {
        Ok(self.0.conn.execute("DELETE FROM notifications", [])?)
    }

    /// Drops rows older than the retention window; called at startup.
    pub fn prune(&self, now: i64) -> Result<usize, StoreError> {
        Ok(self
            .0
            .conn
            .execute("DELETE FROM notifications WHERE at < ?1", [now - RETENTION_SECONDS])?)
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

    #[test]
    fn record_list_mark_and_clear() {
        let (_tmp, store) = fixture();
        let n = store.notifications();
        n.record("agent", Some("task-1"), Some("pty-1"), "Claude", "needs approval", 1000)
            .unwrap();
        n.record("command", None, None, "npm test", "finished in 2s", 2000)
            .unwrap();
        let list = n.list(10).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title, "npm test"); // newest first
        assert!(!list[0].is_read);
        // Mark one read: it sorts behind the unread row.
        n.mark_read(Some(&[list[0].id.clone()])).unwrap();
        let list = n.list(10).unwrap();
        assert_eq!(list[0].title, "Claude");
        assert_eq!(n.unread_count().unwrap(), 1);
        // Null marks everything; clear empties.
        n.mark_read(None).unwrap();
        assert_eq!(n.unread_count().unwrap(), 0);
        assert_eq!(n.clear().unwrap(), 2);
        assert!(n.list(10).unwrap().is_empty());
    }

    #[test]
    fn version_eight_fixture_migrates_and_keeps_rows() {
        use crate::db::MIGRATION_LIST;
        use rusqlite_migration::Migrations;
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path());
        // Open at schema 8 (before the notifications table existed), then migrate to the latest.
        {
            let old = Migrations::from_slice(&MIGRATION_LIST[..8]);
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            assert_eq!(store.schema_version().unwrap(), 8);
            store.kv_set("fixture", "preserved").unwrap();
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), crate::db::SCHEMA_VERSION);
        assert_eq!(store.kv_get("fixture").unwrap().as_deref(), Some("preserved"));
        store
            .notifications()
            .record("agent", None, None, "t", "b", 1000)
            .unwrap();
        assert_eq!(store.notifications().list(10).unwrap().len(), 1);
    }

    #[test]
    fn prune_drops_rows_older_than_fourteen_days() {
        let (_tmp, store) = fixture();
        let n = store.notifications();
        let now = 1_000_000i64;
        n.record("agent", None, None, "old", "x", now - RETENTION_SECONDS - 1)
            .unwrap();
        n.record("agent", None, None, "new", "x", now - RETENTION_SECONDS + 1)
            .unwrap();
        assert_eq!(n.prune(now).unwrap(), 1);
        let list = n.list(10).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "new");
    }
}
