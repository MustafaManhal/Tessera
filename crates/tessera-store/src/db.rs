//! The SQLite database: connection setup, embedded migrations and backups.
//!
//! Migrations live in `crates/tessera-store/migrations/NNNN_name.sql` and are
//! embedded with `include_str!`, so a shipped binary always has the same
//! schema history. `PRAGMA user_version` is the schema version.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use rusqlite_migration::{M, Migrations};

use crate::error::StoreError;
use crate::paths::DataDirs;

/// The embedded migration list. Add one `M::up(include_str!(...))` per new file.
pub(crate) const MIGRATION_LIST: &[M<'static>] = &[
    M::up(include_str!("../migrations/0001_kv.sql")),
    M::up(include_str!("../migrations/0002_projects_tasks.sql")),
    M::up(include_str!("../migrations/0003_restore.sql")),
    M::up(include_str!("../migrations/0004_agents.sql")),
    M::up(include_str!("../migrations/0005_agent_sessions.sql")),
    M::up(include_str!("../migrations/0006_hook_states.sql")),
    M::up(include_str!("../migrations/0007_status_message.sql")),
    M::up(include_str!("../migrations/0008_ssh_hosts.sql")),
    M::up(include_str!("../migrations/0009_notifications.sql")),
    // 0010 was never used: two branches numbered in parallel; prompts landed after resume and became 0012.
    M::up(include_str!("../migrations/0011_agent_resume.sql")),
    M::up(include_str!("../migrations/0012_prompts.sql")),
    M::up(include_str!("../migrations/0013_integrations.sql")),
    M::up(include_str!("../migrations/0014_review_comments.sql")),
    M::up(include_str!("../migrations/0015_automations.sql")),
    M::up(include_str!("../migrations/0016_mcp_skills.sql")),
];

/// The schema version after every migration (tests compare against it instead of a literal, so a new migration
/// does not touch every test).
#[allow(clippy::cast_possible_truncation)]
pub const SCHEMA_VERSION: u32 = MIGRATION_LIST.len() as u32;

/// All migrations, in order. The version after the last one is the schema
/// version reported by [`Store::schema_version`].
pub const MIGRATIONS: Migrations<'static> = Migrations::from_slice(MIGRATION_LIST);

/// Adds the tables and nullable columns that a database lacks compared with a fresh one built from the same
/// migrations. Failures are logged and skipped: a repair must never stop the app from starting.
fn repair_schema(conn: &Connection, migrations: &Migrations<'_>) {
    let Ok(mut fresh) = Connection::open_in_memory() else {
        return;
    };
    if migrations.to_latest(&mut fresh).is_err() {
        return;
    }
    let tables = |c: &Connection| -> Vec<(String, String)> {
        c.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .and_then(|mut q| q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default()
    };
    let columns = |c: &Connection, table: &str| -> Vec<(String, String, bool)> {
        c.prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .and_then(|mut q| {
                q.query_map([], |r| {
                    Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)? != 0))
                })?
                .collect()
            })
            .unwrap_or_default()
    };
    for (table, create_sql) in tables(&fresh) {
        let have = columns(conn, &table);
        if have.is_empty() {
            match conn.execute_batch(&create_sql) {
                Ok(()) => tracing::warn!(%table, "repaired the database: created a missing table"),
                Err(error) => tracing::warn!(%table, %error, "could not repair a missing table"),
            }
            continue;
        }
        for (name, kind, not_null) in columns(&fresh, &table) {
            if have.iter().any(|(existing, ..)| *existing == name) {
                continue;
            }
            // SQLite cannot add a NOT NULL column without a default to a table that has rows.
            if not_null {
                tracing::warn!(%table, %name, "a required column is missing and cannot be added");
                continue;
            }
            let ddl = format!("ALTER TABLE \"{table}\" ADD COLUMN \"{name}\" {kind}");
            match conn.execute(&ddl, []) {
                Ok(_) => tracing::warn!(%table, %name, "repaired the database: added a missing column"),
                Err(error) => tracing::warn!(%table, %name, %error, "could not add a missing column"),
            }
        }
    }
}

