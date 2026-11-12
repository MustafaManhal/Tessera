//! Atomic, size-bounded restore records. Layout text is kept verbatim.

use crate::{Store, StoreError};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// Maximum UTF-8 layout size.
pub const LAYOUT_LIMIT: usize = 1024 * 1024;
/// Maximum UTF-8 size of the independently stored window geometry.
pub const BOUNDS_LIMIT: usize = 4096;
/// Maximum compressed history size for one pane.
pub const PANE_LIMIT: usize = 8 * 1024 * 1024;
/// Maximum aggregate compressed history size.
pub const TOTAL_LIMIT: usize = 64 * 1024 * 1024;
/// Maximum decoded history; protects against corrupt or hostile compression frames.
pub const DECODE_LIMIT: usize = 16 * 1024 * 1024;

/// A versioned opaque layout, with independently stored window geometry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedLayout {
    /// Stable native window label.
    pub window_id: String,
    /// Original JSON text, never rewritten by the store.
    pub state: String,
    /// Version from the JSON, defaulting to one for older layouts.
    pub version: i64,
    /// Optional JSON window geometry.
    pub bounds: Option<String>,
    /// Unix milliseconds of the last save.
    pub updated_at: i64,
}

/// Restart metadata for a terminal. The id is the host session id used by layout leaves.
#[derive(Debug, Clone)]
pub struct PaneSession {
    /// Host session identifier.
    pub id: String,
    /// Owning native window label.
    pub window_id: String,
    /// Last known working directory.
    pub cwd: String,
    /// Shell executable.
    pub shell: String,
    /// Terminal width in cells.
    pub cols: u16,
    /// Terminal height in cells.
    pub rows: u16,
}

impl Store {
    /// Validates and atomically upserts opaque layout JSON (maximum 1 MiB).
    pub fn layout_save(&self, window_id: &str, json: &str) -> Result<(), StoreError> {
        self.layout_save_with_bounds(window_id, json, None)
    }

    /// Saves the layout and optional JSON geometry in a single statement.
    pub fn layout_save_with_bounds(&self, window_id: &str, json: &str, bounds: Option<&str>) -> Result<(), StoreError> {
        if json.len() > LAYOUT_LIMIT || bounds.is_some_and(|b| b.len() > BOUNDS_LIMIT) {
            return Err(StoreError::RestoreTooLarge);
        }
        for text in std::iter::once(json).chain(bounds) {
            if !self.valid_json(text)? {
                return Err(StoreError::RestoreInvalidJson);
            }
        }
        self.conn.execute(
            "INSERT INTO layouts(window_id,state,version,bounds,updated_at)
             VALUES (?1,?2,COALESCE(CAST(json_extract(?2,'$.version') AS INTEGER),1),?3,?4)
             ON CONFLICT(window_id) DO UPDATE SET state=excluded.state,version=excluded.version,
             bounds=COALESCE(excluded.bounds,layouts.bounds),updated_at=excluded.updated_at",
            params![window_id, json, bounds, now()],
        )?;
        Ok(())
    }

