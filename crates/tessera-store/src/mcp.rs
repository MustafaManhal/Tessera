//! Manager metadata only. Secret values must never enter these models or the database.
use crate::{
    Store,
    repositories::{new_id, now_seconds},
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub env_keys: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: String,
    pub body: String,
    #[serde(default)]
    pub install_targets: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Install {
    pub mcp_server_id: String,
    pub agent_id: String,
    pub config_path: String,
}
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
impl Server {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_name(&self.name) || !matches!(self.transport.as_str(), "stdio" | "http") {
            return Err("Use a name with letters, numbers, hyphens or underscores and a supported transport.".into());
        }
        if self.transport == "stdio" && (self.command.trim().is_empty() || self.command.contains(['\0', '\n', '\r'])) {
            return Err("A stdio command is required.".into());
        }
        if self.transport == "http" && !(self.url.starts_with("https://") || self.url.starts_with("http://")) {
            return Err("Use an absolute HTTP or HTTPS URL.".into());
        }
        if self.url.contains(['\0', '\n', '\r'])
            || self.args.iter().any(|v| v.contains('\0'))
            || self.env_keys.iter().any(|k| {
                k.is_empty()
                    || !k
                        .bytes()
                        .enumerate()
                        .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
            })
        {
            return Err("Check the URL, arguments and environment variable names.".into());
        }
        if self.args.len() > 128
            || self.env_keys.len() > 128
            || self.args.iter().map(String::len).sum::<usize>() > 65536
            || self.url.len() > 8192
        {
            return Err("The server definition is too large.".into());
        }
        Ok(())
    }
}
impl Store {
    pub fn mcp_list(&self) -> Result<Vec<Server>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,name,transport,command,args,url,env_keys FROM mcp_servers ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            let (id, name, transport, command, args, url, env_keys) = r.map_err(|e| e.to_string())?;
            Ok(Server {
                id,
                name,
                transport,
                command,
                args: serde_json::from_str(&args).map_err(|e| e.to_string())?,
                url,
                env_keys: serde_json::from_str(&env_keys).map_err(|e| e.to_string())?,
            })
        })
        .collect()
    }
    pub fn mcp_save(&self, mut row: Server) -> Result<Server, String> {
        row.validate()?;
        if row.id.is_empty() {
            row.id = new_id()
        } else if !self.mcp_list()?.iter().any(|r| r.id == row.id) {
            return Err("Server not found.".into());
        }
        self.conn.execute("INSERT INTO mcp_servers(id,name,transport,command,args,url,env_keys,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET name=excluded.name,transport=excluded.transport,command=excluded.command,args=excluded.args,url=excluded.url,env_keys=excluded.env_keys",params![row.id,row.name,row.transport,row.command,serde_json::to_string(&row.args).unwrap(),row.url,serde_json::to_string(&row.env_keys).unwrap(),now_seconds()]).map_err(|_|"Could not save server. Its name must be unique.".to_string())?;
        Ok(row)
    }
    pub fn mcp_delete(&self, id: &str) -> Result<(), String> {
        if self.mcp_installs()?.iter().any(|i| i.mcp_server_id == id) {
            return Err("Uninstall this server from its agent configs before deleting it.".into());
        }
        self.conn
            .execute("DELETE FROM mcp_servers WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn mcp_installs(&self) -> Result<Vec<Install>, String> {
        let mut s = self
            .conn
            .prepare("SELECT mcp_server_id,agent_id,config_path FROM mcp_installs")
            .map_err(|e| e.to_string())?;
        s.query_map([], |r| {
            Ok(Install {
                mcp_server_id: r.get(0)?,
                agent_id: r.get(1)?,
                config_path: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())
    }
    pub fn mcp_install_record(&self, i: &Install, remove: bool) -> Result<(), String> {
        if remove {
            self.conn.execute(
                "DELETE FROM mcp_installs WHERE mcp_server_id=?1 AND agent_id=?2 AND config_path=?3",
                params![i.mcp_server_id, i.agent_id, i.config_path],
            )
        } else {
            self.conn.execute(
                "INSERT OR REPLACE INTO mcp_installs VALUES(?1,?2,?3,?4)",
                params![i.mcp_server_id, i.agent_id, i.config_path, now_seconds()],
            )
        }
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn skills_list(&self) -> Result<Vec<Skill>, String> {
        let mut s = self
            .conn
            .prepare("SELECT id,name,kind,body,install_targets FROM skills ORDER BY name")
            .map_err(|e| e.to_string())?;
        s.query_map([], |r| {
            Ok(Skill {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                body: r.get(3)?,
                install_targets: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())
    }
    pub fn skill_save(&self, mut row: Skill) -> Result<Skill, String> {
        if !valid_name(&row.name)
            || !matches!(row.kind.as_str(), "agents_md" | "claude_skill" | "rules_file")
            || row.body.trim().is_empty()
            || row.body.len() > 262144
        {
            return Err("Use a valid name, supported kind and nonempty Markdown of at most 256 KiB.".into());
        }
        if row.id.is_empty() {
            row.id = new_id();
            row.install_targets.clear()
        } else {
            let old = self
                .skills_list()?
                .into_iter()
                .find(|r| r.id == row.id)
                .ok_or("Skill not found.")?;
            if !old.install_targets.is_empty() && (old.name != row.name || old.kind != row.kind) {
                return Err("Uninstall the skill before changing its name or kind.".into());
            }
            row.install_targets = old.install_targets;
        }
        self.conn.execute("INSERT INTO skills VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,body=excluded.body",params![row.id,row.name,row.kind,row.body,serde_json::to_string(&row.install_targets).unwrap()]).map_err(|e|e.to_string())?;
        Ok(row)
    }
    pub fn skill_targets(&self, id: &str, targets: &[String]) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE skills SET install_targets=?2 WHERE id=?1",
                params![id, serde_json::to_string(targets).unwrap()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn skill_delete(&self, id: &str) -> Result<(), String> {
        if self
            .skills_list()?
            .iter()
            .any(|s| s.id == id && !s.install_targets.is_empty())
        {
            return Err("Uninstall this skill before deleting it.".into());
        }
        self.conn
            .execute("DELETE FROM skills WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn previous_schema_migrates_and_metadata_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = crate::DataDirs::from_root(tmp.path());
        {
            let old = rusqlite_migration::Migrations::from_slice(
                &crate::db::MIGRATION_LIST[..crate::db::MIGRATION_LIST.len() - 1],
            );
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            store.kv_set("kept", "yes").unwrap();
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), crate::db::SCHEMA_VERSION);
        assert_eq!(store.kv_get("kept").unwrap().as_deref(), Some("yes"));
        let row = store
            .mcp_save(Server {
                id: "".into(),
                name: "fixture".into(),
                transport: "stdio".into(),
                command: "fixture".into(),
                args: vec![],
                url: "".into(),
                env_keys: vec!["TOKEN".into()],
            })
            .unwrap();
        assert_eq!(store.mcp_list().unwrap()[0].env_keys, ["TOKEN"]);
        let i = Install {
            mcp_server_id: row.id.clone(),
            agent_id: "claude".into(),
            config_path: "fixture.json".into(),
        };
        store.mcp_install_record(&i, false).unwrap();
        assert!(store.mcp_delete(&row.id).is_err());
        store.mcp_install_record(&i, true).unwrap();
        store.mcp_delete(&row.id).unwrap();
        assert!(store.mcp_list().unwrap().is_empty());
        let skill = store
            .skill_save(Skill {
                id: "".into(),
                name: "review".into(),
                kind: "agents_md".into(),
                body: "# Review".into(),
                install_targets: vec![],
            })
            .unwrap();
        assert_eq!(store.skills_list().unwrap()[0].body, "# Review");
        store.skill_delete(&skill.id).unwrap();
    }
}