/// How many `tessera.db.bak-*` files a migration may leave behind.
const MAX_BACKUPS: usize = 3;

/// An open Tessera database.
pub struct Store {
    pub(crate) conn: Connection,
}

impl Store {
    /// Opens `tessera.db` in the given data folder, creating the folder when
    /// needed. Applies any pending embedded migration.
    ///
    /// Before migrating an existing non-empty database, a copy is written to
    /// `tessera.db.bak-<old version>` (at most three are kept). A brand-new
    /// database has nothing to copy and gets no backup file.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError`] when the folder cannot be created, SQLite refuses
    /// the file (for example a read-only folder), a pragma fails, or a migration
    /// fails. It never panics.
    pub fn open(dirs: &DataDirs) -> Result<Self, StoreError> {
        Self::open_with_migrations(dirs, &MIGRATIONS)
    }

    /// Opens the database with an explicit migration list. Used by the tests to
    /// simulate an older schema; production code calls [`Store::open`].
    pub(crate) fn open_with_migrations(dirs: &DataDirs, migrations: &Migrations<'_>) -> Result<Self, StoreError> {
        Self::open_observed_migrations(dirs, migrations, &|_| {})
    }

    /// Opens and migrates the store while reporting phase names to a diagnostic observer.
    /// Errors and migration/backup semantics are identical to [`Store::open`].
    pub fn open_observed(dirs: &DataDirs, mark: &dyn Fn(&str)) -> Result<Self, StoreError> {
        Self::open_observed_migrations(dirs, &MIGRATIONS, mark)
    }

    fn open_observed_migrations(
        dirs: &DataDirs,
        migrations: &Migrations<'_>,
        mark: &dyn Fn(&str),
    ) -> Result<Self, StoreError> {
        mark("database_open_begin");
        fs::create_dir_all(&dirs.root).map_err(|source| StoreError::CreateDir {
            path: dirs.root.clone(),
            source,
        })?;

        let existed = fs::metadata(&dirs.db).is_ok_and(|metadata| metadata.len() > 0);

        let mut conn = Connection::open(&dirs.db).map_err(|source| StoreError::Open {
            path: dirs.db.clone(),
            source,
        })?;
        configure(&conn)?;
        mark("database_open_ready");
        mark("migration_begin");

        let pending = migrations.pending_migrations(&conn)?;
        if existed && pending > 0 {
            let old_version: usize = migrations.current_version(&conn)?.into();
            backup_before_migration(&conn, dirs, old_version)?;
        }

        migrations.to_latest(&mut conn)?;
        // A database made by a development branch that numbered its migrations differently can claim a version
        // without having what that version adds. Compare with a fresh database and fill in what is missing.
        if existed {
            repair_schema(&conn, migrations);
        }
        mark("migration_ready");
        Ok(Self { conn })
    }

    /// Reads a small piece of app state.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::Database`] when the query fails.
    pub fn kv_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        let value = self
            .conn
            .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |row| row.get(0))
            .optional()?;
        Ok(value)
    }

    /// Removes a piece of app state; removing a missing key is fine.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::Database`] when the write fails.
    pub fn kv_delete(&self, key: &str) -> Result<(), StoreError> {
        self.conn.execute("DELETE FROM kv WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Writes a small piece of app state, stamping it with the current time.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::Database`] when the write fails.
    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_millis()],
        )?;
        Ok(())
    }

    /// The schema version (`PRAGMA user_version`).
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::Database`] when the pragma cannot be read.
    pub fn schema_version(&self) -> Result<u32, StoreError> {
        let version: i64 = self.conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        Ok(u32::try_from(version).unwrap_or(0))
    }

    /// The database's journal mode, for the app's About screen and tests.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::Database`] when the pragma cannot be read.
    pub fn journal_mode(&self) -> Result<String, StoreError> {
        let mode: String = self.conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        Ok(mode)
    }
}

