//! Agent profile and detection persistence. JSON is validated by SQLite; app types
//! decode arrays/maps at the IPC boundary. Environment values must not contain secrets.
use crate::{Store, StoreError, repositories::new_id};
use rusqlite::{OptionalExtension, params};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfile {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub model: Option<String>,
    pub extra_args: String,
    pub env: String,
    pub skip_permissions: bool,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Debug, Clone)]
pub struct AgentProfileInput {
    pub id: Option<String>,
    pub agent_id: String,
    pub name: String,
    pub model: Option<String>,
    pub extra_args: String,
    pub env: String,
    pub skip_permissions: bool,
    pub is_default: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInstall {
    pub agent_id: String,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub detected_at: i64,
    pub hooks_state: String,
}
pub struct AgentProfiles<'a>(&'a Store);
impl Store {
    pub fn agent_profiles(&self) -> AgentProfiles<'_> {
        AgentProfiles(self)
    }
    pub fn agent_install_get(&self, id: &str) -> Result<Option<AgentInstall>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT agent_id,binary_path,version,detected_at,hooks_state FROM agent_installs WHERE agent_id=?1",
                [id],
                |r| {
                    Ok(AgentInstall {
                        agent_id: r.get(0)?,
                        binary_path: r.get(1)?,
                        version: r.get(2)?,
                        detected_at: r.get(3)?,
                        hooks_state: r.get(4)?,
                    })
                },
            )
            .optional()?)
    }
    pub fn agent_install_save(&self, install: &AgentInstall) -> Result<(), StoreError> {
        self.conn.execute("INSERT INTO agent_installs(agent_id,binary_path,version,detected_at,hooks_state) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(agent_id) DO UPDATE SET binary_path=excluded.binary_path,version=excluded.version,detected_at=excluded.detected_at,hooks_state=excluded.hooks_state", params![install.agent_id,install.binary_path,install.version,install.detected_at,install.hooks_state])?;
        Ok(())
    }
}
const SELECT: &str = "SELECT id,agent_id,name,model,extra_args,env,skip_permissions,is_default,created_at,updated_at FROM agent_profiles";
impl AgentProfiles<'_> {
    fn read(r: &rusqlite::Row<'_>) -> rusqlite::Result<AgentProfile> {
        Ok(AgentProfile {
            id: r.get(0)?,
            agent_id: r.get(1)?,
            name: r.get(2)?,
            model: r.get(3)?,
            extra_args: r.get(4)?,
            env: r.get(5)?,
            skip_permissions: r.get(6)?,
            is_default: r.get(7)?,
            created_at: r.get(8)?,
            updated_at: r.get(9)?,
        })
    }
    pub fn list(&self, agent_id: Option<&str>) -> Result<Vec<AgentProfile>, StoreError> {
        let mut stmt = self.0.conn.prepare(&format!(
            "{SELECT} WHERE (?1 IS NULL OR agent_id=?1) ORDER BY agent_id,is_default DESC,name,id"
        ))?;
        Ok(stmt.query_map([agent_id], Self::read)?.collect::<Result<_, _>>()?)
    }
    pub fn get(&self, id: &str) -> Result<Option<AgentProfile>, StoreError> {
        Ok(self
            .0
            .conn
            .query_row(&format!("{SELECT} WHERE id=?1"), [id], Self::read)
            .optional()?)
    }
    /// Saving an unknown supplied id is a missing update, never an implicit insert.
    /// A transaction clears other defaults and writes the row atomically.
    pub fn save(&self, input: AgentProfileInput) -> Result<Option<AgentProfile>, StoreError> {
        let transaction = self.0.conn.unchecked_transaction()?;
        let existing = match &input.id {
            Some(id) => {
                let row = self.get(id)?;
                if row.is_none() {
                    return Ok(None);
                }
                row
            }
            None => None,
        };
        let now = now_millis();
        let row = AgentProfile {
            id: input.id.unwrap_or_else(new_id),
            agent_id: input.agent_id,
            name: input.name,
            model: input.model,
            extra_args: input.extra_args,
            env: input.env,
            skip_permissions: input.skip_permissions,
            is_default: input.is_default,
            created_at: existing.map(|p| p.created_at).unwrap_or(now),
            updated_at: now,
        };
        // No serde_json dependency is needed in the store; SQLite's JSON API validates shape.
        let valid: bool = transaction.query_row("SELECT CASE WHEN json_valid(?1) AND json_valid(?2) THEN json_type(?1)='array' AND json_type(?2)='object' ELSE 0 END", params![row.extra_args,row.env], |r| r.get(0))?;
        if !valid {
            return Err(StoreError::Database(rusqlite::Error::InvalidQuery));
        }
        if row.is_default {
            transaction.execute(
                "UPDATE agent_profiles SET is_default=0,updated_at=?2 WHERE agent_id=?1 AND is_default=1 AND id<>?3",
                params![row.agent_id, now, row.id],
            )?;
        }
        transaction.execute("INSERT INTO agent_profiles(id,agent_id,name,model,extra_args,env,skip_permissions,is_default,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,name=excluded.name,model=excluded.model,extra_args=excluded.extra_args,env=excluded.env,skip_permissions=excluded.skip_permissions,is_default=excluded.is_default,updated_at=excluded.updated_at", params![row.id,row.agent_id,row.name,row.model,row.extra_args,row.env,row.skip_permissions,row.is_default,row.created_at,row.updated_at])?;
        transaction.commit()?;
        Ok(Some(row))
    }
    /// Inserts or replaces a profile with its own id, as another device synced it (sync, M11). Keeps this device's
    /// environment values, which never sync.
    pub fn import(&self, row: &AgentProfile) -> Result<(), StoreError> {
        let transaction = self.0.conn.unchecked_transaction()?;
        if row.is_default {
            transaction.execute(
                "UPDATE agent_profiles SET is_default=0 WHERE agent_id=?1 AND is_default=1 AND id<>?2",
                params![row.agent_id, row.id],
            )?;
        }
        transaction.execute(
            "INSERT INTO agent_profiles(id,agent_id,name,model,extra_args,env,skip_permissions,is_default,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,'{}',?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,name=excluded.name,model=excluded.model,
               extra_args=excluded.extra_args,skip_permissions=excluded.skip_permissions,is_default=excluded.is_default,
               updated_at=excluded.updated_at",
            params![
                row.id,
                row.agent_id,
                row.name,
                row.model,
                row.extra_args,
                row.skip_permissions,
                row.is_default,
                row.created_at,
                row.updated_at
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self.0.conn.execute("DELETE FROM agent_profiles WHERE id=?1", [id])? > 0)
    }
    /// Called only when an agent is first discovered installed. Does not override user profiles.
    pub fn ensure_default(&self, agent_id: &str) -> Result<(), StoreError> {
        if self.list(Some(agent_id))?.is_empty() {
            self.save(AgentProfileInput {
                id: None,
                agent_id: agent_id.into(),
                name: "Default".into(),
                model: None,
                extra_args: "[]".into(),
                env: "{}".into(),
                skip_permissions: false,
                is_default: true,
            })?;
        }
        Ok(())
    }
}
/// Schema timestamps are Unix milliseconds, UTC.
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(agent: &str) -> AgentProfileInput {
        AgentProfileInput {
            id: None,
            agent_id: agent.into(),
            name: "Custom".into(),
            model: None,
            extra_args: "[]".into(),
            env: "{}".into(),
            skip_permissions: false,
            is_default: true,
        }
    }
    #[test]
    fn profile_crud_defaults_are_per_agent() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&crate::DataDirs::from_root(tmp.path())).unwrap();
        let repo = store.agent_profiles();
        let a = repo.save(input("claude")).unwrap().unwrap();
        let b = repo.save(input("claude")).unwrap().unwrap();
        repo.save(input("codex")).unwrap();
        assert!(!repo.get(&a.id).unwrap().unwrap().is_default);
        assert!(repo.get(&b.id).unwrap().unwrap().is_default);
        assert_eq!(repo.list(None).unwrap().len(), 3);
        assert_eq!(repo.list(Some("claude")).unwrap().len(), 2);
        let mut update = input("claude");
        update.id = Some(a.id.clone());
        update.name = "Renamed".into();
        let changed = repo.save(update).unwrap().unwrap();
        assert_eq!(changed.created_at, a.created_at);
        assert_eq!(changed.name, "Renamed");
        assert!(!repo.get(&b.id).unwrap().unwrap().is_default);
        assert!(repo.delete(&a.id).unwrap());
        assert!(!repo.delete(&a.id).unwrap());
        assert!(repo.get(&a.id).unwrap().is_none());
        let mut missing = input("claude");
        missing.id = Some("missing".into());
        assert!(repo.save(missing).unwrap().is_none());
    }
    #[test]
    fn invalid_json_rolls_back_default_changes_and_defaults_are_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&crate::DataDirs::from_root(tmp.path())).unwrap();
        let repo = store.agent_profiles();
        repo.ensure_default("claude").unwrap();
        repo.ensure_default("claude").unwrap();
        assert_eq!(repo.list(None).unwrap().len(), 1);
        let mut bad = input("claude");
        bad.env = "[]".into();
        assert!(repo.save(bad).is_err());
        assert!(repo.list(None).unwrap()[0].is_default);
        let install = AgentInstall {
            agent_id: "claude".into(),
            binary_path: Some("/fixture/claude".into()),
            version: Some("1.2.3".into()),
            detected_at: 42,
            hooks_state: "none".into(),
        };
        store.agent_install_save(&install).unwrap();
        assert_eq!(store.agent_install_get("claude").unwrap(), Some(install));
    }
}
