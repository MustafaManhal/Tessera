//! Best-of-N orchestration. Only newly created task records and their owned worktrees are rolled back.
use crate::{error::AppError, project_commands::with_store, project_types::Task, task_commands::reconcile_watchers};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;
use tessera_store::{
    Store,
    repositories::{TaskGroup, new_id, now_seconds},
    tasks::CreateTask,
};
#[derive(Debug, Clone, Deserialize, Type)]
pub struct TaskGroupInput {
    pub project_id: String,
    pub prompt: String,
    pub base_branch: String,
    pub name: Option<String>,
    pub profile_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Type)]
pub struct TaskGroupCreated {
    pub group_id: String,
    pub tasks: Vec<Task>,
}
#[derive(Debug, Clone, Serialize, Type, Event)]
#[tauri_specta(event_name = "task_group:changed")]
pub struct TaskGroupInfo {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub prompt: String,
    pub picked_task_id: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub created_at: i64,
}
impl From<TaskGroup> for TaskGroupInfo {
    fn from(g: TaskGroup) -> Self {
        Self {
            id: g.id,
            project_id: g.project_id.unwrap_or_default(),
            name: g.name.unwrap_or_default(),
            prompt: g.prompt.unwrap_or_default(),
            picked_task_id: g.picked_task_id,
            created_at: g.created_at.unwrap_or_default(),
        }
    }
}
fn create(store: &Store, input: TaskGroupInput) -> Result<TaskGroupCreated, AppError> {
    if store.projects().get(&input.project_id)?.is_none() {
        return Err(AppError::new("project.not_found", "The project could not be found."));
    }
    if input.profile_ids.is_empty() {
        return Err(AppError::new(
            "task.worktree_failed",
            "Choose at least one agent profile.",
        ));
    }
    let profiles = input
        .profile_ids
        .iter()
        .map(|id| {
            store
                .agent_profiles()
                .get(id)?
                .ok_or_else(|| AppError::new("agent.profile_not_found", "An agent profile could not be found."))
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let id = new_id();
    let name = input
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Task group".into());
    let base = tessera_git::slugify(&name);
    let budget = profiles
        .iter()
        .enumerate()
        .map(|(i, p)| 48usize.saturating_sub(format!("-{}-{}", p.agent_id, i + 1).chars().count()))
        .min()
        .unwrap_or(0);
    if budget == 0 {
        return Err(AppError::new(
            "task.worktree_failed",
            "The agent ID is too long for a task worktree name.",
        ));
    }
    let existing = store
        .tasks()
        .list()?
        .into_iter()
        .filter(|t| t.project_id.as_deref() == Some(input.project_id.as_str()))
        .map(|t| t.slug)
        .collect::<Vec<_>>();
    let mut number = 1usize;
    let slug = loop {
        let suffix = if number == 1 {
            String::new()
        } else {
            format!("-{number}")
        };
        let available = budget
            .checked_sub(suffix.len())
            .filter(|n| *n > 0)
            .ok_or_else(|| AppError::new("task.worktree_failed", "No unique group worktree name is available."))?;
        let candidate = format!(
            "{}{}",
            base.chars().take(available).collect::<String>().trim_end_matches('-'),
            suffix
        );
        if profiles.iter().enumerate().all(|(i, p)| {
            !existing
                .iter()
                .any(|slug| slug.eq_ignore_ascii_case(&format!("{candidate}-{}-{}", p.agent_id, i + 1)))
        }) {
            break candidate;
        }
        number += 1;
    };
    let group = TaskGroup {
        id: id.clone(),
        project_id: Some(input.project_id.clone()),
        name: Some(name),
        prompt: Some(input.prompt.clone()),
        picked_task_id: None,
        created_at: Some(now_seconds()),
    };
    let mut owned = Vec::new();
    let result: Result<TaskGroupCreated, AppError> = (|| {
        let mut tasks = Vec::new();
        for (index, profile) in profiles.iter().enumerate() {
            let suffix = format!("-{}-{}", profile.agent_id, index + 1);
            let budget = 48usize
                .checked_sub(suffix.chars().count())
                .filter(|n| *n > 0)
                .ok_or_else(|| {
                    AppError::new(
                        "task.worktree_failed",
                        "The agent ID is too long for a task worktree name.",
                    )
                })?;
            let task_name = format!(
                "{}{}",
                slug.chars().take(budget).collect::<String>().trim_end_matches('-'),
                suffix
            );
            let mut task = store
                .task_create_record(
                    CreateTask {
                        project_id: input.project_id.clone(),
                        name: Some(task_name),
                        prompt: Some(input.prompt.clone()),
                        base_branch: input.base_branch.clone(),
                        existing_branch: None,
                        branch_name: None,
                        use_main_checkout: false,
                        run_setup: false,
                    },
                    |task| {
                        if !owned.contains(&task.id) {
                            owned.push(task.id.clone());
                        }
                    },
                )
                .map_err(|e| {
                    let code = if e.code() == "task.branch_exists" || e.code() == "git.branch_exists" {
                        "task.branch_exists"
                    } else {
                        "task.worktree_failed"
                    };
                    AppError::new(code, e.to_string())
                })?;
            task.group_id = Some(id.clone());
            tasks.push(task);
        }
        store.task_groups().insert(&group)?;
        for task in &tasks {
            store.tasks().update(task)?;
        }
        Ok(TaskGroupCreated {
            group_id: id.clone(),
            tasks: tasks.into_iter().map(Into::into).collect(),
        })
    })();
    if let Err(error) = result {
        for task in owned.iter().rev() {
            store.task_delete_record(task, true, |_| {}).map_err(|cleanup| {
                AppError::new(
                    "task.worktree_failed",
                    format!("{}; rollback failed: {cleanup}", error.message),
                )
            })?;
            store.tasks().delete(task)?;
        }
        store.task_groups().delete(&id)?;
        return Err(error);
    }
    result
}
fn pick(store: &Store, group_id: &str, task_id: &str) -> Result<TaskGroupInfo, AppError> {
    let mut group = store
        .task_groups()
        .get(group_id)?
        .ok_or_else(|| AppError::new("task.not_found", "The task group could not be found."))?;
    let task = store
        .tasks()
        .get(task_id)?
        .ok_or_else(|| AppError::new("task.not_found", "The task could not be found."))?;
    if task.group_id.as_deref() != Some(group_id) {
        return Err(AppError::new(
            "task.not_found",
            "The task does not belong to this group.",
        ));
    }
    group.picked_task_id = Some(task_id.into());
    store.task_groups().update(&group)?;
    Ok(group.into())
}
#[tauri::command]
#[specta::specta]
pub async fn task_group_create(app: tauri::AppHandle, input: TaskGroupInput) -> Result<TaskGroupCreated, AppError> {
    let result = with_store(app.clone(), move |store| create(store, input)).await?;
    let id = result.group_id.clone();
    let info = with_store(app.clone(), move |store| {
        Ok(store
            .task_groups()
            .get(&id)?
            .ok_or_else(|| AppError::new("task.not_found", "The task group could not be found."))?
            .into())
    })
    .await?;
    let _ = TaskGroupInfo::emit(&info, &app);
    reconcile_watchers(&app);
    Ok(result)
}
#[tauri::command]
#[specta::specta]
pub async fn task_groups_list(
    app: tauri::AppHandle,
    project_id: Option<String>,
) -> Result<Vec<TaskGroupInfo>, AppError> {
    with_store(app, move |store| {
        Ok(store
            .task_groups()
            .list()?
            .into_iter()
            .filter(|g| project_id.as_ref().is_none_or(|id| g.project_id.as_ref() == Some(id)))
            .map(Into::into)
            .collect())
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn task_group_pick(
    app: tauri::AppHandle,
    group_id: String,
    task_id: String,
) -> Result<TaskGroupInfo, AppError> {
    let info = with_store(app.clone(), move |store| pick(store, &group_id, &task_id)).await?;
    let _ = info.emit(&app);
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, process::Command};
    fn git(path: &Path, args: &[&str]) {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(path)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    #[test]
    fn groups_create_worktrees_pick_members_and_rollback_third_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo with spaces");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "fixture@example.invalid"]);
        git(&repo, &["config", "user.name", "Fixture"]);
        git(&repo, &["commit", "--allow-empty", "-m", "fixture"]);
        let store = Store::open(&tessera_store::DataDirs::from_root(tmp.path().join("data"))).unwrap();
        let project = store.project_add_local(&repo, tmp.path()).unwrap();
        store.agent_profiles().ensure_default("claude").unwrap();
        let profile = store.agent_profiles().list(Some("claude")).unwrap()[0].id.clone();
        let input = |name: &str, n: usize| TaskGroupInput {
            project_id: project.id.clone(),
            prompt: "Same prompt".into(),
            base_branch: "main".into(),
            name: Some(name.into()),
            profile_ids: vec![profile.clone(); n],
        };
        let made = create(&store, input("Compare", 2)).unwrap();
        assert_eq!(made.tasks.len(), 2);
        for task in &made.tasks {
            assert!(Path::new(task.worktree_path.as_ref().unwrap()).is_dir());
            assert_eq!(task.group_id.as_deref(), Some(made.group_id.as_str()));
        }
        assert_eq!(
            pick(&store, &made.group_id, &made.tasks[0].id)
                .unwrap()
                .picked_task_id
                .as_deref(),
            Some(made.tasks[0].id.as_str())
        );
        let repeated = create(&store, input("Compare", 2)).unwrap();
        assert_eq!(repeated.tasks[0].slug, "compare-2-claude-1");
        assert_eq!(repeated.tasks[1].slug, "compare-2-claude-2");
        let long = create(&store, input(&"long".repeat(30), 1)).unwrap();
        assert!(long.tasks[0].slug.ends_with("-claude-1"));
        let mut missing = input("Missing", 1);
        missing.profile_ids = vec!["missing-profile".into()];
        assert_eq!(create(&store, missing).unwrap_err().code, "agent.profile_not_found");
        let mut missing = input("Missing", 1);
        missing.project_id = "missing-project".into();
        assert_eq!(create(&store, missing).unwrap_err().code, "project.not_found");
        let other = create(&store, input("Other", 1)).unwrap();
        assert!(pick(&store, &made.group_id, &other.tasks[0].id).is_err());
        git(&repo, &["branch", "tessera/collision-claude-3"]);
        let before = store.tasks().list().unwrap();
        assert!(create(&store, input("Collision", 3)).is_err());
        assert_eq!(store.tasks().list().unwrap(), before);
        let branches = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["branch", "--list", "tessera/collision*"])
            .output()
            .unwrap();
        let branches = String::from_utf8(branches.stdout).unwrap();
        assert!(!branches.contains("collision-claude-1"));
        assert!(!branches.contains("collision-claude-2"));
        assert!(branches.contains("collision-claude-3"));
    }
}