fn configure(conn: &Connection) -> Result<(), StoreError> {
    // WAL is a database property and returns its new value, so use the
    // checked variant rusqlite documents for it.
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |_row| Ok(()))?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    Ok(())
}

/// Writes `tessera.db.bak-<old_version>` and trims the folder to the last
/// [`MAX_BACKUPS`] copies.
fn backup_before_migration(conn: &Connection, dirs: &DataDirs, old_version: usize) -> Result<(), StoreError> {
    let target = backup_path(dirs, old_version);
    // VACUUM INTO refuses to overwrite an existing file. A stale copy with the
    // same old version adds nothing, so replace it.
    if target.exists() {
        fs::remove_file(&target).map_err(StoreError::BackupFiles)?;
    }
    // VACUUM INTO writes a consistent, compacted copy of a WAL database and is
    // available without rusqlite's optional `backup` feature.
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy().into_owned()])
        .map_err(|source| StoreError::Backup { path: target, source })?;
    tracing::info!(version = old_version, "backed up the database before migrating");
    trim_backups(dirs)
}

/// The backup file for a schema version.
fn backup_path(dirs: &DataDirs, version: usize) -> std::path::PathBuf {
    let name = format!(
        "{}.bak-{version}",
        dirs.db
            .file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default()
    );
    dirs.root.join(name)
}

/// Keeps the three highest-version backups, deleting older ones.
fn trim_backups(dirs: &DataDirs) -> Result<(), StoreError> {
    let mut versions = backup_versions(&dirs.root)?;
    versions.sort_unstable();
    while versions.len() > MAX_BACKUPS {
        let version = versions.remove(0);
        let path = backup_path(dirs, version);
        fs::remove_file(path).map_err(StoreError::BackupFiles)?;
    }
    Ok(())
}

