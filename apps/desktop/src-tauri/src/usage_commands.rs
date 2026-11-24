//! Token/cost figures for a task (FR-44) and the summary a hand-off to another agent starts from (FR-45).
//! Session logs are read with `tessera_agents::UsageTracker`; nothing leaves the machine.
use crate::{agent_commands::definition, error::AppError, state::AppState};
use serde::Serialize;
use specta::Type;
use std::{path::PathBuf, sync::Mutex};
use tauri::Manager;
use tessera_agents::UsageTracker;

static TRACKER: Mutex<Option<UsageTracker>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Type)]
pub struct TaskUsage {
    #[specta(type = specta_typescript::Number)]
    pub input_tokens: u64,
    #[specta(type = specta_typescript::Number)]
    pub output_tokens: u64,
    #[specta(type = specta_typescript::Number)]
    pub cache_read_tokens: u64,
    #[specta(type = specta_typescript::Number)]
    pub cache_write_tokens: u64,
    /// An estimate; `None` when a model used has no price in the bundled table.
    pub cost_usd: Option<f64>,
    pub models: Vec<String>,
    /// The agents whose logs contributed (agent ids).
    pub agents: Vec<String>,
}

struct Context {
    cwd: PathBuf,
    name: String,
    branch: String,
    base: String,
    prompt: Option<String>,
    agents: Vec<(String, String, Option<String>)>, // (agent id, name, source)
    last: Option<(String, String)>,                // (agent name, message)
}

