//! Connected accounts (FR-54): login/id/scopes/keychain_ref only — the token never touches SQLite.
use crate::{Store, StoreError, repositories::new_id};
use rusqlite::{OptionalExtension, params};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Integration {
    pub id: String,
    pub provider: String,
    pub account_login: String,
    pub account_id: String,
    pub scopes: String,
    pub keychain_ref: String,
    pub connected_at: i64,
}

const SELECT: &str = "SELECT id,provider,account_login,account_id,scopes,keychain_ref,connected_at FROM integrations";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Integration> {
    Ok(Integration {
        id: r.get(0)?,
        provider: r.get(1)?,
        account_login: r.get(2)?,
        account_id: r.get(3)?,
        scopes: r.get(4)?,
        keychain_ref: r.get(5)?,
        connected_at: r.get(6)?,
    })
}

impl Store {
    /// Upserts by (provider, account_id); returns the row.
    pub fn integration_upsert(
        &self,
        provider: &str,
        login: &str,
        account_id: &str,
        scopes: &str,
        keychain_ref: &str,
    ) -> Result<Integration, StoreError> {
        let now = crate::repositories::now_seconds();
        self.conn.execute(
            "INSERT INTO integrations (id,provider,account_login,account_id,scopes,keychain_ref,connected_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(provider, account_id) DO UPDATE SET
                   account_login=excluded.account_login, scopes=excluded.scopes,
                   keychain_ref=excluded.keychain_ref",
            params![new_id(), provider, login, account_id, scopes, keychain_ref, now],
        )?;
        self.integration_get(provider).map(|i| i.expect("upserted row exists"))
    }

    pub fn integration_get(&self, provider: &str) -> Result<Option<Integration>, StoreError> {
        Ok(self
            .conn
            .query_row(&format!("{SELECT} WHERE provider=?1"), [provider], row)
            .optional()?)
    }

    /// Removes the row; returns whether one existed.
    pub fn integration_delete(&self, provider: &str) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .execute("DELETE FROM integrations WHERE provider=?1", [provider])?
            > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DataDirs;
    use crate::db::SCHEMA_VERSION;

    #[test]
    fn upsert_get_delete_and_unique_account() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&DataDirs::from_root(tmp.path())).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let first = store
            .integration_upsert("github", "octo", "42", "repo read:org", "octo")
            .unwrap();
        let second = store
            .integration_upsert("github", "octo", "42", "repo", "octo2")
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.scopes, "repo");
        assert_eq!(second.keychain_ref, "octo2");
        store.integration_upsert("linear", "lin", "7", "read", "lin").unwrap();
        assert!(store.integration_get("github").unwrap().is_some());
        assert!(store.integration_delete("github").unwrap());
        assert!(!store.integration_delete("github").unwrap());
        assert!(store.integration_get("linear").unwrap().is_some());
    }

    #[test]
    fn previous_schema_fixture_migrates() {
        use crate::db::MIGRATION_LIST;
        use rusqlite_migration::Migrations;
        let tmp = tempfile::tempdir().unwrap();
        let dirs = DataDirs::from_root(tmp.path());
        {
            // Every migration before integrations (0013, the 12th in the list).
            let old = Migrations::from_slice(&MIGRATION_LIST[..11]);
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            assert_eq!(store.schema_version().unwrap(), 11);
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), crate::db::SCHEMA_VERSION);
        store
            .integration_upsert("github", "octo", "42", "repo", "octo")
            .unwrap();
        assert!(store.integration_get("github").unwrap().is_some());
    }
}