/// Versions found in `tessera.db.bak-*` files.
fn backup_versions(root: &Path) -> Result<Vec<usize>, StoreError> {
    let mut versions = Vec::new();
    let entries = fs::read_dir(root).map_err(StoreError::BackupFiles)?;
    for entry in entries {
        let entry = entry.map_err(StoreError::BackupFiles)?;
        let name = entry.file_name();
        let Some(suffix) = name.to_str().and_then(|name| name.strip_prefix("tessera.db.bak-")) else {
            continue;
        };
        if let Ok(version) = suffix.parse::<usize>() {
            versions.push(version);
        }
    }
    Ok(versions)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_database_with_a_missing_column_or_table_is_repaired_on_open() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path());
        {
            let store = Store::open(&dirs).unwrap();
            store
                .conn
                .execute_batch("ALTER TABLE agent_sessions DROP COLUMN launch_cwd; DROP TABLE prompts;")
                .unwrap();
        }
        let store = Store::open(&dirs).unwrap();
        store.conn.prepare("SELECT launch_cwd FROM agent_sessions").unwrap();
        store.conn.prepare("SELECT id FROM prompts").unwrap();
        drop(store);
        // Opening again changes nothing.
        Store::open(&dirs).unwrap();
    }

    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn dirs(temp: &tempfile::TempDir) -> DataDirs {
        DataDirs::from_root(temp.path().join("Tessera Dev"))
    }

    #[test]
    fn open_creates_a_wal_database_and_applies_migrations() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dirs = dirs(&temp);
        let store = Store::open(&dirs).expect("open");
        assert!(dirs.db.is_file(), "tessera.db was created");
        assert_eq!(store.journal_mode().expect("journal mode"), "wal");
        assert!(store.schema_version().expect("version") >= 1);
        assert!(!backup_path(&dirs, 0).exists(), "a new database has nothing to back up");
    }

    #[test]
    fn kv_round_trip_and_reopen_is_a_no_op() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dirs = dirs(&temp);
        {
            let store = Store::open(&dirs).expect("open");
            store.kv_set("last_seen_version", "0.1.0").expect("set");
            assert_eq!(
                store.kv_get("last_seen_version").expect("get").as_deref(),
                Some("0.1.0")
            );
            assert_eq!(store.kv_get("missing").expect("get missing"), None);
        }

        let store = Store::open(&dirs).expect("reopen");
        assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
        assert_eq!(
            store.kv_get("last_seen_version").expect("get").as_deref(),
            Some("0.1.0")
        );
        assert!(
            !backup_path(&dirs, 0).exists() && !backup_path(&dirs, 1).exists(),
            "reopening at the current version must not back up"
        );
    }

    #[test]
    fn version_zero_database_is_backed_up_and_keeps_its_rows() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dirs = dirs(&temp);
        fs::create_dir_all(&dirs.root).expect("data folder");

        // An early hand-made database: the kv table exists, the version is 0.
        {
            let conn = Connection::open(&dirs.db).expect("fixture");
            conn.execute_batch(
                "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO kv (key, value, updated_at) VALUES ('kept', 'yes', 0);",
            )
            .expect("fixture schema");
            assert_eq!(
                conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                    .expect("version"),
                0
            );
        }

        let store = Store::open(&dirs).expect("open and migrate");
        assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
        assert_eq!(store.kv_get("kept").expect("get").as_deref(), Some("yes"));

        let backup = backup_path(&dirs, 0);
        assert!(backup.is_file(), "the version 0 copy exists");
        let conn = Connection::open(&backup).expect("open backup");
        let kept: String = conn
            .query_row("SELECT value FROM kv WHERE key = 'kept'", [], |row| row.get(0))
            .expect("row is in the backup");
        assert_eq!(kept, "yes");
    }

    #[test]
    fn only_the_last_three_backups_are_kept() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dirs = dirs(&temp);
        fs::create_dir_all(&dirs.root).expect("data folder");

        let old = Migrations::new(vec![
            M::up("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);"),
            M::up("CREATE TABLE one (id INTEGER PRIMARY KEY);"),
            M::up("CREATE TABLE two (id INTEGER PRIMARY KEY);"),
        ]);
        {
            let mut conn = Connection::open(&dirs.db).expect("fixture");
            old.to_latest(&mut conn).expect("old schema");
        }
        for version in 0..3 {
            fs::write(backup_path(&dirs, version), b"old backup").expect("fake backup");
        }

        let new = Migrations::new(vec![
            M::up("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);"),
            M::up("CREATE TABLE one (id INTEGER PRIMARY KEY);"),
            M::up("CREATE TABLE two (id INTEGER PRIMARY KEY);"),
            M::up("CREATE TABLE three (id INTEGER PRIMARY KEY);"),
        ]);
        let store = Store::open_with_migrations(&dirs, &new).expect("migrate");
        assert_eq!(store.schema_version().expect("version"), 4);
        assert!(backup_path(&dirs, 3).is_file(), "the new backup exists");

        let versions = backup_versions(&dirs.root).expect("list");
        let mut versions = versions;
        versions.sort_unstable();
        assert_eq!(versions, vec![1, 2, 3], "only the last three survive");
    }

    #[test]
    #[cfg(unix)]
    fn a_read_only_folder_returns_an_error_not_a_panic() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dirs = dirs(&temp);
        fs::create_dir_all(&dirs.root).expect("data folder");
        let mut permissions = fs::metadata(&dirs.root).expect("metadata").permissions();
        permissions.set_mode(0o500);
        fs::set_permissions(&dirs.root, permissions).expect("make read-only");

        // Root ignores permission bits (Docker runs as root): the folder is still writable, nothing to test.
        let writable = fs::write(dirs.root.join(".probe"), b"").is_ok();
        let result = if writable { None } else { Some(Store::open(&dirs)) };

        // Restore write access before TempDir drops, so cleanup works.
        let mut permissions = fs::metadata(&dirs.root).expect("metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&dirs.root, permissions).expect("restore permissions");

        if let Some(result) = result {
            assert!(matches!(result, Err(StoreError::Open { .. })));
        }
    }
}