    /// Loads a window, or `None` when it has never been saved.
    pub fn layout_load(&self, window_id: &str) -> Result<Option<SavedLayout>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT window_id,state,version,bounds,updated_at FROM layouts WHERE window_id=?1",
                [window_id],
                layout_row,
            )
            .optional()?)
    }

    /// Lists saved windows in a stable order.
    pub fn layout_list(&self) -> Result<Vec<SavedLayout>, StoreError> {
        Ok(self
            .conn
            .prepare("SELECT window_id,state,version,bounds,updated_at FROM layouts ORDER BY window_id")?
            .query_map([], layout_row)?
            .collect::<Result<_, _>>()?)
    }

    /// Removes a saved window. Host-owned sessions are deliberately preserved for tab transfers.
    pub fn layout_delete(&self, window_id: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM layouts WHERE window_id=?1", [window_id])?;
        Ok(())
    }

    /// Updates native geometry without touching the opaque layout.
    ///
    /// Creates the row with an empty layout object when the frontend has not saved one yet, so the main window's
    /// position survives a restart even if the app quits before its first layout save.
    pub fn layout_bounds_upsert(&self, window_id: &str, bounds: &str) -> Result<(), StoreError> {
        if bounds.len() > BOUNDS_LIMIT {
            return Err(StoreError::RestoreTooLarge);
        }
        if !self.valid_json(bounds)? {
            return Err(StoreError::RestoreInvalidJson);
        }
        self.conn.execute(
            "INSERT INTO layouts(window_id,state,version,bounds,updated_at) VALUES (?1,'{}',1,?2,?3)
             ON CONFLICT(window_id) DO UPDATE SET bounds=excluded.bounds",
            params![window_id, bounds, now()],
        )?;
        Ok(())
    }

    /// Upserts metadata while preserving an existing history snapshot.
    pub fn pane_session_save(&self, pane: &PaneSession) -> Result<(), StoreError> {
        self.conn.execute("INSERT INTO pane_sessions(id,window_id,cwd,shell,cols,rows,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
            ON CONFLICT(id) DO UPDATE SET window_id=excluded.window_id,cwd=excluded.cwd,shell=excluded.shell,cols=excluded.cols,rows=excluded.rows",
            params![pane.id,pane.window_id,pane.cwd,pane.shell,pane.cols,pane.rows,now()])?;
        Ok(())
    }

    /// Refreshes cwd and window ownership from a saved layout, preserving shell and history.
    pub fn pane_session_location(&self, id: &str, window_id: &str, cwd: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE pane_sessions SET window_id=?2,cwd=?3 WHERE id=?1",
            params![id, window_id, cwd],
        )?;
        Ok(())
    }

    /// Updates persisted terminal cell dimensions after a resize.
    pub fn pane_session_resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE pane_sessions SET cols=?2,rows=?3 WHERE id=?1",
            params![id, cols, rows],
        )?;
        Ok(())
    }

    /// Compresses with zstd level 3, enforcing per-pane and aggregate compressed limits atomically.
    pub fn scrollback_save(&self, pane_id: &str, bytes: &[u8]) -> Result<(), StoreError> {
        if bytes.len() > DECODE_LIMIT {
            return Err(StoreError::RestoreTooLarge);
        }
        let compressed = zstd::stream::encode_all(bytes, 3).map_err(StoreError::Scrollback)?;
        self.scrollback_save_compressed(pane_id, &compressed, TOTAL_LIMIT)
    }

    fn scrollback_save_compressed(
        &self,
        pane_id: &str,
        compressed: &[u8],
        total_limit: usize,
    ) -> Result<(), StoreError> {
        if compressed.len() > PANE_LIMIT {
            return Err(StoreError::RestoreTooLarge);
        }
        let transaction = self.conn.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO pane_sessions(id,scrollback,updated_at) VALUES (?1,?2,?3)
            ON CONFLICT(id) DO UPDATE SET scrollback=excluded.scrollback,updated_at=excluded.updated_at",
            params![pane_id, compressed, now()],
        )?;
        loop {
            let total: i64 = transaction.query_row(
                "SELECT COALESCE(SUM(length(scrollback)),0) FROM pane_sessions",
                [],
                |r| r.get(0),
            )?;
            if total <= total_limit as i64 {
                break;
            }
            // Evict history only, retaining cwd and shell metadata. Current pane wins timestamp ties.
            transaction.execute("UPDATE pane_sessions SET scrollback=NULL WHERE id=(SELECT id FROM pane_sessions WHERE scrollback IS NOT NULL ORDER BY updated_at, (id=?1),id LIMIT 1)",[pane_id])?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Decompresses history with a decoded size limit; corrupt frames return a typed error.
    pub fn scrollback_load(&self, pane_id: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let blob: Option<Vec<u8>> = self
            .conn
            .query_row("SELECT scrollback FROM pane_sessions WHERE id=?1", [pane_id], |r| {
                r.get(0)
            })
            .optional()?
            .flatten();
        let Some(blob) = blob else {
            return Ok(None);
        };
        let decoder = zstd::stream::read::Decoder::new(blob.as_slice()).map_err(StoreError::Scrollback)?;
        let mut bytes = Vec::new();
        decoder
            .take(DECODE_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(StoreError::Scrollback)?;
        if bytes.len() > DECODE_LIMIT {
            return Err(StoreError::RestoreTooLarge);
        }
        Ok(Some(bytes))
    }

    /// Deletes pane metadata and its compressed history together.
    pub fn pane_session_delete(&self, pane_id: &str) -> Result<(), StoreError> {
        self.conn.execute("DELETE FROM pane_sessions WHERE id=?1", [pane_id])?;
        Ok(())
    }
}

impl Store {
    /// SQLite's bundled JSON parser: no extra dependency, and errors never echo the text.
    fn valid_json(&self, text: &str) -> Result<bool, StoreError> {
        Ok(self.conn.query_row("SELECT json_valid(?1)", [text], |row| row.get(0))?)
    }
}

fn layout_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedLayout> {
    Ok(SavedLayout {
        window_id: row.get(0)?,
        state: row.get(1)?,
        version: row.get(2)?,
        bounds: row.get(3)?,
        updated_at: row.get(4)?,
    })
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DataDirs;
    fn fixture() -> (tempfile::TempDir, Store) {
        let temp = tempfile::tempdir().expect("temp");
        let store = Store::open(&DataDirs::from_root(temp.path().join("data"))).expect("store");
        (temp, store)
    }
    fn session(id: &str, window: &str) -> PaneSession {
        PaneSession {
            id: id.into(),
            window_id: window.into(),
            cwd: "/tmp".into(),
            shell: "/bin/sh".into(),
            cols: 80,
            rows: 24,
        }
    }
    #[test]
    fn layouts_preserve_text_and_reject_invalid_or_oversized_input() {
        let (_temp, store) = fixture();
        let text = "{ \"version\": 7, \"future\": [true] }";
        store.layout_save("main", text).expect("save");
        let saved = store.layout_load("main").unwrap().unwrap();
        assert_eq!(saved.state, text);
        assert_eq!(saved.version, 7);
        assert!(matches!(
            store.layout_save("main", "{"),
            Err(StoreError::RestoreInvalidJson)
        ));
        assert!(matches!(
            store.layout_save("main", &" ".repeat(LAYOUT_LIMIT + 1)),
            Err(StoreError::RestoreTooLarge)
        ));
        assert_eq!(store.layout_list().unwrap(), vec![saved]);
        store.layout_delete("main").unwrap();
        assert!(store.layout_list().unwrap().is_empty());
    }
    #[test]
    fn history_roundtrip_delete_corruption_and_caps() {
        let (_temp, store) = fixture();
        let bytes = b"hello\x1b[32m world\r\n".repeat(4096);
        store.scrollback_save("pane", &bytes).unwrap();
        assert_eq!(store.scrollback_load("pane").unwrap(), Some(bytes));
        assert!(matches!(
            store.scrollback_save_compressed("pane", &vec![1; PANE_LIMIT + 1], TOTAL_LIMIT),
            Err(StoreError::RestoreTooLarge)
        ));
        store
            .conn
            .execute("UPDATE pane_sessions SET scrollback=x'000102' WHERE id='pane'", [])
            .unwrap();
        assert!(matches!(store.scrollback_load("pane"), Err(StoreError::Scrollback(_))));
        store.pane_session_delete("pane").unwrap();
        assert_eq!(store.scrollback_load("pane").unwrap(), None);
    }
    #[test]
    fn oldest_history_is_evicted_but_metadata_survives() {
        let (_temp, store) = fixture();
        let blob = zstd::stream::encode_all(&b"abc"[..], 3).unwrap();
        for id in ["old", "new"] {
            store.scrollback_save_compressed(id, &blob, blob.len() * 2).unwrap();
        }
        store
            .conn
            .execute("UPDATE pane_sessions SET updated_at=0 WHERE id='old'", [])
            .unwrap();
        store
            .scrollback_save_compressed("latest", &blob, blob.len() * 2)
            .unwrap();
        assert_eq!(store.scrollback_load("old").unwrap(), None);
        assert!(store.scrollback_load("new").unwrap().is_some());
        assert!(store.scrollback_load("latest").unwrap().is_some());
        assert_eq!(
            store
                .conn
                .query_row("SELECT COUNT(*) FROM pane_sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
    #[test]
    fn previous_schema_migrates_and_keeps_existing_data() {
        use rusqlite_migration::{M, Migrations};
        let temp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(temp.path().join("data"));
        let old = Migrations::new(vec![
            M::up(include_str!("../migrations/0001_kv.sql")),
            M::up(include_str!("../migrations/0002_projects_tasks.sql")),
        ]);
        let store = Store::open_with_migrations(&dirs, &old).unwrap();
        store.kv_set("kept", "yes").unwrap();
        drop(store);
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), crate::db::SCHEMA_VERSION);
        assert_eq!(store.kv_get("kept").unwrap().as_deref(), Some("yes"));
        // The new tables exist, are empty for old data, and are immediately usable.
        assert!(store.layout_list().unwrap().is_empty());
        assert_eq!(store.scrollback_load("pane").unwrap(), None);
        store.layout_save("main", "{}").unwrap();
        store.pane_session_save(&session("pane", "main")).unwrap();
        store.scrollback_save("pane", b"after migration").unwrap();
        assert_eq!(
            store.scrollback_load("pane").unwrap().as_deref(),
            Some(&b"after migration"[..])
        );
        assert!(dirs.root.join("tessera.db.bak-2").exists());
    }
    #[test]
    fn fresh_database_creates_both_restore_tables() {
        let (_temp, store) = fixture();
        assert_eq!(store.schema_version().unwrap(), crate::db::SCHEMA_VERSION);
        assert!(store.layout_list().unwrap().is_empty());
        assert_eq!(store.scrollback_load("missing").unwrap(), None);
        let tables: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name IN ('layouts','pane_sessions')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2, "migration 0003 declares both tables");
        // A first save works without any earlier migration step.
        store.pane_session_save(&session("p1", "main")).unwrap();
        store.scrollback_save("p1", b"first run").unwrap();
        assert_eq!(store.scrollback_load("p1").unwrap().as_deref(), Some(&b"first run"[..]));
    }
    #[test]
    fn layout_limit_is_inclusive_and_upsert_keeps_window_bounds() {
        let (_temp, store) = fixture();
        let bounds = r#"{"x":1.0,"y":2.0,"w":800.0,"h":600.0,"monitor":null,"maximized":false}"#;
        let maximal = format!("{{\"v\":\"{}\"}}", "a".repeat(LAYOUT_LIMIT - 8));
        assert_eq!(maximal.len(), LAYOUT_LIMIT);
        store
            .layout_save_with_bounds("main", &maximal, Some(bounds))
            .expect("exactly the limit is allowed");
        assert_eq!(store.layout_load("main").unwrap().unwrap().state, maximal);
        assert!(matches!(
            store.layout_save("main", &format!("{maximal} ")),
            Err(StoreError::RestoreTooLarge)
        ));
        assert!(matches!(
            store.layout_save_with_bounds("main", "{}", Some(&" ".repeat(BOUNDS_LIMIT + 1))),
            Err(StoreError::RestoreTooLarge)
        ));
        // The upsert replaces the text and version, and a save without bounds keeps the stored geometry.
        store.layout_save("main", r#"{"version":2}"#).unwrap();
        let saved = store.layout_load("main").unwrap().unwrap();
        assert_eq!(saved.state, r#"{"version":2}"#);
        assert_eq!(saved.version, 2);
        assert_eq!(saved.bounds.as_deref(), Some(bounds));
        assert_eq!(store.layout_list().unwrap().len(), 1);
        assert!(store.layout_load("other").unwrap().is_none());
    }
    #[test]
    fn geometry_is_validated_and_created_before_the_first_layout() {
        let (_temp, store) = fixture();
        store
            .layout_bounds_upsert("main", r#"{"x":10.0,"y":20.0,"w":1200.0,"h":780.0}"#)
            .unwrap();
        let saved = store.layout_load("main").unwrap().unwrap();
        assert_eq!(saved.state, "{}", "geometry-only rows carry an empty layout object");
        assert!(saved.bounds.is_some());
        assert!(matches!(
            store.layout_bounds_upsert("main", "{"),
            Err(StoreError::RestoreInvalidJson)
        ));
        assert!(matches!(
            store.layout_bounds_upsert("main", &"1".repeat(BOUNDS_LIMIT + 1)),
            Err(StoreError::RestoreTooLarge)
        ));
        store.layout_bounds_upsert("main", r#"{"x":99.0}"#).unwrap();
        assert_eq!(
            store.layout_load("main").unwrap().unwrap().bounds.as_deref(),
            Some(r#"{"x":99.0}"#)
        );
    }
    #[test]
    fn a_compression_bomb_is_refused_without_decoding_it() {
        let (_temp, store) = fixture();
        let bomb = zstd::stream::encode_all(vec![0u8; DECODE_LIMIT + 1024 * 1024].as_slice(), 3).unwrap();
        assert!(bomb.len() < PANE_LIMIT, "the compressed frame itself is small");
        store.scrollback_save_compressed("bomb", &bomb, TOTAL_LIMIT).unwrap();
        assert!(matches!(
            store.scrollback_load("bomb"),
            Err(StoreError::RestoreTooLarge)
        ));
    }
    #[test]
    fn eviction_keeps_the_current_pane_and_breaks_ties_by_id() {
        let (_temp, store) = fixture();
        let blob = zstd::stream::encode_all(&b"abc"[..], 3).unwrap();
        let budget = blob.len() * 2;
        store.scrollback_save_compressed("a", &blob, budget).unwrap();
        store.scrollback_save_compressed("b", &blob, budget).unwrap();
        // Exactly at the budget: nothing is evicted.
        assert!(store.scrollback_load("a").unwrap().is_some());
        assert!(store.scrollback_load("b").unwrap().is_some());
        store.conn.execute("UPDATE pane_sessions SET updated_at=7", []).unwrap();
        store.scrollback_save_compressed("c", &blob, budget).unwrap();
        assert_eq!(
            store.scrollback_load("a").unwrap(),
            None,
            "oldest by id is evicted first"
        );
        assert!(store.scrollback_load("b").unwrap().is_some());
        assert!(
            store.scrollback_load("c").unwrap().is_some(),
            "the pane just saved is kept"
        );
    }
    #[test]
    fn concurrent_connections_only_observe_whole_layouts() {
        let (temp, store) = fixture();
        store.layout_save("main", "{\"version\":1}").unwrap();
        let dirs = DataDirs::from_root(temp.path().join("data"));
        let writer = std::thread::spawn(move || {
            let store = Store::open(&dirs).unwrap();
            for _ in 0..100 {
                store.layout_save("main", "{\"version\":2}").unwrap();
            }
        });
        for _ in 0..100 {
            let row = store.layout_load("main").unwrap().unwrap();
            assert!(
                (row.version == 1 && row.state == "{\"version\":1}")
                    || (row.version == 2 && row.state == "{\"version\":2}")
            );
        }
        writer.join().unwrap();
    }
}
