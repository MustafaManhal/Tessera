//! Board view data (M7.7, FR-33): the manual column override of a task and the pull request facts the board shows.
//! The column itself is derived in the front end (`board/derive.ts`); only the override is stored.
use crate::{error::AppError, project_commands::with_store};
use serde::Serialize;
use specta::Type;

pub const COLUMNS: [&str; 5] = ["backlog", "running", "needs_you", "review", "done"];

#[derive(Debug, Clone, Serialize, Type)]
pub struct BoardTask {
    pub task_id: String,
    /// The user's manual column, or null for the automatic one.
    pub board_column: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub pr_number: Option<i64>,
    pub pr_state: Option<String>,
    pub ci_state: Option<String>,
}

/// Board facts of every task that has any (an override or pull request data).
#[tauri::command]
#[specta::specta]
pub async fn board_tasks(app: tauri::AppHandle) -> Result<Vec<BoardTask>, AppError> {
    with_store(app, |store| {
        Ok(store
            .tasks()
            .list()?
            .into_iter()
            .filter(|t| {
                t.board_column.is_some() || t.pr_number.is_some() || t.pr_state.is_some() || t.ci_state.is_some()
            })
            .map(|t| BoardTask {
                task_id: t.id,
                board_column: t.board_column,
                pr_number: t.pr_number,
                pr_state: t.pr_state,
                ci_state: t.ci_state,
            })
            .collect())
    })
    .await
}

/// Moves a task to a column by hand; `None` goes back to the automatic column.
#[tauri::command]
#[specta::specta]
pub async fn task_set_column(app: tauri::AppHandle, task_id: String, column: Option<String>) -> Result<(), AppError> {
    if let Some(column) = &column
        && !COLUMNS.contains(&column.as_str())
    {
        return Err(AppError::new("task.invalid", "That is not a board column."));
    }
    with_store(app, move |store| {
        let mut task = store
            .tasks()
            .get(&task_id)?
            .ok_or_else(|| AppError::new("task.not_found", "The task could not be found."))?;
        task.board_column = column;
        store.tasks().update(&task)?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn columns_match_the_board() {
        assert_eq!(COLUMNS, ["backlog", "running", "needs_you", "review", "done"]);
    }
}
