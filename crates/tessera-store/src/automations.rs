//! Automations (M9.5, FR-61): a prompt that starts an agent on a project on a schedule (cron, local time) or when a
//! GitHub issue gets a label. This module keeps the definitions, the run history and the cron arithmetic; the
//! scheduler that fires them lives in the desktop app.
use crate::{Store, StoreError, repositories::new_id};
use chrono::{DateTime, Local, TimeZone};
use croner::Cron;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, str::FromStr};

/// Runs kept per automation.
const KEEP_RUNS: i64 = 100;

#[derive(Debug, thiserror::Error)]
pub enum AutomationError {
    #[error("{0}")]
    Invalid(String),
    #[error("The automation could not be found.")]
    NotFound,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Trigger {
    /// Five-field cron expression in local time.
    Cron { expr: String },
    /// A GitHub issue of `repo` (`owner/name`) with `label`.
    Label { repo: String, label: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Automation {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub profile_id: String,
    pub prompt: String,
    pub trigger: Trigger,
    pub is_enabled: bool,
    pub next_run_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub task_id: Option<String>,
    /// `ok`, `failed` or `missed`.
    pub status: String,
    pub message: String,
    pub at: i64,
}

#[derive(Debug, Clone)]
pub struct AutomationInput {
    pub id: Option<String>,
    pub project_id: String,
    pub name: String,
    pub profile_id: String,
    pub prompt: String,
    pub trigger: Trigger,
    pub is_enabled: bool,
}

/// Seconds of the first time after `after` (unix seconds) that the five-field expression matches, in local time.
pub fn next_run_after(expr: &str, after: i64) -> Result<i64, AutomationError> {
    let cron = Cron::from_str(expr.trim())
        .map_err(|e| AutomationError::Invalid(format!("That is not a valid schedule: {e}")))?;
    let start: DateTime<Local> = Local
        .timestamp_opt(after, 0)
        .single()
        .ok_or_else(|| AutomationError::Invalid("That time does not exist.".into()))?;
    let next = cron
        .find_next_occurrence(&start, false)
        .map_err(|e| AutomationError::Invalid(format!("That schedule never runs: {e}")))?;
    Ok(next.timestamp())
}

fn validate(input: &AutomationInput) -> Result<(), AutomationError> {
    if input.name.trim().is_empty() {
        return Err(AutomationError::Invalid("Give the automation a name.".into()));
    }
    if input.prompt.trim().is_empty() {
        return Err(AutomationError::Invalid(
            "Write the prompt the agent should get.".into(),
        ));
    }
    if input.profile_id.trim().is_empty() {
        return Err(AutomationError::Invalid("Choose an agent profile.".into()));
    }
    match &input.trigger {
        Trigger::Cron { expr } => {
            if expr.split_whitespace().count() != 5 {
                return Err(AutomationError::Invalid(
                    "Use five fields: minute, hour, day of month, month, day of week.".into(),
                ));
            }
            next_run_after(expr, 0)?;
        }
        Trigger::Label { repo, label } => {
            let valid_repo = repo
                .split_once('/')
                .is_some_and(|(o, r)| !o.is_empty() && !r.is_empty() && !r.contains('/'));
            if !valid_repo {
                return Err(AutomationError::Invalid("Write the repository as owner/name.".into()));
            }
            if label.trim().is_empty() {
                return Err(AutomationError::Invalid("Write the label to watch.".into()));
            }
        }
    }
    Ok(())
}

pub struct Automations<'a>(&'a Store);

impl Store {
    pub fn automations(&self) -> Automations<'_> {
        Automations(self)
    }
}

const SELECT: &str =
    "SELECT id,project_id,name,profile_id,prompt,trigger,is_enabled,next_run_at,created_at FROM automations";

fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let trigger: String = row.get(5)?;
    Ok(Automation {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        profile_id: row.get(3)?,
        prompt: row.get(4)?,
        trigger: serde_json::from_str(&trigger).unwrap_or(Trigger::Cron {
            expr: "0 0 1 1 *".into(),
        }),
        is_enabled: row.get::<_, i64>(6)? != 0,
        next_run_at: row.get(7)?,
        created_at: row.get(8)?,
    })
}

