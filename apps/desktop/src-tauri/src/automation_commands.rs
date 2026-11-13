//! Automations (M9.5, FR-61): definitions, run history and the scheduler. A background thread checks every 20 s for
//! cron automations that are due and every 5 minutes for new GitHub issues carrying a watched label. A run creates a
//! task on the project and tells the front end (`automation:fired`) to start the profile's agent in it, so the agent
//! pane is an ordinary one the user can watch. A run that is more than 5 minutes late (the app was closed) is
//! recorded as "missed" and not executed.
use crate::{
    error::AppError,
    issue_commands::{github_api, github_token},
    project_commands::with_store,
    state::AppState,
    task_commands,
};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{path::Path, time::Duration};
use tauri::Manager;
use tauri_specta::Event;
use tessera_forge::{ForgeError, issues};
use tessera_store::{
    Store,
    automations::{Automation, AutomationError, AutomationInput, AutomationRun, Trigger, next_run_after},
    repositories::now_seconds,
    tasks::CreateTask,
};

const TICK: Duration = Duration::from_secs(20);
const LABEL_POLL_SECS: i64 = 300;
/// A cron run later than this was missed, not late.
const GRACE_SECS: i64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TriggerInfo {
    Cron { expr: String },
    Label { repo: String, label: String },
}
impl From<Trigger> for TriggerInfo {
    fn from(t: Trigger) -> Self {
        match t {
            Trigger::Cron { expr } => Self::Cron { expr },
            Trigger::Label { repo, label } => Self::Label { repo, label },
        }
    }
}
impl From<TriggerInfo> for Trigger {
    fn from(t: TriggerInfo) -> Self {
        match t {
            TriggerInfo::Cron { expr } => Self::Cron { expr },
            TriggerInfo::Label { repo, label } => Self::Label { repo, label },
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct RunInfo {
    pub id: String,
    pub automation_id: String,
    pub task_id: Option<String>,
    /// `ok`, `failed` or `missed`.
    pub status: String,
    pub message: String,
    #[specta(type = specta_typescript::Number)]
    pub at: i64,
}
impl From<AutomationRun> for RunInfo {
    fn from(r: AutomationRun) -> Self {
        Self {
            id: r.id,
            automation_id: r.automation_id,
            task_id: r.task_id,
            status: r.status,
            message: r.message,
            at: r.at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct AutomationInfo {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub profile_id: String,
    pub prompt: String,
    pub trigger: TriggerInfo,
    pub is_enabled: bool,
    #[specta(type = Option<specta_typescript::Number>)]
    pub next_run_at: Option<i64>,
    pub last_run: Option<RunInfo>,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct AutomationSaveInput {
    pub id: Option<String>,
    pub project_id: String,
    pub name: String,
    pub profile_id: String,
    pub prompt: String,
    pub trigger: TriggerInfo,
    pub is_enabled: bool,
}

/// A run created a task: the front end starts the agent in it.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "automation:fired")]
pub struct AutomationFired {
    pub automation_id: String,
    pub automation_name: String,
    pub task_id: String,
    pub profile_id: String,
    pub prompt: String,
}

/// The automations list changed (a run happened or one was saved).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[tauri_specta(event_name = "automation:changed")]
pub struct AutomationChanged;

fn info(store: &Store, a: Automation) -> Result<AutomationInfo, AppError> {
    let last = store.automations().runs(&a.id, 1)?.into_iter().next();
    Ok(AutomationInfo {
        id: a.id,
        project_id: a.project_id,
        name: a.name,
        profile_id: a.profile_id,
        prompt: a.prompt,
        trigger: a.trigger.into(),
        is_enabled: a.is_enabled,
        next_run_at: a.next_run_at,
        last_run: last.map(Into::into),
    })
}

impl From<AutomationError> for AppError {
    fn from(e: AutomationError) -> Self {
        let code = match &e {
            AutomationError::Invalid(_) => "automation.invalid",
            AutomationError::NotFound => "automation.not_found",
            _ => "automation.store_failed",
        };
        AppError::new(code, e.to_string())
    }
}

fn changed(app: &tauri::AppHandle) {
    let _ = AutomationChanged.emit(app);
}

#[tauri::command]
#[specta::specta]
pub async fn automations_list(app: tauri::AppHandle) -> Result<Vec<AutomationInfo>, AppError> {
    with_store(app, |store| {
        store
            .automations()
            .list()?
            .into_iter()
            .map(|a| info(store, a))
            .collect()
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn automation_save(app: tauri::AppHandle, input: AutomationSaveInput) -> Result<AutomationInfo, AppError> {
    let saved = with_store(app.clone(), move |store| {
        let saved = store.automations().save(
            AutomationInput {
                id: input.id,
                project_id: input.project_id,
                name: input.name,
                profile_id: input.profile_id,
                prompt: input.prompt,
                trigger: input.trigger.into(),
                is_enabled: input.is_enabled,
            },
            now_seconds(),
        )?;
        // A changed or re-enabled label watcher starts from what is open now, so it does not fire on old issues.
        store.kv_delete(&seen_key(&saved.id))?;
        info(store, saved)
    })
    .await?;
    changed(&app);
    Ok(saved)
}

#[tauri::command]
#[specta::specta]
pub async fn automation_delete(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    with_store(app.clone(), move |store| {
        store.automations().delete(&id)?;
        store.kv_delete(&seen_key(&id))?;
        Ok(())
    })
    .await?;
    changed(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn automation_runs(app: tauri::AppHandle, id: String) -> Result<Vec<RunInfo>, AppError> {
    with_store(app, move |store| {
        Ok(store.automations().runs(&id, 50)?.into_iter().map(Into::into).collect())
    })
    .await
}

/// Runs an automation now, whatever its trigger (the issue-based ones run on their prompt alone).
#[tauri::command]
#[specta::specta]
pub async fn automation_run_now(app: tauri::AppHandle, id: String) -> Result<RunInfo, AppError> {
    let run = tauri::async_runtime::spawn_blocking(move || {
        let automation = {
            let state = app.state::<AppState>();
            let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
            store.automations().get(&id)?.ok_or(AutomationError::NotFound)?
        };
        let run = fire(&app, &automation, None);
        changed(&app);
        Ok::<_, AppError>(run)
    })
    .await
    .map_err(|e| AppError::new("automation.failed", e.to_string()))??;
    Ok(run.into())
}

fn seen_key(id: &str) -> String {
    format!("automation_seen:{id}")
}

/// The issues that were not seen before, as `(new, all seen numbers)`. `None` seen = first poll: nothing is new.
pub fn new_issues<'a>(seen: Option<&[u64]>, current: &'a [issues::Issue]) -> (Vec<&'a issues::Issue>, Vec<u64>) {
    let numbers: Vec<u64> = current.iter().map(|i| i.number).collect();
    let Some(seen) = seen else {
        return (Vec::new(), numbers);
    };
    let fresh: Vec<&issues::Issue> = current.iter().filter(|i| !seen.contains(&i.number)).collect();
    let mut all = seen.to_vec();
    all.extend(fresh.iter().map(|i| i.number));
    all.sort_unstable();
    all.dedup();
    (fresh, all)
}

fn issue_prompt(base: &str, issue: &issues::Issue) -> String {
    let mut text = format!("{}\n\nIssue {}: {}", base.trim(), issue.key, issue.title);
    if !issue.body.trim().is_empty() {
        text.push_str(&format!("\n\n{}", issue.body.trim()));
    }
    text.push_str(&format!("\n\nIssue: {}", issue.url));
    text
}

fn stamp(at: i64) -> String {
    Local
        .timestamp_opt(at, 0)
        .single()
        .map_or_else(|| at.to_string(), |t| t.format("%b %-d %H:%M").to_string())
}

/// Creates the task for a run, records it and asks the front end to start the agent. Never panics: a failure is a
/// recorded "failed" run.
fn fire(app: &tauri::AppHandle, automation: &Automation, issue: Option<&issues::Issue>) -> AutomationRun {
    let now = now_seconds();
    let state = app.state::<AppState>();
    let outcome = (|| -> Result<(String, String), String> {
        let store = state.store.lock().map_err(|_| "The store is busy.".to_owned())?;
        let project = store
            .projects()
            .get(&automation.project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "The project is gone.".to_owned())?;
        if store
            .agent_profiles()
            .get(&automation.profile_id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Err("The agent profile no longer exists.".into());
        }
        let name = match issue {
            Some(i) => format!("{} {}", i.key, i.title).chars().take(80).collect(),
            None => format!("{} {}", automation.name, stamp(now)),
        };
        let prompt = issue.map_or_else(|| automation.prompt.clone(), |i| issue_prompt(&automation.prompt, i));
        let main = std::path::PathBuf::from(&project.path);
        let events = app.clone();
        let task = store
            .task_create_record(
                CreateTask {
                    project_id: automation.project_id.clone(),
                    name: Some(name),
                    prompt: Some(prompt.clone()),
                    base_branch: project.default_branch.clone(),
                    existing_branch: None,
                    use_main_checkout: false,
                    run_setup: false,
                },
                |task| {
                    let path = task
                        .worktree_path
                        .as_deref()
                        .map(Path::new)
                        .or(if task.uses_main_checkout == Some(1) {
                            Some(main.as_path())
                        } else {
                            None
                        });
                    task_commands::emit(&events, task, path);
                },
            )
            .map_err(|e| e.to_string())?;
        if let Some(i) = issue {
            let mut row = store
                .tasks()
                .get(&task.id)
                .map_err(|e| e.to_string())?
                .ok_or("The task vanished.")?;
            row.issue_ref = Some(
                serde_json::json!({
                    "provider": i.provider, "id": i.id, "number": i.number, "key": i.key, "url": i.url, "title": i.title
                })
                .to_string(),
            );
            store.tasks().update(&row).map_err(|e| e.to_string())?;
        }
        Ok((task.id, prompt))
    })();
    let run = {
        let store = state.store.lock();
        match (&outcome, store) {
            (Ok((task_id, _)), Ok(store)) => {
                store
                    .automations()
                    .add_run(&automation.id, Some(task_id), "ok", "Started a task.", now)
            }
            (Err(message), Ok(store)) => store
                .automations()
                .add_run(&automation.id, None, "failed", message, now),
            (_, Err(_)) => Ok(AutomationRun {
                id: String::new(),
                automation_id: automation.id.clone(),
                task_id: None,
                status: "failed".into(),
                message: "The store is busy.".into(),
                at: now,
            }),
        }
        .unwrap_or_else(|e| AutomationRun {
            id: String::new(),
            automation_id: automation.id.clone(),
            task_id: None,
            status: "failed".into(),
            message: e.to_string(),
            at: now,
        })
    };
    if let Ok((task_id, prompt)) = outcome {
        task_commands::reconcile_watchers(app);
        let _ = AutomationFired {
            automation_id: automation.id.clone(),
            automation_name: automation.name.clone(),
            task_id,
            profile_id: automation.profile_id.clone(),
            prompt,
        }
        .emit(app);
    }
    run
}

/// One scheduler pass for cron automations.
fn run_due(app: &tauri::AppHandle, now: i64) {
    let due = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return };
        store.automations().due(now).unwrap_or_default()
    };
    for automation in due {
        let scheduled = automation.next_run_at.unwrap_or(now);
        let next = match &automation.trigger {
            Trigger::Cron { expr } => next_run_after(expr, now).ok(),
            Trigger::Label { .. } => None,
        };
        {
            let state = app.state::<AppState>();
            let Ok(store) = state.store.lock() else { return };
            let _ = store.automations().set_next_run(&automation.id, next);
            if now - scheduled > GRACE_SECS {
                let _ = store.automations().add_run(
                    &automation.id,
                    None,
                    "missed",
                    &format!("Tessera was not running at {}.", stamp(scheduled)),
                    now,
                );
            }
        }
        if now - scheduled <= GRACE_SECS {
            fire(app, &automation, None);
        }
        changed(app);
    }
}

fn note_failure(app: &tauri::AppHandle, automation: &Automation, message: &str, now: i64) {
    let state = app.state::<AppState>();
    let Ok(store) = state.store.lock() else { return };
    // Say it once, not every five minutes.
    let same = store
        .automations()
        .runs(&automation.id, 1)
        .ok()
        .and_then(|r| r.into_iter().next())
        .is_some_and(|r| r.status == "failed" && r.message == message);
    if !same {
        let _ = store
            .automations()
            .add_run(&automation.id, None, "failed", message, now);
        drop(store);
        changed(app);
    }
}

/// One poll of the watched labels: new issues start runs, the first poll only remembers what is open.
fn poll_labels(app: &tauri::AppHandle, now: i64) {
    let watchers = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return };
        store.automations().label_watchers().unwrap_or_default()
    };
    if watchers.is_empty() {
        return;
    }
    let token = match github_token(app) {
        Ok(token) => token,
        Err(error) => {
            for a in &watchers {
                note_failure(app, a, &error.message, now);
            }
            return;
        }
    };
    for automation in watchers {
        let Trigger::Label { repo, label } = &automation.trigger else {
            continue;
        };
        let Some((owner, name)) = repo.split_once('/') else {
            continue;
        };
        let found =
            tauri::async_runtime::block_on(issues::github_issues_labeled(&github_api(), &token, owner, name, label));
        let current = match found {
            Ok(list) => list,
            Err(ForgeError::RateLimited { until }) => {
                note_failure(
                    app,
                    &automation,
                    &format!("GitHub rate limit reached until {until}."),
                    now,
                );
                continue;
            }
            Err(error) => {
                note_failure(app, &automation, &error.to_string(), now);
                continue;
            }
        };
        let key = seen_key(&automation.id);
        let seen: Option<Vec<u64>> = {
            let state = app.state::<AppState>();
            let Ok(store) = state.store.lock() else { return };
            store
                .kv_get(&key)
                .ok()
                .flatten()
                .and_then(|text| serde_json::from_str(&text).ok())
        };
        let (fresh, all) = new_issues(seen.as_deref(), &current);
        {
            let state = app.state::<AppState>();
            let Ok(store) = state.store.lock() else { return };
            let _ = store.kv_set(&key, &serde_json::to_string(&all).unwrap_or_default());
        }
        for issue in fresh {
            fire(app, &automation, Some(issue));
            changed(app);
        }
    }
}

/// Starts the scheduler thread.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    let started = std::thread::Builder::new()
        .name("tessera-automations".into())
        .spawn(move || {
            // Let the window and the store settle first; a run due at startup is then handled as late or missed.
            std::thread::sleep(Duration::from_secs(5));
            let mut last_label_poll = 0i64;
            loop {
                let now = now_seconds();
                run_due(&app, now);
                if now - last_label_poll >= LABEL_POLL_SECS {
                    last_label_poll = now;
                    poll_labels(&app, now);
                }
                std::thread::sleep(TICK);
            }
        });
    if let Err(error) = started {
        tracing::warn!(%error, "could not start the automation scheduler");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(number: u64) -> issues::Issue {
        issues::Issue {
            provider: "github".into(),
            id: number.to_string(),
            key: format!("#{number}"),
            number,
            title: format!("Issue {number}"),
            body: String::new(),
            url: format!("https://github.com/o/r/issues/{number}"),
            labels: vec![],
            assignee: None,
        }
    }

    #[test]
    fn the_first_poll_only_remembers_what_is_open() {
        let current = [issue(1), issue(2)];
        let (fresh, all) = new_issues(None, &current);
        assert!(fresh.is_empty());
        assert_eq!(all, [1, 2]);
    }

    #[test]
    fn later_polls_fire_once_per_new_issue_and_keep_closed_ones_remembered() {
        let current = [issue(3), issue(2)];
        let (fresh, all) = new_issues(Some(&[1, 2]), &current);
        assert_eq!(fresh.iter().map(|i| i.number).collect::<Vec<_>>(), [3]);
        assert_eq!(all, [1, 2, 3]);
        let (again, _) = new_issues(Some(&all), &current);
        assert!(again.is_empty());
    }

    #[test]
    fn issue_prompt_adds_the_issue_to_the_automation_prompt() {
        let mut i = issue(7);
        i.body = "Steps".into();
        assert_eq!(
            issue_prompt("Fix it carefully.\n", &i),
            "Fix it carefully.\n\nIssue #7: Issue 7\n\nSteps\n\nIssue: https://github.com/o/r/issues/7"
        );
        assert!(!issue_prompt("x", &issue(8)).contains("\n\n\n"));
    }

    #[test]
    fn trigger_conversion_round_trips() {
        let t: Trigger = TriggerInfo::Label {
            repo: "o/r".into(),
            label: "x".into(),
        }
        .into();
        assert!(matches!(TriggerInfo::from(t), TriggerInfo::Label { .. }));
    }
}