#[cfg(test)]
mod projects_migration_tests {
    use super::*;

    #[test]
    fn version_one_fixture_survives_and_is_backed_up() {
        let temp = tempfile::tempdir().expect("temp");
        let dirs = DataDirs::from_root(temp.path().join("data"));
        let old = Migrations::new(vec![M::up(include_str!("../migrations/0001_kv.sql"))]);
        {
            let store = Store::open_with_migrations(&dirs, &old).expect("v1");
            store.kv_set("fixture", "preserved").expect("write");
        }
        let store = Store::open(&dirs).expect("migrate");
        assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
        assert_eq!(store.kv_get("fixture").expect("read").as_deref(), Some("preserved"));
        let backup = Connection::open(dirs.root.join("tessera.db.bak-1")).expect("backup");
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .expect("version"),
            1
        );
        store
            .conn
            .execute(
                "INSERT INTO projects(id,name,path,default_branch) VALUES ('p','project','/fixture','main')",
                [],
            )
            .expect("project");
        store
            .conn
            .execute("INSERT INTO run_scripts(id,project_id) VALUES ('r','p')", [])
            .expect("script");
        assert!(store.conn.execute("INSERT INTO tasks(id,project_id,name,slug,branch,base_branch,state) VALUES ('t','p','task','task','tessera/task','main','wrong')", []).is_err());
        store.conn.execute("INSERT INTO tasks(id,project_id,name,slug,branch,base_branch,state) VALUES ('t','p','task','task','tessera/task','main','active')", []).expect("task");
        let mut task = store.tasks().get("t").expect("get").expect("task");
        assert_eq!(task.state.as_deref(), Some("active"));
        task.state = Some("archived".into());
        assert!(store.tasks().update(&task).expect("update"));
        assert_eq!(store.tasks().list().expect("list"), vec![task.clone()]);
        task.id = "duplicate".into();
        assert!(store.tasks().insert(&task).is_err(), "project slug is unique");
        task.id = "invalid-fk".into();
        task.slug = "other".into();
        task.project_id = Some("missing".into());
        assert!(store.tasks().insert(&task).is_err(), "project foreign key enforced");
        store.tasks().delete("t").expect("delete task");
        store.projects().delete("p").expect("delete");
        assert!(store.run_scripts().list().expect("scripts").is_empty());
    }
}

#[cfg(test)]
mod agents_migration_tests {
    use super::*;
    #[test]
    fn version_three_fixture_is_preserved_and_backed_up() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path());
        let old = Migrations::new(vec![
            M::up(include_str!("../migrations/0001_kv.sql")),
            M::up(include_str!("../migrations/0002_projects_tasks.sql")),
            M::up(include_str!("../migrations/0003_restore.sql")),
        ]);
        {
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            store.kv_set("fixture", "kept").unwrap();
            store
                .conn
                .execute(
                    "INSERT INTO layouts(window_id,state,updated_at) VALUES('main','{}',1)",
                    [],
                )
                .unwrap();
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.kv_get("fixture").unwrap().as_deref(), Some("kept"));
        assert_eq!(
            store
                .conn
                .query_row("SELECT state FROM layouts WHERE window_id='main'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "{}"
        );
        let backup = Connection::open(dirs.root.join("tessera.db.bak-3")).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
                .unwrap(),
            3
        );
        store.agent_profiles().ensure_default("claude").unwrap();
        assert_eq!(store.agent_profiles().list(None).unwrap().len(), 1);
    }
}