impl Automations<'_> {
    /// Creates or updates an automation. Cron ones get their next run from `now`.
    pub fn save(&self, input: AutomationInput, now: i64) -> Result<Automation, AutomationError> {
        validate(&input)?;
        let conn = &self.0.conn;
        let project_exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id=?1", [&input.project_id], |_| Ok(true))
            .optional()?
            .unwrap_or(false);
        if !project_exists {
            return Err(AutomationError::Invalid("The project could not be found.".into()));
        }
        let next = match (&input.trigger, input.is_enabled) {
            (Trigger::Cron { expr }, true) => Some(next_run_after(expr, now)?),
            _ => None,
        };
        let trigger = serde_json::to_string(&input.trigger).map_err(|e| AutomationError::Invalid(e.to_string()))?;
        let id = match input.id {
            Some(id) => {
                let changed = conn.execute(
                    "UPDATE automations SET project_id=?2,name=?3,profile_id=?4,prompt=?5,trigger=?6,is_enabled=?7,next_run_at=?8 WHERE id=?1",
                    params![id, input.project_id, input.name.trim(), input.profile_id, input.prompt, trigger, i64::from(input.is_enabled), next],
                )?;
                if changed == 0 {
                    return Err(AutomationError::NotFound);
                }
                id
            }
            None => {
                let id = new_id();
                conn.execute(
                    "INSERT INTO automations (id,project_id,name,profile_id,prompt,trigger,is_enabled,next_run_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![id, input.project_id, input.name.trim(), input.profile_id, input.prompt, trigger, i64::from(input.is_enabled), next, now],
                )?;
                id
            }
        };
        self.get(&id)?.ok_or(AutomationError::NotFound)
    }

    pub fn get(&self, id: &str) -> Result<Option<Automation>, AutomationError> {
        Ok(self
            .0
            .conn
            .query_row(&format!("{SELECT} WHERE id=?1"), [id], read)
            .optional()?)
    }

    pub fn list(&self) -> Result<Vec<Automation>, AutomationError> {
        let mut statement = self.0.conn.prepare(&format!("{SELECT} ORDER BY created_at, id"))?;
        Ok(statement.query_map([], read)?.collect::<Result<_, _>>()?)
    }

    pub fn delete(&self, id: &str) -> Result<bool, AutomationError> {
        Ok(self.0.conn.execute("DELETE FROM automations WHERE id=?1", [id])? > 0)
    }

    /// Enabled cron automations whose next run is at or before `now`.
    pub fn due(&self, now: i64) -> Result<Vec<Automation>, AutomationError> {
        let mut statement = self.0.conn.prepare(&format!(
            "{SELECT} WHERE is_enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?1 ORDER BY next_run_at"
        ))?;
        Ok(statement.query_map([now], read)?.collect::<Result<_, _>>()?)
    }

    /// Enabled label automations, for the issue poller.
    pub fn label_watchers(&self) -> Result<Vec<Automation>, AutomationError> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|a| a.is_enabled && matches!(a.trigger, Trigger::Label { .. }))
            .collect())
    }

    pub fn set_next_run(&self, id: &str, next: Option<i64>) -> Result<(), AutomationError> {
        self.0
            .conn
            .execute("UPDATE automations SET next_run_at=?2 WHERE id=?1", params![id, next])?;
        Ok(())
    }

    /// Appends a run and drops the oldest beyond the keep limit.
    pub fn add_run(
        &self,
        automation_id: &str,
        task_id: Option<&str>,
        status: &str,
        message: &str,
        at: i64,
    ) -> Result<AutomationRun, AutomationError> {
        let id = new_id();
        let conn = &self.0.conn;
        conn.execute(
            "INSERT INTO automation_runs (id,automation_id,task_id,status,message,at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![id, automation_id, task_id, status, message, at],
        )?;
        conn.execute(
            "DELETE FROM automation_runs WHERE automation_id=?1 AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id=?1 ORDER BY at DESC, rowid DESC LIMIT ?2)",
            params![automation_id, KEEP_RUNS],
        )?;
        Ok(AutomationRun {
            id,
            automation_id: automation_id.into(),
            task_id: task_id.map(str::to_owned),
            status: status.into(),
            message: message.into(),
            at,
        })
    }

    pub fn runs(&self, automation_id: &str, limit: i64) -> Result<Vec<AutomationRun>, AutomationError> {
        let mut statement = self.0.conn.prepare(
            "SELECT id,automation_id,task_id,status,message,at FROM automation_runs WHERE automation_id=?1 ORDER BY at DESC, rowid DESC LIMIT ?2",
        )?;
        Ok(statement
            .query_map(params![automation_id, limit], |r| {
                Ok(AutomationRun {
                    id: r.get(0)?,
                    automation_id: r.get(1)?,
                    task_id: r.get(2)?,
                    status: r.get(3)?,
                    message: r.get(4)?,
                    at: r.get(5)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    /// The newest run of every automation that has one.
    pub fn last_runs(&self) -> Result<HashMap<String, AutomationRun>, AutomationError> {
        let mut out = HashMap::new();
        for automation in self.list()? {
            if let Some(run) = self.runs(&automation.id, 1)?.into_iter().next() {
                out.insert(automation.id, run);
            }
        }
        Ok(out)
    }

    /// Run history that is "missed": runs recorded while the app was closed, newest first, across automations.
    pub fn missed_runs(&self, limit: i64) -> Result<Vec<AutomationRun>, AutomationError> {
        let mut statement = self.0.conn.prepare(
            "SELECT id,automation_id,task_id,status,message,at FROM automation_runs WHERE status='missed' ORDER BY at DESC, rowid DESC LIMIT ?1",
        )?;
        Ok(statement
            .query_map([limit], |r| {
                Ok(AutomationRun {
                    id: r.get(0)?,
                    automation_id: r.get(1)?,
                    task_id: r.get(2)?,
                    status: r.get(3)?,
                    message: r.get(4)?,
                    at: r.get(5)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DataDirs, db::SCHEMA_VERSION};

    fn store_with_project() -> (tempfile::TempDir, Store, String) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&DataDirs::from_root(tmp.path())).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let project = store
            .conn
            .execute(
                "INSERT INTO projects (id,name,path,default_branch) VALUES ('p1','P','/p','main')",
                [],
            )
            .map(|_| "p1".to_owned());
        let id = match project {
            Ok(id) => id,
            Err(e) => panic!("{e}"),
        };
        (tmp, store, id)
    }

    fn input(project: &str, trigger: Trigger) -> AutomationInput {
        AutomationInput {
            id: None,
            project_id: project.into(),
            name: "Nightly tests".into(),
            profile_id: "prof".into(),
            prompt: "Run the tests and fix failures".into(),
            trigger,
            is_enabled: true,
        }
    }

    #[test]
    fn cron_next_run_is_in_the_future_and_matches_the_minute() {
        let now = 1_700_000_000;
        let next = next_run_after("*/15 * * * *", now).unwrap();
        assert!(next > now && next - now <= 15 * 60);
        assert_eq!(next % 60, 0);
        assert!(next_run_after("not a cron", now).is_err());
        assert!(next_run_after("61 * * * *", now).is_err());
    }

    #[test]
    fn save_validates_and_round_trips_both_trigger_kinds() {
        let (_tmp, store, project) = store_with_project();
        let repo = store.automations();
        let cron = repo
            .save(
                input(
                    &project,
                    Trigger::Cron {
                        expr: "0 9 * * 1-5".into(),
                    },
                ),
                1_700_000_000,
            )
            .unwrap();
        assert!(cron.next_run_at.unwrap() > 1_700_000_000);
        assert_eq!(
            cron.trigger,
            Trigger::Cron {
                expr: "0 9 * * 1-5".into()
            }
        );
        let label = repo
            .save(
                input(
                    &project,
                    Trigger::Label {
                        repo: "o/r".into(),
                        label: "tessera".into(),
                    },
                ),
                1,
            )
            .unwrap();
        assert_eq!(label.next_run_at, None);
        assert_eq!(repo.label_watchers().unwrap().len(), 1);
        assert_eq!(repo.list().unwrap().len(), 2);

        for bad in [
            AutomationInput {
                name: " ".into(),
                ..input(
                    &project,
                    Trigger::Cron {
                        expr: "* * * * *".into(),
                    },
                )
            },
            AutomationInput {
                prompt: "".into(),
                ..input(
                    &project,
                    Trigger::Cron {
                        expr: "* * * * *".into(),
                    },
                )
            },
            AutomationInput {
                profile_id: "".into(),
                ..input(
                    &project,
                    Trigger::Cron {
                        expr: "* * * * *".into(),
                    },
                )
            },
            input(&project, Trigger::Cron { expr: "* * *".into() }),
            input(
                &project,
                Trigger::Cron {
                    expr: "99 * * * *".into(),
                },
            ),
            input(
                &project,
                Trigger::Label {
                    repo: "norepo".into(),
                    label: "x".into(),
                },
            ),
            input(
                &project,
                Trigger::Label {
                    repo: "o/r".into(),
                    label: " ".into(),
                },
            ),
            input(
                "missing",
                Trigger::Cron {
                    expr: "* * * * *".into(),
                },
            ),
        ] {
            assert!(matches!(repo.save(bad, 1), Err(AutomationError::Invalid(_))));
        }
    }

    #[test]
    fn disabling_clears_the_next_run_and_enabling_sets_it_again() {
        let (_tmp, store, project) = store_with_project();
        let repo = store.automations();
        let created = repo
            .save(
                input(
                    &project,
                    Trigger::Cron {
                        expr: "* * * * *".into(),
                    },
                ),
                1_700_000_000,
            )
            .unwrap();
        let off = repo
            .save(
                AutomationInput {
                    id: Some(created.id.clone()),
                    is_enabled: false,
                    ..input(
                        &project,
                        Trigger::Cron {
                            expr: "* * * * *".into(),
                        },
                    )
                },
                1_700_000_100,
            )
            .unwrap();
        assert_eq!(off.next_run_at, None);
        assert!(repo.due(i64::MAX).unwrap().is_empty());
        let on = repo
            .save(
                AutomationInput {
                    id: Some(created.id),
                    ..input(
                        &project,
                        Trigger::Cron {
                            expr: "* * * * *".into(),
                        },
                    )
                },
                1_700_000_100,
            )
            .unwrap();
        assert!(on.next_run_at.unwrap() > 1_700_000_100);
        assert!(matches!(
            repo.save(
                AutomationInput {
                    id: Some("none".into()),
                    ..input(
                        &project,
                        Trigger::Cron {
                            expr: "* * * * *".into()
                        }
                    )
                },
                1
            ),
            Err(AutomationError::NotFound)
        ));
    }

    #[test]
    fn due_returns_only_enabled_cron_automations_at_or_before_now() {
        let (_tmp, store, project) = store_with_project();
        let repo = store.automations();
        let a = repo
            .save(
                input(
                    &project,
                    Trigger::Cron {
                        expr: "* * * * *".into(),
                    },
                ),
                1_700_000_000,
            )
            .unwrap();
        let next = a.next_run_at.unwrap();
        assert!(repo.due(next - 1).unwrap().is_empty());
        assert_eq!(repo.due(next).unwrap().len(), 1);
        repo.set_next_run(&a.id, Some(next + 3600)).unwrap();
        assert!(repo.due(next).unwrap().is_empty());
    }

    #[test]
    fn runs_are_listed_newest_first_pruned_and_cascade_with_the_automation() {
        let (_tmp, store, project) = store_with_project();
        let repo = store.automations();
        let a = repo
            .save(
                input(
                    &project,
                    Trigger::Cron {
                        expr: "* * * * *".into(),
                    },
                ),
                1,
            )
            .unwrap();
        for n in 0..(KEEP_RUNS + 5) {
            repo.add_run(
                &a.id,
                None,
                if n == 3 { "missed" } else { "ok" },
                &format!("run {n}"),
                n,
            )
            .unwrap();
        }
        let runs = repo.runs(&a.id, 1000).unwrap();
        assert_eq!(runs.len() as i64, KEEP_RUNS);
        assert_eq!(runs[0].message, format!("run {}", KEEP_RUNS + 4));
        assert_eq!(repo.last_runs().unwrap()[&a.id].at, KEEP_RUNS + 4);
        // The oldest five were pruned, including the missed one at n = 3.
        assert!(repo.missed_runs(10).unwrap().is_empty());
        repo.add_run(&a.id, None, "missed", "closed", 9999).unwrap();
        assert_eq!(repo.missed_runs(10).unwrap().len(), 1);
        assert!(repo.delete(&a.id).unwrap());
        assert!(repo.runs(&a.id, 10).unwrap().is_empty());
    }
}