fn context(app: &tauri::AppHandle, task_id: &str) -> Result<Context, AppError> {
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(|_| AppError::lock_failed())?;
    let task = store.task_get(task_id)?;
    let cwd: PathBuf = if let Some(path) = task.worktree_path {
        path.into()
    } else if task.uses_main_checkout == Some(1) {
        store
            .projects()
            .get(task.project_id.as_deref().unwrap_or_default())?
            .ok_or_else(|| AppError::new("task.not_found", "The project could not be found."))?
            .path
            .into()
    } else {
        return Err(AppError::new("task.not_found", "The task has no checkout."));
    };
    let sessions = store.agent_sessions().list(Some(task_id))?;
    let mut agents: Vec<(String, String, Option<String>)> = Vec::new();
    let mut last = None;
    for session in &sessions {
        let def = definition(&state.dirs.root, &session.agent_id).ok();
        if last.is_none()
            && let Some(message) = session.status_message.clone().filter(|m| !m.trim().is_empty())
        {
            last = Some((
                def.as_ref().map_or(session.agent_id.clone(), |d| d.name.clone()),
                message,
            ));
        }
        if !agents.iter().any(|(id, ..)| *id == session.agent_id) {
            agents.push((
                session.agent_id.clone(),
                def.as_ref().map_or(session.agent_id.clone(), |d| d.name.clone()),
                def.and_then(|d| d.usage.get("source").cloned()),
            ));
        }
    }
    Ok(Context {
        cwd,
        name: task.name,
        branch: task.branch,
        base: task.base_branch,
        prompt: task.prompt,
        agents,
        last,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn task_usage(app: tauri::AppHandle, task_id: String) -> Result<Option<TaskUsage>, AppError> {
    let home = app.path().home_dir().map_err(|e| {
        AppError::new(
            "usage.failed",
            format!("The home directory could not be resolved: {e}."),
        )
    })?;
    let ctx = context(&app, &task_id)?;
    // Logs of an SSH host live on the host; they are not read.
    if tessera_git::remote::is_remote(&ctx.cwd) {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = ctx.cwd.to_string_lossy().into_owned();
        let mut guard = TRACKER.lock().map_err(|_| AppError::lock_failed())?;
        let tracker = guard.get_or_insert_with(UsageTracker::new);
        let mut total: Option<TaskUsage> = None;
        for (agent, _, source) in &ctx.agents {
            let Some(usage) = source.as_deref().and_then(|s| tracker.scan(s, &home, &cwd)) else {
                continue;
            };
            let acc = total.get_or_insert(TaskUsage {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost_usd: Some(0.0),
                models: Vec::new(),
                agents: Vec::new(),
            });
            acc.input_tokens += usage.input_tokens;
            acc.output_tokens += usage.output_tokens;
            acc.cache_read_tokens += usage.cache_read_tokens;
            acc.cache_write_tokens += usage.cache_write_tokens;
            acc.cost_usd = acc.cost_usd.zip(usage.cost_usd).map(|(a, b)| a + b);
            acc.models.extend(usage.models);
            acc.agents.push(agent.clone());
        }
        Ok(total)
    })
    .await
    .map_err(|e| AppError::new("usage.failed", e.to_string()))?
}

/// The text agent B starts from: task, original prompt, changed files and agent A's last message. The user edits it
/// before it is sent.
#[tauri::command]
#[specta::specta]
pub async fn handoff_summary(app: tauri::AppHandle, task_id: String) -> Result<String, AppError> {
    let ctx = context(&app, &task_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let files = tessera_git::review_files(&ctx.cwd, &ctx.base).unwrap_or_default();
        Ok(build_summary(&ctx, &files))
    })
    .await
    .map_err(|e| AppError::new("usage.failed", e.to_string()))?
}

fn build_summary(ctx: &Context, files: &[tessera_git::ReviewChangedFile]) -> String {
    let mut out = String::new();
    let from = ctx
        .last
        .as_ref()
        .map(|(name, _)| name.as_str())
        .or_else(|| ctx.agents.first().map(|(_, n, _)| n.as_str()));
    match from {
        Some(name) => out.push_str(&format!("You are taking over a task from {name}.\n")),
        None => out.push_str("You are taking over a task that was started earlier.\n"),
    }
    out.push_str(&format!(
        "Task: {} (branch {}, base {}).\n",
        ctx.name, ctx.branch, ctx.base
    ));
    if let Some(prompt) = ctx.prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        out.push_str(&format!("\nOriginal prompt:\n{}\n", prompt.trim()));
    }
    if files.is_empty() {
        out.push_str("\nNo files have been changed yet.\n");
    } else {
        let (added, removed) = files.iter().fold((0, 0), |(a, r), f| (a + f.added, r + f.removed));
        out.push_str(&format!(
            "\nChanged so far ({} files, +{added} -{removed}):\n",
            files.len()
        ));
        for f in files.iter().take(50) {
            out.push_str(&format!("- {} {} (+{} -{})\n", f.status, f.path, f.added, f.removed));
        }
        if files.len() > 50 {
            out.push_str(&format!("- and {} more\n", files.len() - 50));
        }
    }
    if let Some((name, message)) = &ctx.last {
        out.push_str(&format!("\nLast message from {name}:\n{}\n", message.trim()));
    }
    out.push_str(
        "\nContinue from the current state of the worktree. Review the changes first, then finish the task.\n",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ctx(last: Option<(&str, &str)>) -> Context {
        Context {
            cwd: PathBuf::from("/w"),
            name: "Fix login".into(),
            branch: "fix-login".into(),
            base: "main".into(),
            prompt: Some("Make login work".into()),
            agents: vec![("claude".into(), "Claude Code".into(), None)],
            last: last.map(|(a, b)| (a.into(), b.into())),
        }
    }
    #[test]
    fn summary_names_task_prompt_files_and_last_message() {
        let files = vec![tessera_git::ReviewChangedFile {
            path: "src/a b.rs".into(),
            old_path: None,
            status: "M".into(),
            added: 3,
            removed: 1,
            is_binary: false,
        }];
        let text = build_summary(&ctx(Some(("Claude Code", "Tests still fail"))), &files);
        assert!(text.contains("taking over a task from Claude Code"));
        assert!(text.contains("Task: Fix login (branch fix-login, base main)"));
        assert!(text.contains("Make login work"));
        assert!(text.contains("- M src/a b.rs (+3 -1)"));
        assert!(text.contains("Tests still fail"));
    }
    #[test]
    fn summary_without_files_or_message_still_reads_well() {
        let text = build_summary(&ctx(None), &[]);
        assert!(text.contains("No files have been changed yet."));
        assert!(!text.contains("Last message"));
        assert!(text.contains("taking over a task from Claude Code"));
    }
}
