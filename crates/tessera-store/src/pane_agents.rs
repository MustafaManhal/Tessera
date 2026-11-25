//! Agents typed into a shell pane, kept so a restored pane can continue the same conversation (migration 0018).
//!
//! Written the moment something is known (the agent starts, its conversation id is found), never only at quit, so a
//! crash or a killed app still leaves the record behind.
use crate::{Store, StoreError};
use rusqlite::{OptionalExtension, params};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneAgent {
    pub pane_id: String,
    pub agent_id: String,
    /// The program as typed (`claude`, `/opt/bin/claude`).
    pub program: String,
    pub cwd: String,
    /// The flags a resume keeps.
    pub flags: Vec<String>,
    pub external_session_id: Option<String>,
    /// False once the agent ended while the app watched (the user quit it): nothing to continue.
    pub running: bool,
    pub started_at: i64,
    pub updated_at: i64,
}

pub struct PaneAgents<'a>(&'a Store);
impl Store {
    pub fn pane_agents(&self) -> PaneAgents<'_> {
        PaneAgents(self)
    }
}

const SELECT: &str =
    "SELECT pane_id,agent_id,program,cwd,flags,external_session_id,running,started_at,updated_at FROM pane_agents";

fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<PaneAgent> {
    let flags: String = row.get(4)?;
    Ok(PaneAgent {
        pane_id: row.get(0)?,
        agent_id: row.get(1)?,
        program: row.get(2)?,
        cwd: row.get(3)?,
        flags: serde_json::from_str(&flags).unwrap_or_default(),
        external_session_id: row.get::<_, Option<String>>(5)?.filter(|id| !id.is_empty()),
        running: row.get::<_, i64>(6)? != 0,
        started_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

impl PaneAgents<'_> {
    /// Records an agent that just started in `pane_id`, replacing whatever ran there before.
    #[allow(clippy::too_many_arguments)]
    pub fn started(
        &self,
        pane_id: &str,
        agent_id: &str,
        program: &str,
        cwd: &str,
        flags: &[String],
        external_session_id: Option<&str>,
        at: i64,
    ) -> Result<PaneAgent, StoreError> {
        let flags = serde_json::to_string(flags).unwrap_or_else(|_| "[]".into());
        self.0.conn.execute(
            "INSERT INTO pane_agents(pane_id,agent_id,program,cwd,flags,external_session_id,running,started_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,1,?7,?7)
             ON CONFLICT(pane_id) DO UPDATE SET agent_id=?2,program=?3,cwd=?4,flags=?5,external_session_id=?6,
               running=1,started_at=?7,updated_at=?7",
            params![pane_id, agent_id, program, cwd, flags, external_session_id, at],
        )?;
        Ok(self.get(pane_id)?.expect("the row just written"))
    }

    pub fn get(&self, pane_id: &str) -> Result<Option<PaneAgent>, StoreError> {
        Ok(self
            .0
            .conn
            .query_row(&format!("{SELECT} WHERE pane_id=?1"), [pane_id], read)
            .optional()?)
    }

    /// Agents still running (or running when the app last stopped), oldest first.
    pub fn running(&self) -> Result<Vec<PaneAgent>, StoreError> {
        let mut stmt = self
            .0
            .conn
            .prepare(&format!("{SELECT} WHERE running=1 ORDER BY started_at, pane_id"))?;
        Ok(stmt.query_map([], read)?.collect::<Result<_, _>>()?)
    }

    /// Sets the conversation id. Returns whether it changed.
    pub fn set_external_session_id(&self, pane_id: &str, id: &str, at: i64) -> Result<bool, StoreError> {
        if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
            return Ok(false);
        }
        let changed = self.0.conn.execute(
            "UPDATE pane_agents SET external_session_id=?2,updated_at=?3
             WHERE pane_id=?1 AND COALESCE(external_session_id,'')<>?2",
            params![pane_id, id, at],
        )?;
        Ok(changed > 0)
    }

    /// The agent ended while the app watched (the user quit it): a restore will not continue it.
    pub fn ended(&self, pane_id: &str, at: i64) -> Result<(), StoreError> {
        self.0.conn.execute(
            "UPDATE pane_agents SET running=0,updated_at=?2 WHERE pane_id=?1",
            params![pane_id, at],
        )?;
        Ok(())
    }

    /// The pane was closed.
    pub fn forget(&self, pane_id: &str) -> Result<(), StoreError> {
        self.0
            .conn
            .execute("DELETE FROM pane_agents WHERE pane_id=?1", [pane_id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;

    #[test]
    fn a_pane_agent_lives_through_start_id_and_end() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&crate::DataDirs::from_root(tmp.path())).unwrap();
        let agents = store.pane_agents();
        let flags = vec!["--model".to_owned(), "opus".to_owned()];
        let row = agents
            .started("p1", "claude", "claude", "/w", &flags, None, 10)
            .unwrap();
        assert!(row.running);
        assert_eq!(row.flags, flags);
        assert_eq!(row.external_session_id, None);
        assert!(agents.set_external_session_id("p1", "abc", 11).unwrap());
        assert!(!agents.set_external_session_id("p1", "abc", 12).unwrap());
        assert_eq!(agents.running().unwrap().len(), 1);
        agents.ended("p1", 13).unwrap();
        assert!(agents.running().unwrap().is_empty());
        assert!(!agents.get("p1").unwrap().unwrap().running);
        // A new agent in the same pane replaces the old record.
        let again = agents
            .started("p1", "codex", "codex", "/w", &[], Some("x1"), 14)
            .unwrap();
        assert!(again.running);
        assert_eq!(again.external_session_id.as_deref(), Some("x1"));
        agents.forget("p1").unwrap();
        assert!(agents.get("p1").unwrap().is_none());
    }
}
