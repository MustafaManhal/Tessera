//! Durable agent lifecycle. Session changes and status timeline entries commit together.
//! Empty pane_session_id means the frontend has not attached a PTY yet (the schema is NOT NULL).
use crate::{Store, StoreError, agents::now_millis, repositories::new_id};
use rusqlite::{OptionalExtension, params};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSession {
    pub id: String,
    pub task_id: Option<String>,
    pub pane_session_id: String,
    pub pane_id: Option<String>,
    pub agent_id: String,
    pub profile_id: String,
    pub status: String,
    pub status_source: String,
    pub status_at: i64,
    /// The latest hook message, OSC text or matched screen line behind the status.
    pub status_message: Option<String>,
    pub exit_code: Option<i32>,
    pub prompt: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub external_session_id: Option<String>,
    pub launch_cwd: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentEvent {
    pub id: String,
    pub agent_session_id: String,
    pub kind: String,
    pub payload: String,
    pub at: i64,
}
pub struct AgentSessions<'a>(&'a Store);
impl Store {
    pub fn agent_sessions(&self) -> AgentSessions<'_> {
        AgentSessions(self)
    }
}
const SELECT: &str = "SELECT id,task_id,pane_session_id,pane_id,agent_id,COALESCE(profile_id,''),status,status_source,status_at,status_message,exit_code,prompt,started_at,ended_at,NULL,NULL FROM agent_sessions";
/// Schema 6 and older have no `status_message` column; migration fixtures open those versions directly.
const SELECT_LEGACY: &str = "SELECT id,task_id,pane_session_id,pane_id,agent_id,COALESCE(profile_id,''),status,status_source,status_at,NULL AS status_message,exit_code,prompt,started_at,ended_at,NULL,NULL FROM agent_sessions";
const SELECT_RESUME: &str = "SELECT id,task_id,pane_session_id,pane_id,agent_id,COALESCE(profile_id,''),status,status_source,status_at,status_message,exit_code,prompt,started_at,ended_at,external_session_id,launch_cwd FROM agent_sessions";
impl AgentSessions<'_> {
    fn select(&self) -> &str {
        if self
            .0
            .conn
            .prepare("SELECT launch_cwd FROM agent_sessions LIMIT 0")
            .is_ok()
        {
            SELECT_RESUME
        } else if self.0.schema_version().unwrap_or(0) >= 7 {
            SELECT
        } else {
            SELECT_LEGACY
        }
    }
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSession> {
        Ok(AgentSession {
            id: row.get(0)?,
            task_id: row.get(1)?,
            pane_session_id: row.get(2)?,
            pane_id: row.get(3)?,
            agent_id: row.get(4)?,
            profile_id: row.get(5)?,
            status: row.get(6)?,
            status_source: row.get(7)?,
            status_at: row.get(8)?,
            status_message: row.get(9)?,
            exit_code: row.get(10)?,
            prompt: row.get(11)?,
            started_at: row.get(12)?,
            ended_at: row.get(13)?,
            external_session_id: row.get(14)?,
            launch_cwd: row.get(15)?,
        })
    }
    pub fn set_external_session_id(&self, id: &str, external: &str) -> Result<(), StoreError> {
        if !external.is_empty() && external.len() <= 512 && !external.chars().any(char::is_control) {
            self.0.conn.execute(
                "UPDATE agent_sessions SET external_session_id=?2 WHERE id=?1",
                params![id, external],
            )?;
        }
        Ok(())
    }
    pub fn set_launch_cwd(&self, id: &str, cwd: &str) -> Result<(), StoreError> {
        self.0
            .conn
            .execute("UPDATE agent_sessions SET launch_cwd=?2 WHERE id=?1", params![id, cwd])?;
        Ok(())
    }
    /// Initial starting state also has a timeline entry. No PTY is spawned here.
    pub fn create(
        &self,
        task_id: Option<&str>,
        agent_id: &str,
        profile_id: &str,
        prompt: Option<&str>,
    ) -> Result<AgentSession, StoreError> {
        let tx = self.0.conn.unchecked_transaction()?;
        let id = new_id();
        let at = now_millis();
        tx.execute("INSERT INTO agent_sessions(id,task_id,pane_session_id,agent_id,profile_id,status,status_source,status_at,prompt,started_at) VALUES(?1,?2,'',?3,?4,'starting','launch',?5,?6,?5)", params![id,task_id,agent_id,profile_id,at,prompt])?;
        Self::status_event(&tx, &id, "starting", "launch", None, at)?;
        tx.commit()?;
        Ok(self.get(&id)?.expect("created session"))
    }
    pub fn get(&self, id: &str) -> Result<Option<AgentSession>, StoreError> {
        Ok(self
            .0
            .conn
            .query_row(&format!("{} WHERE id=?1", self.select()), [id], Self::read)
            .optional()?)
    }
    /// Newest agent record bound to the PTY that submitted a hook.
    pub fn find_by_pane(&self, pane_session_id: &str) -> Result<Option<AgentSession>, StoreError> {
        Ok(self
            .0
            .conn
            .query_row(
                &format!(
                    "{} WHERE pane_session_id=?1 ORDER BY started_at DESC,rowid DESC LIMIT 1",
                    self.select()
                ),
                [pane_session_id],
                Self::read,
            )
            .optional()?)
    }
    pub fn list(&self, task_id: Option<&str>) -> Result<Vec<AgentSession>, StoreError> {
        let mut stmt = self.0.conn.prepare(&format!(
            "{} WHERE (?1 IS NULL OR task_id=?1) ORDER BY started_at DESC,rowid DESC",
            self.select()
        ))?;
        Ok(stmt.query_map([task_id], Self::read)?.collect::<Result<_, _>>()?)
    }
    /// Attach and transition atomically. A delayed attachment must never resurrect an exited session.
    pub fn set_pane_session(
        &self,
        id: &str,
        pane_session_id: &str,
        pane_id: &str,
        at: i64,
    ) -> Result<Option<AgentSession>, StoreError> {
        let tx = self.0.conn.unchecked_transaction()?;
        let Some(old) = self.get(id)? else {
            return Ok(None);
        };
        if old.ended_at.is_some() {
            return Ok(Some(old));
        }
        tx.execute("UPDATE agent_sessions SET pane_session_id=?2,pane_id=?3,status='starting',status_source='launch',status_at=?4 WHERE id=?1",params![id,pane_session_id,pane_id,at])?;
        tx.commit()?;
        self.get(id)
    }
    /// Generic status update for hook/OSC/pattern consumers. Repeated identical observations are no-ops.
    pub fn set_status(
        &self,
        id: &str,
        status: &str,
        source: &str,
        at: i64,
    ) -> Result<Option<AgentSession>, StoreError> {
        self.set_status_detail(id, status, source, None, None, at)
    }
    /// Status plus the message behind it. A status change writes a `status` timeline entry; a message-only change
    /// updates the column without one. `event` is the hook event name when the source is a hook.
    pub fn set_status_detail(
        &self,
        id: &str,
        status: &str,
        source: &str,
        message: Option<&str>,
        event: Option<&str>,
        at: i64,
    ) -> Result<Option<AgentSession>, StoreError> {
        let tx = self.0.conn.unchecked_transaction()?;
        let Some(old) = self.get(id)? else {
            return Ok(None);
        };
        if old.ended_at.is_some() {
            return Ok(Some(old));
        }
        let changed = old.status != status || old.status_source != source;
        let message_changed = message.is_some_and(|m| old.status_message.as_deref() != Some(m));
        if !changed && !message_changed {
            return Ok(Some(old));
        }
        if self.0.schema_version().unwrap_or(0) >= 7 {
            if changed {
                tx.execute(
                    "UPDATE agent_sessions SET status=?2,status_source=?3,status_at=?4,status_message=COALESCE(?5,status_message) WHERE id=?1",
                    params![id, status, source, at, message],
                )?;
                Self::status_event_full(&tx, id, Some(&old.status), status, source, None, event, at)?;
            } else {
                // Message-only change: status_at keeps marking the last status transition.
                tx.execute(
                    "UPDATE agent_sessions SET status_message=?2 WHERE id=?1",
                    params![id, message.unwrap()],
                )?;
            }
        } else if changed {
            tx.execute(
                "UPDATE agent_sessions SET status=?2,status_source=?3,status_at=?4 WHERE id=?1",
                params![id, status, source, at],
            )?;
            Self::status_event_full(&tx, id, Some(&old.status), status, source, None, event, at)?;
        }
        tx.commit()?;
        self.get(id)
    }
    /// First exit wins, including exit-before-attach and duplicate callbacks.
    pub fn mark_exited(&self, id: &str, exit_code: i32, at: i64) -> Result<Option<AgentSession>, StoreError> {
        let tx = self.0.conn.unchecked_transaction()?;
        let Some(old) = self.get(id)? else {
            return Ok(None);
        };
        if old.ended_at.is_some() {
            return Ok(Some(old));
        }
        let status = if exit_code == 0 { "exited" } else { "error" };
        tx.execute("UPDATE agent_sessions SET status=?2,status_source='exit',status_at=?3,exit_code=?4,ended_at=?3 WHERE id=?1",params![id,status,at,exit_code])?;
        Self::status_event(&tx, id, status, "exit", Some(exit_code), at)?;
        tx.commit()?;
        self.get(id)
    }
    /// Replace a session atomically. A failed insert cannot leave the old session exited.
    pub fn restart(&self, id: &str, at: i64) -> Result<Option<(AgentSession, AgentSession)>, StoreError> {
        let tx = self.0.conn.unchecked_transaction()?;
        let Some(old) = self.get(id)? else {
            return Ok(None);
        };
        let new_id = new_id();
        tx.execute("INSERT INTO agent_sessions(id,task_id,pane_session_id,agent_id,profile_id,status,status_source,status_at,prompt,started_at) VALUES(?1,?2,'',?3,?4,'starting','launch',?5,?6,?5)",params![new_id,old.task_id,old.agent_id,old.profile_id,at,old.prompt])?;
        if old.ended_at.is_none() {
            tx.execute("UPDATE agent_sessions SET status='exited',status_source='exit',status_at=?2,exit_code=0,ended_at=?2 WHERE id=?1",params![id,at])?;
            Self::status_event(&tx, id, "exited", "exit", Some(0), at)?;
        }
        Self::status_event(&tx, &new_id, "starting", "launch", None, at)?;
        tx.commit()?;
        Ok(Some((
            self.get(id)?.expect("existing session"),
            self.get(&new_id)?.expect("created session"),
        )))
    }
    pub fn append_event(&self, session_id: &str, kind: &str, payload: &str, at: i64) -> Result<AgentEvent, StoreError> {
        let valid: bool = self
            .0
            .conn
            .query_row("SELECT json_valid(?1)", [payload], |r| r.get(0))?;
        if !valid {
            return Err(StoreError::Database(rusqlite::Error::InvalidQuery));
        }
        let event = AgentEvent {
            id: new_id(),
            agent_session_id: session_id.into(),
            kind: kind.into(),
            payload: payload.into(),
            at,
        };
        self.0.conn.execute(
            "INSERT INTO agent_events(id,agent_session_id,kind,payload,at) VALUES(?1,?2,?3,?4,?5)",
            params![event.id, event.agent_session_id, event.kind, event.payload, event.at],
        )?;
        Ok(event)
    }
    pub fn events(&self, session_id: &str) -> Result<Vec<AgentEvent>, StoreError> {
        let mut stmt = self.0.conn.prepare(
            "SELECT id,agent_session_id,kind,payload,at FROM agent_events WHERE agent_session_id=?1 ORDER BY at,rowid",
        )?;
        Ok(stmt
            .query_map([session_id], |r| {
                Ok(AgentEvent {
                    id: r.get(0)?,
                    agent_session_id: r.get(1)?,
                    kind: r.get(2)?,
                    payload: r.get(3)?,
                    at: r.get(4)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }
    fn status_event(
        conn: &rusqlite::Connection,
        id: &str,
        status: &str,
        source: &str,
        code: Option<i32>,
        at: i64,
    ) -> Result<(), StoreError> {
        Self::status_event_full(conn, id, None, status, source, code, None, at)
    }
    /// `from`/`to` are the transition endpoints for engine-driven updates; `event` names the hook event.
    #[allow(clippy::too_many_arguments)]
    fn status_event_full(
        conn: &rusqlite::Connection,
        id: &str,
        from: Option<&str>,
        to: &str,
        source: &str,
        code: Option<i32>,
        event: Option<&str>,
        at: i64,
    ) -> Result<(), StoreError> {
        conn.execute("INSERT INTO agent_events(id,agent_session_id,kind,payload,at) VALUES(?1,?2,'status',json_object('status',?3,'from',?4,'source',?5,'exit_code',?6,'event',?7),?8)",params![new_id(),id,to,from,source,code,event,at])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store(tmp: &tempfile::TempDir) -> Store {
        let store = Store::open(&crate::DataDirs::from_root(tmp.path())).unwrap();
        store.agent_profiles().ensure_default("claude").unwrap();
        store
    }
    #[test]
    fn agent_session_lifecycle_timeline_and_idempotent_exit() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let profile = &store.agent_profiles().list(None).unwrap()[0].id;
        let repo = store.agent_sessions();
        let session = repo.create(None, "claude", profile, Some("hello")).unwrap();
        let at = session.started_at;
        assert_eq!(session.status, "starting");
        assert_eq!(session.pane_session_id, "");
        assert_eq!(repo.events(&session.id).unwrap().len(), 1);
        let attached = repo
            .set_pane_session(&session.id, "pty", "pane", at + 1)
            .unwrap()
            .unwrap();
        assert_eq!(
            attached.status, "starting",
            "a started agent is not working until it says so"
        );
        assert_eq!(attached.pane_id.as_deref(), Some("pane"));
        repo.set_status(&session.id, "needs_input", "pattern", at + 2).unwrap();
        repo.set_status(&session.id, "needs_input", "pattern", at + 3).unwrap();
        assert_eq!(repo.events(&session.id).unwrap().len(), 2);
        repo.append_event(&session.id, "notification", r#"{"message":"ready"}"#, at + 4)
            .unwrap();
        let exited = repo.mark_exited(&session.id, 7, at + 5).unwrap().unwrap();
        assert_eq!(exited.status, "error");
        assert_eq!(exited.exit_code, Some(7));
        assert_eq!(exited.ended_at, Some(at + 5));
        assert_eq!(repo.mark_exited(&session.id, 0, at + 6).unwrap(), Some(exited.clone()));
        assert_eq!(
            repo.set_pane_session(&session.id, "late", "late", at + 7).unwrap(),
            Some(exited.clone())
        );
        assert_eq!(
            repo.set_status(&session.id, "working", "hook", at + 8).unwrap(),
            Some(exited)
        );
        assert_eq!(repo.events(&session.id).unwrap().len(), 4);
        let events = repo.events(&session.id).unwrap();
        assert!(events.last().unwrap().payload.contains("error"));
        assert_eq!(events.last().unwrap().at, at + 5);
        assert!(repo.append_event(&session.id, "hook", "invalid json", at + 9).is_err());
        assert!(repo.mark_exited("missing", 0, at).unwrap().is_none());
    }
    #[test]
    fn agent_session_lists_are_filtered_newest_first_and_constraints_roll_back() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let profile = &store.agent_profiles().list(None).unwrap()[0].id;
        store
            .conn
            .execute(
                "INSERT INTO projects(id,name,path,default_branch) VALUES('p','p','/fixture','main')",
                [],
            )
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO tasks(id,project_id,name,slug,branch,base_branch) VALUES('t','p','t','t','t','main')",
                [],
            )
            .unwrap();
        let repo = store.agent_sessions();
        let mut a = repo.create(Some("t"), "claude", profile, None).unwrap();
        let mut b = repo.create(None, "claude", profile, None).unwrap();
        // Millisecond timestamps may tie; insertion order must still put the newest first.
        store
            .conn
            .execute("UPDATE agent_sessions SET started_at=1000", [])
            .unwrap();
        a.started_at = 1000;
        b.started_at = 1000;
        assert_eq!(
            repo.list(None)
                .unwrap()
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            [b.id.as_str(), a.id.as_str()]
        );
        assert_eq!(repo.list(Some("t")).unwrap().as_slice(), std::slice::from_ref(&a));
        assert!(repo.set_status(&a.id, "invalid", "hook", a.started_at + 1).is_err());
        assert_eq!(repo.events(&a.id).unwrap().len(), 1);
        let exit = repo.mark_exited(&b.id, 0, b.started_at + 1).unwrap().unwrap();
        assert_eq!(exit.status, "exited");
        assert!(repo.create(Some("missing"), "claude", profile, None).is_err());
        assert_eq!(repo.list(None).unwrap().len(), 2);
        store
            .conn
            .execute("DELETE FROM agent_sessions WHERE id=?1", [&a.id])
            .unwrap();
        assert!(repo.events(&a.id).unwrap().is_empty());
    }
}