#[cfg(test)]
mod agent_sessions_migration_tests {
    use super::*;
    #[test]
    fn agent_sessions_version_four_fixture_preserves_profiles_and_install_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path());
        let old = Migrations::from_slice(&MIGRATION_LIST[..4]);
        let profile_id;
        {
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            store.agent_profiles().ensure_default("claude").unwrap();
            profile_id = store.agent_profiles().list(None).unwrap()[0].id.clone();
            store.kv_set("kept", "yes").unwrap();
            store
                .agent_install_save(&crate::agents::AgentInstall {
                    agent_id: "claude".into(),
                    binary_path: Some("/fixture/claude".into()),
                    version: Some("1.2.3".into()),
                    detected_at: 1,
                    hooks_state: "none".into(),
                })
                .unwrap();
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.kv_get("kept").unwrap().as_deref(), Some("yes"));
        assert_eq!(store.agent_profiles().list(None).unwrap()[0].id, profile_id);
        assert_eq!(
            store.agent_install_get("claude").unwrap().unwrap().version.as_deref(),
            Some("1.2.3")
        );
        let backup = Connection::open(dirs.root.join("tessera.db.bak-4")).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
                .unwrap(),
            4
        );
        let session = store
            .agent_sessions()
            .create(None, "claude", &profile_id, Some("preserved prompt"))
            .unwrap();
        assert_eq!(
            store
                .agent_sessions()
                .get(&session.id)
                .unwrap()
                .unwrap()
                .prompt
                .as_deref(),
            Some("preserved prompt")
        );
    }
}

#[cfg(test)]
mod hook_states_migration_tests {
    use super::*;
    #[test]
    fn hooks_version_five_fixture_preserves_installs_and_accepts_diagnostics() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path());
        let old = Migrations::from_slice(&MIGRATION_LIST[..5]);
        {
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            store
                .agent_install_save(&crate::agents::AgentInstall {
                    agent_id: "claude".into(),
                    binary_path: Some("/fixture/claude".into()),
                    version: Some("1.2.3".into()),
                    detected_at: 123,
                    hooks_state: "installed".into(),
                })
                .unwrap();
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let mut install = store.agent_install_get("claude").unwrap().unwrap();
        assert_eq!(install.hooks_state, "installed");
        assert_eq!(install.version.as_deref(), Some("1.2.3"));
        for state in ["conflict", "unparseable"] {
            install.hooks_state = state.into();
            store.agent_install_save(&install).unwrap();
            assert_eq!(store.agent_install_get("claude").unwrap().unwrap().hooks_state, state);
        }
        assert!(dirs.root.join("tessera.db.bak-5").is_file());
    }
}

#[cfg(test)]
mod status_message_migration_tests {
    use super::*;
    #[test]
    fn status_message_version_six_fixture_preserves_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path());
        let old = Migrations::from_slice(&MIGRATION_LIST[..6]);
        let profile_id;
        let session_id;
        {
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            store.agent_profiles().ensure_default("claude").unwrap();
            profile_id = store.agent_profiles().list(None).unwrap()[0].id.clone();
            let session = store
                .agent_sessions()
                .create(None, "claude", &profile_id, Some("kept prompt"))
                .unwrap();
            session_id = session.id.clone();
            store
                .agent_sessions()
                .set_status(&session.id, "working", "hook", session.started_at + 1)
                .unwrap();
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(dirs.root.join("tessera.db.bak-6").is_file());
        let session = store.agent_sessions().get(&session_id).unwrap().unwrap();
        assert_eq!(session.status, "working");
        assert_eq!(session.status_message, None);
        assert_eq!(session.prompt.as_deref(), Some("kept prompt"));
        // The new column is writable through the detail update and survives a message-only change.
        let updated = store
            .agent_sessions()
            .set_status_detail(
                &session.id,
                "needs_input",
                "hook",
                Some("needs approval"),
                Some("Notification"),
                session.status_at + 1,
            )
            .unwrap()
            .unwrap();
        assert_eq!(updated.status_message.as_deref(), Some("needs approval"));
        let events = store.agent_sessions().events(&session.id).unwrap();
        let last = events.last().unwrap();
        assert!(last.payload.contains("\"from\":\"working\""), "{}", last.payload);
        assert!(last.payload.contains("\"status\":\"needs_input\""), "{}", last.payload);
        assert!(last.payload.contains("\"event\":\"Notification\""), "{}", last.payload);
    }
}
