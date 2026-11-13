//! Typed persistence for projects, run scripts, groups and tasks.
use crate::{Store, StoreError};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

/// A new sortable identifier.
pub fn new_id() -> String {
    ulid::Ulid::generate().to_string()
}
/// Current Unix timestamp in seconds.
pub fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
/// Persisted Project record; nullable SQL columns remain optional.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Project {
    /// Database column `id`.
    pub id: String,
    /// Database column `name`.
    pub name: String,
    /// Database column `path`.
    pub path: String,
    /// Database column `remote_url`.
    pub remote_url: Option<String>,
    /// Database column `default_branch`.
    pub default_branch: String,
    /// Database column `worktree_dir`.
    pub worktree_dir: Option<String>,
    /// Database column `setup_script`.
    pub setup_script: Option<String>,
    /// Database column `setup_shell`.
    pub setup_shell: Option<String>,
    /// Database column `setup_approved_hash`.
    pub setup_approved_hash: Option<String>,
    /// Database column `copy_files`.
    pub copy_files: Option<String>,
    /// Database column `port_base`.
    pub port_base: Option<i64>,
    /// Database column `default_profile_id`.
    pub default_profile_id: Option<String>,
    /// Database column `is_muted`.
    pub is_muted: Option<i64>,
    /// Database column `sort`.
    pub sort: Option<i64>,
    /// Database column `ssh_host_id`.
    pub ssh_host_id: Option<String>,
    /// Database column `work_mode`: `worktrees` (tasks get their own worktree) or `branches` (tasks work on branches in the project folder).
    pub work_mode: String,
    /// Database column `created_at`.
    pub created_at: Option<i64>,
    /// Database column `updated_at`.
    pub updated_at: Option<i64>,
}
/// Typed `projects` repository borrowing a store.
pub struct ProjectRepo<'a>(&'a Store);
impl Store {
    /// Access typed projects persistence.
    pub fn projects(&self) -> ProjectRepo<'_> {
        ProjectRepo(self)
    }
}
impl ProjectRepo<'_> {
    /// Insert a record. SQLite enforces references and uniqueness.
    pub fn insert(&self, value: &Project) -> Result<(), StoreError> {
        self.0.conn.execute("INSERT INTO projects (id, name, path, remote_url, default_branch, worktree_dir, setup_script, setup_shell, setup_approved_hash, copy_files, port_base, default_profile_id, is_muted, sort, ssh_host_id, created_at, updated_at, work_mode) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)", params![value.id, value.name, value.path, value.remote_url, value.default_branch, value.worktree_dir, value.setup_script, value.setup_shell, value.setup_approved_hash, value.copy_files, value.port_base, value.default_profile_id, value.is_muted, value.sort, value.ssh_host_id, value.created_at, value.updated_at, value.work_mode])?;
        Ok(())
    }
    /// Fetch a record by identifier.
    pub fn get(&self, id: &str) -> Result<Option<Project>, StoreError> {
        Ok(self.0.conn.query_row("SELECT id, name, path, remote_url, default_branch, worktree_dir, setup_script, setup_shell, setup_approved_hash, copy_files, port_base, default_profile_id, is_muted, sort, ssh_host_id, created_at, updated_at, work_mode FROM projects WHERE id=?1", [id], Self::read).optional()?)
    }
    /// List records in identifier order.
    pub fn list(&self) -> Result<Vec<Project>, StoreError> {
        let mut statement = self.0.conn.prepare("SELECT id, name, path, remote_url, default_branch, worktree_dir, setup_script, setup_shell, setup_approved_hash, copy_files, port_base, default_profile_id, is_muted, sort, ssh_host_id, created_at, updated_at, work_mode FROM projects ORDER BY id")?;
        Ok(statement.query_map([], Self::read)?.collect::<Result<Vec<_>, _>>()?)
    }
    /// Update an existing record, returning whether it existed.
    pub fn update(&self, value: &Project) -> Result<bool, StoreError> {
        Ok(self.0.conn.execute("UPDATE projects SET name=?2, path=?3, remote_url=?4, default_branch=?5, worktree_dir=?6, setup_script=?7, setup_shell=?8, setup_approved_hash=?9, copy_files=?10, port_base=?11, default_profile_id=?12, is_muted=?13, sort=?14, ssh_host_id=?15, created_at=?16, updated_at=?17, work_mode=?18 WHERE id=?1", params![value.id, value.name, value.path, value.remote_url, value.default_branch, value.worktree_dir, value.setup_script, value.setup_shell, value.setup_approved_hash, value.copy_files, value.port_base, value.default_profile_id, value.is_muted, value.sort, value.ssh_host_id, value.created_at, value.updated_at, value.work_mode])? > 0)
    }
    /// Delete a record; foreign-key restrictions and cascades apply.
    pub fn delete(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self.0.conn.execute("DELETE FROM projects WHERE id=?1", [id])? > 0)
    }
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            remote_url: row.get(3)?,
            default_branch: row.get(4)?,
            worktree_dir: row.get(5)?,
            setup_script: row.get(6)?,
            setup_shell: row.get(7)?,
            setup_approved_hash: row.get(8)?,
            copy_files: row.get(9)?,
            port_base: row.get(10)?,
            default_profile_id: row.get(11)?,
            is_muted: row.get(12)?,
            sort: row.get(13)?,
            ssh_host_id: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
            work_mode: row.get(17)?,
        })
    }
}
/// Persisted RunScript record; nullable SQL columns remain optional.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunScript {
    /// Database column `id`.
    pub id: String,
    /// Database column `project_id`.
    pub project_id: Option<String>,
    /// Database column `name`.
    pub name: Option<String>,
    /// Database column `command`.
    pub command: Option<String>,
    /// Database column `auto_start`.
    pub auto_start: Option<i64>,
    /// Database column `sort`.
    pub sort: Option<i64>,
}
/// Typed `run_scripts` repository borrowing a store.
pub struct RunScriptRepo<'a>(&'a Store);
impl Store {
    /// Access typed run_scripts persistence.
    pub fn run_scripts(&self) -> RunScriptRepo<'_> {
        RunScriptRepo(self)
    }
}
impl RunScriptRepo<'_> {
    /// Insert a record. SQLite enforces references and uniqueness.
    pub fn insert(&self, value: &RunScript) -> Result<(), StoreError> {
        self.0.conn.execute(
            "INSERT INTO run_scripts (id, project_id, name, command, auto_start, sort) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                value.id,
                value.project_id,
                value.name,
                value.command,
                value.auto_start,
                value.sort
            ],
        )?;
        Ok(())
    }
    /// Fetch a record by identifier.
    pub fn get(&self, id: &str) -> Result<Option<RunScript>, StoreError> {
        Ok(self
            .0
            .conn
            .query_row(
                "SELECT id, project_id, name, command, auto_start, sort FROM run_scripts WHERE id=?1",
                [id],
                Self::read,
            )
            .optional()?)
    }
    /// List records in identifier order.
    pub fn list(&self) -> Result<Vec<RunScript>, StoreError> {
        let mut statement = self
            .0
            .conn
            .prepare("SELECT id, project_id, name, command, auto_start, sort FROM run_scripts ORDER BY id")?;
        Ok(statement.query_map([], Self::read)?.collect::<Result<Vec<_>, _>>()?)
    }
    /// Update an existing record, returning whether it existed.
    pub fn update(&self, value: &RunScript) -> Result<bool, StoreError> {
        Ok(self.0.conn.execute(
            "UPDATE run_scripts SET project_id=?2, name=?3, command=?4, auto_start=?5, sort=?6 WHERE id=?1",
            params![
                value.id,
                value.project_id,
                value.name,
                value.command,
                value.auto_start,
                value.sort
            ],
        )? > 0)
    }
    /// Delete a record; foreign-key restrictions and cascades apply.
    pub fn delete(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self.0.conn.execute("DELETE FROM run_scripts WHERE id=?1", [id])? > 0)
    }
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunScript> {
        Ok(RunScript {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            command: row.get(3)?,
            auto_start: row.get(4)?,
            sort: row.get(5)?,
        })
    }
}
/// Persisted TaskGroup record; nullable SQL columns remain optional.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskGroup {
    /// Database column `id`.
    pub id: String,
    /// Database column `project_id`.
    pub project_id: Option<String>,
    /// Database column `name`.
    pub name: Option<String>,
    /// Database column `prompt`.
    pub prompt: Option<String>,
    /// Database column `picked_task_id`.
    pub picked_task_id: Option<String>,
    /// Database column `created_at`.
    pub created_at: Option<i64>,
}
/// Typed `task_groups` repository borrowing a store.
pub struct TaskGroupRepo<'a>(&'a Store);
impl Store {
    /// Access typed task_groups persistence.
    pub fn task_groups(&self) -> TaskGroupRepo<'_> {
        TaskGroupRepo(self)
    }
}
impl TaskGroupRepo<'_> {
    /// Insert a record. SQLite enforces references and uniqueness.
    pub fn insert(&self, value: &TaskGroup) -> Result<(), StoreError> {
        self.0.conn.execute("INSERT INTO task_groups (id, project_id, name, prompt, picked_task_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![value.id, value.project_id, value.name, value.prompt, value.picked_task_id, value.created_at])?;
        Ok(())
    }
    /// Fetch a record by identifier.
    pub fn get(&self, id: &str) -> Result<Option<TaskGroup>, StoreError> {
        Ok(self
            .0
            .conn
            .query_row(
                "SELECT id, project_id, name, prompt, picked_task_id, created_at FROM task_groups WHERE id=?1",
                [id],
                Self::read,
            )
            .optional()?)
    }
    /// List records in identifier order.
    pub fn list(&self) -> Result<Vec<TaskGroup>, StoreError> {
        let mut statement = self
            .0
            .conn
            .prepare("SELECT id, project_id, name, prompt, picked_task_id, created_at FROM task_groups ORDER BY id")?;
        Ok(statement.query_map([], Self::read)?.collect::<Result<Vec<_>, _>>()?)
    }
    /// Update an existing record, returning whether it existed.
    pub fn update(&self, value: &TaskGroup) -> Result<bool, StoreError> {
        Ok(self.0.conn.execute(
            "UPDATE task_groups SET project_id=?2, name=?3, prompt=?4, picked_task_id=?5, created_at=?6 WHERE id=?1",
            params![
                value.id,
                value.project_id,
                value.name,
                value.prompt,
                value.picked_task_id,
                value.created_at
            ],
        )? > 0)
    }
    /// Delete a record; foreign-key restrictions and cascades apply.
    pub fn delete(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self.0.conn.execute("DELETE FROM task_groups WHERE id=?1", [id])? > 0)
    }
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskGroup> {
        Ok(TaskGroup {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            prompt: row.get(3)?,
            picked_task_id: row.get(4)?,
            created_at: row.get(5)?,
        })
    }
}
/// Persisted Task record; nullable SQL columns remain optional.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Task {
    /// Database column `id`.
    pub id: String,
    /// Database column `project_id`.
    pub project_id: Option<String>,
    /// Database column `group_id`.
    pub group_id: Option<String>,
    /// Database column `name`.
    pub name: String,
    /// Database column `slug`.
    pub slug: String,
    /// Database column `branch`.
    pub branch: String,
    /// Database column `base_branch`.
    pub base_branch: String,
    /// Database column `worktree_path`.
    pub worktree_path: Option<String>,
    /// Database column `uses_main_checkout`.
    pub uses_main_checkout: Option<i64>,
    /// Database column `board_column`.
    pub board_column: Option<String>,
    /// Database column `state`.
    pub state: Option<String>,
    /// Database column `prompt`.
    pub prompt: Option<String>,
    /// Database column `issue_ref`.
    pub issue_ref: Option<String>,
    /// Database column `port_start`.
    pub port_start: Option<i64>,
    /// Database column `port_count`.
    pub port_count: Option<i64>,
    /// Database column `pr_number`.
    pub pr_number: Option<i64>,
    /// Database column `pr_url`.
    pub pr_url: Option<String>,
    /// Database column `pr_state`.
    pub pr_state: Option<String>,
    /// Database column `ci_state`.
    pub ci_state: Option<String>,
    /// Database column `last_message`.
    pub last_message: Option<String>,
    /// Database column `tags`.
    pub tags: Option<String>,
    /// Database column `created_at`.
    pub created_at: Option<i64>,
    /// Database column `updated_at`.
    pub updated_at: Option<i64>,
    /// Database column `archived_at`.
    pub archived_at: Option<i64>,
}
/// Typed `tasks` repository borrowing a store.
pub struct TaskRepo<'a>(&'a Store);
impl Store {
    /// Access typed tasks persistence.
    pub fn tasks(&self) -> TaskRepo<'_> {
        TaskRepo(self)
    }
}
impl TaskRepo<'_> {
    /// Insert a record. SQLite enforces references and uniqueness.
    pub fn insert(&self, value: &Task) -> Result<(), StoreError> {
        self.0.conn.execute("INSERT INTO tasks (id, project_id, group_id, name, slug, branch, base_branch, worktree_path, uses_main_checkout, board_column, state, prompt, issue_ref, port_start, port_count, pr_number, pr_url, pr_state, ci_state, last_message, tags, created_at, updated_at, archived_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)", params![value.id, value.project_id, value.group_id, value.name, value.slug, value.branch, value.base_branch, value.worktree_path, value.uses_main_checkout, value.board_column, value.state, value.prompt, value.issue_ref, value.port_start, value.port_count, value.pr_number, value.pr_url, value.pr_state, value.ci_state, value.last_message, value.tags, value.created_at, value.updated_at, value.archived_at])?;
        Ok(())
    }
    /// Fetch a record by identifier.
    pub fn get(&self, id: &str) -> Result<Option<Task>, StoreError> {
        Ok(self.0.conn.query_row("SELECT id, project_id, group_id, name, slug, branch, base_branch, worktree_path, uses_main_checkout, board_column, state, prompt, issue_ref, port_start, port_count, pr_number, pr_url, pr_state, ci_state, last_message, tags, created_at, updated_at, archived_at FROM tasks WHERE id=?1", [id], Self::read).optional()?)
    }
    /// List records in identifier order.
    pub fn list(&self) -> Result<Vec<Task>, StoreError> {
        let mut statement = self.0.conn.prepare("SELECT id, project_id, group_id, name, slug, branch, base_branch, worktree_path, uses_main_checkout, board_column, state, prompt, issue_ref, port_start, port_count, pr_number, pr_url, pr_state, ci_state, last_message, tags, created_at, updated_at, archived_at FROM tasks ORDER BY id")?;
        Ok(statement.query_map([], Self::read)?.collect::<Result<Vec<_>, _>>()?)
    }
    /// Update an existing record, returning whether it existed.
    pub fn update(&self, value: &Task) -> Result<bool, StoreError> {
        Ok(self.0.conn.execute("UPDATE tasks SET project_id=?2, group_id=?3, name=?4, slug=?5, branch=?6, base_branch=?7, worktree_path=?8, uses_main_checkout=?9, board_column=?10, state=?11, prompt=?12, issue_ref=?13, port_start=?14, port_count=?15, pr_number=?16, pr_url=?17, pr_state=?18, ci_state=?19, last_message=?20, tags=?21, created_at=?22, updated_at=?23, archived_at=?24 WHERE id=?1", params![value.id, value.project_id, value.group_id, value.name, value.slug, value.branch, value.base_branch, value.worktree_path, value.uses_main_checkout, value.board_column, value.state, value.prompt, value.issue_ref, value.port_start, value.port_count, value.pr_number, value.pr_url, value.pr_state, value.ci_state, value.last_message, value.tags, value.created_at, value.updated_at, value.archived_at])? > 0)
    }
    /// Delete a record; foreign-key restrictions and cascades apply.
    pub fn delete(&self, id: &str) -> Result<bool, StoreError> {
        // Agent sessions point at their task without a cascade; remove them first so the delete cannot fail.
        self.0
            .conn
            .execute("DELETE FROM agent_sessions WHERE task_id=?1", [id])?;
        Ok(self.0.conn.execute("DELETE FROM tasks WHERE id=?1", [id])? > 0)
    }
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            group_id: row.get(2)?,
            name: row.get(3)?,
            slug: row.get(4)?,
            branch: row.get(5)?,
            base_branch: row.get(6)?,
            worktree_path: row.get(7)?,
            uses_main_checkout: row.get(8)?,
            board_column: row.get(9)?,
            state: row.get(10)?,
            prompt: row.get(11)?,
            issue_ref: row.get(12)?,
            port_start: row.get(13)?,
            port_count: row.get(14)?,
            pr_number: row.get(15)?,
            pr_url: row.get(16)?,
            pr_state: row.get(17)?,
            ci_state: row.get(18)?,
            last_message: row.get(19)?,
            tags: row.get(20)?,
            created_at: row.get(21)?,
            updated_at: row.get(22)?,
            archived_at: row.get(23)?,
        })
    }
}
