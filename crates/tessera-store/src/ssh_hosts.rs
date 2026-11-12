//! SSH hosts the user added by hand, and stored settings for hosts from `~/.ssh/config` (FR-62). Passwords never live
//! here: `keychain_ref` only names the OS keychain entry.
use crate::{Store, StoreError, repositories::new_id};
use rusqlite::{OptionalExtension, params};

/// One saved host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshHost {
    pub id: String,
    pub alias: String,
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    /// `agent`, `key` or `password`.
    pub auth: String,
    pub key_path: Option<String>,
    pub from_ssh_config: bool,
    /// The keychain account name when a password is saved.
    pub keychain_ref: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a save takes (`id: None` creates).
#[derive(Debug, Clone)]
pub struct SshHostInput {
    pub id: Option<String>,
    pub alias: String,
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub auth: String,
    pub key_path: Option<String>,
    pub from_ssh_config: bool,
}

const SELECT: &str =
    "SELECT id,alias,host,port,user,auth,key_path,from_ssh_config,keychain_ref,created_at,updated_at FROM ssh_hosts";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SshHost> {
    let port: Option<i64> = r.get(3)?;
    Ok(SshHost {
        id: r.get(0)?,
        alias: r.get(1)?,
        host: r.get(2)?,
        port: port.and_then(|p| u16::try_from(p).ok()),
        user: r.get(4)?,
        auth: r.get(5)?,
        key_path: r.get(6)?,
        from_ssh_config: r.get::<_, i64>(7)? != 0,
        keychain_ref: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

impl Store {
    /// Saved hosts, by alias.
    ///
    /// # Errors
    /// Database errors.
    pub fn ssh_hosts(&self) -> Result<Vec<SshHost>, StoreError> {
        let mut statement = self.conn.prepare(&format!("{SELECT} ORDER BY alias COLLATE NOCASE"))?;
        let rows = statement.query_map([], row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// One saved host by id.
    ///
    /// # Errors
    /// Database errors.
    pub fn ssh_host_get(&self, id: &str) -> Result<Option<SshHost>, StoreError> {
        Ok(self
            .conn
            .query_row(&format!("{SELECT} WHERE id=?1"), [id], row)
            .optional()?)
    }

    /// One saved host by alias.
    ///
    /// # Errors
    /// Database errors.
    pub fn ssh_host_by_alias(&self, alias: &str) -> Result<Option<SshHost>, StoreError> {
        Ok(self
            .conn
            .query_row(&format!("{SELECT} WHERE alias=?1"), [alias], row)
            .optional()?)
    }

    /// Creates or updates a host; the keychain reference is kept.
    ///
    /// # Errors
    /// Database errors, including a duplicate alias.
    pub fn ssh_host_save(&self, input: &SshHostInput) -> Result<SshHost, StoreError> {
        let now = crate::agents::now_millis();
        let id = input.id.clone().unwrap_or_else(new_id);
        self.conn.execute(
            "INSERT INTO ssh_hosts(id,alias,host,port,user,auth,key_path,from_ssh_config,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
             ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,host=excluded.host,port=excluded.port,
               user=excluded.user,auth=excluded.auth,key_path=excluded.key_path,
               from_ssh_config=excluded.from_ssh_config,updated_at=excluded.updated_at",
            params![
                id,
                input.alias,
                input.host,
                input.port.map(i64::from),
                input.user,
                input.auth,
                input.key_path,
                i64::from(input.from_ssh_config),
                now
            ],
        )?;
        self.ssh_host_get(&id)?
            .ok_or(StoreError::Database(rusqlite::Error::QueryReturnedNoRows))
    }

    /// Records (or clears) the keychain entry name for a host.
    ///
    /// # Errors
    /// Database errors.
    pub fn ssh_host_set_keychain(&self, id: &str, keychain_ref: Option<&str>) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE ssh_hosts SET keychain_ref=?2, updated_at=?3 WHERE id=?1",
            params![id, keychain_ref, crate::agents::now_millis()],
        )?;
        Ok(())
    }

    /// Deletes a saved host.
    ///
    /// # Errors
    /// Database errors.
    pub fn ssh_host_delete(&self, id: &str) -> Result<(), StoreError> {
        self.conn.execute("DELETE FROM ssh_hosts WHERE id=?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DataDirs;

    fn input(alias: &str) -> SshHostInput {
        SshHostInput {
            id: None,
            alias: alias.into(),
            host: "example.com".into(),
            port: Some(2222),
            user: Some("me".into()),
            auth: "password".into(),
            key_path: None,
            from_ssh_config: false,
        }
    }

    #[test]
    fn hosts_save_update_keychain_and_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&DataDirs::from_root(tmp.path())).unwrap();
        let saved = store.ssh_host_save(&input("box")).unwrap();
        assert_eq!(saved.port, Some(2222));
        store.ssh_host_set_keychain(&saved.id, Some("tessera-ssh:box")).unwrap();
        let mut update = input("box");
        update.id = Some(saved.id.clone());
        update.auth = "key".into();
        update.key_path = Some("/k".into());
        let updated = store.ssh_host_save(&update).unwrap();
        assert_eq!(updated.auth, "key");
        assert_eq!(
            updated.keychain_ref.as_deref(),
            Some("tessera-ssh:box"),
            "a save keeps the keychain reference"
        );
        assert_eq!(store.ssh_host_by_alias("box").unwrap().unwrap().id, saved.id);
        assert!(store.ssh_host_save(&input("box")).is_err(), "aliases are unique");
        let mut bad = input("other");
        bad.auth = "telepathy".into();
        assert!(store.ssh_host_save(&bad).is_err());
        store.ssh_host_delete(&saved.id).unwrap();
        assert!(store.ssh_hosts().unwrap().is_empty());
    }

    #[test]
    fn version_seven_fixture_gains_the_table_and_keeps_data() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path());
        let old = rusqlite_migration::Migrations::from_slice(&crate::db::MIGRATION_LIST[..7]);
        {
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            store.kv_set("kept", "yes").unwrap();
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), crate::db::SCHEMA_VERSION);
        assert_eq!(store.kv_get("kept").unwrap().as_deref(), Some("yes"));
        assert!(store.ssh_hosts().unwrap().is_empty());
        assert!(dirs.root.join("tessera.db.bak-7").is_file());
    }
}
