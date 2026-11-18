//! Durable line comments and acknowledgement after the frontend delivers a prompt.
use crate::{
    Store, StoreError,
    repositories::{new_id, now_seconds},
};
use rusqlite::{OptionalExtension, params};
#[derive(Debug, thiserror::Error)]
pub enum CommentError {
    #[error("Invalid review comment: {0}")]
    Invalid(String),
    #[error("The review comment could not be found.")]
    NotFound,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewComment {
    pub id: String,
    pub task_id: String,
    pub file_path: String,
    pub side: String,
    pub line_start: i64,
    pub line_end: i64,
    pub code_excerpt: String,
    pub body: String,
    pub sent_at: Option<i64>,
    pub resolved: bool,
    pub created_at: i64,
}
pub struct NewReviewComment {
    pub task_id: String,
    pub file_path: String,
    pub side: String,
    pub line_start: i64,
    pub line_end: i64,
    pub code_excerpt: String,
    pub body: String,
}
/// The exact version that was included in a delivered prompt. Concurrent edits stay unsent.
#[derive(Debug, Clone)]
pub struct CommentReceipt {
    pub id: String,
    pub body: String,
}
pub struct ReviewComments<'a>(&'a Store);
impl Store {
    pub fn review_comments(&self) -> ReviewComments<'_> {
        ReviewComments(self)
    }
}
const SELECT: &str = "SELECT id,task_id,file_path,side,line_start,line_end,code_excerpt,body,sent_at,resolved,created_at FROM review_comments";
fn validate_body(body: &str) -> Result<(), CommentError> {
    if body.trim().is_empty() || body.len() > 65536 {
        return Err(CommentError::Invalid("Write a comment of at most 64 KiB.".into()));
    }
    Ok(())
}
impl ReviewComments<'_> {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewComment> {
        Ok(ReviewComment {
            id: row.get(0)?,
            task_id: row.get(1)?,
            file_path: row.get(2)?,
            side: row.get(3)?,
            line_start: row.get(4)?,
            line_end: row.get(5)?,
            code_excerpt: row.get(6)?,
            body: row.get(7)?,
            sent_at: row.get(8)?,
            resolved: row.get(9)?,
            created_at: row.get(10)?,
        })
    }
    pub fn list(&self, task_id: &str) -> Result<Vec<ReviewComment>, CommentError> {
        let mut statement = self
            .0
            .conn
            .prepare(&format!("{SELECT} WHERE task_id=?1 ORDER BY created_at,id"))?;
        Ok(statement.query_map([task_id], Self::read)?.collect::<Result<_, _>>()?)
    }
    pub fn get(&self, id: &str) -> Result<ReviewComment, CommentError> {
        self.0
            .conn
            .query_row(&format!("{SELECT} WHERE id=?1"), [id], Self::read)
            .optional()?
            .ok_or(CommentError::NotFound)
    }
    pub fn add(&self, input: NewReviewComment) -> Result<ReviewComment, CommentError> {
        validate_body(&input.body)?;
        if !matches!(input.side.as_str(), "base" | "head")
            || input.line_start < 1
            || input.line_end < input.line_start
            || input.code_excerpt.len() > 65536
            || input.file_path.is_empty()
            || input.file_path.len() > 4096
            || input.file_path.contains('\0')
            || input.file_path.split(['/', '\\']).any(|p| p == "..")
        {
            return Err(CommentError::Invalid(
                "Check the file, side, line range and code excerpt.".into(),
            ));
        }
        let id = new_id();
        self.0.conn.execute("INSERT INTO review_comments(id,task_id,file_path,side,line_start,line_end,code_excerpt,body,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,input.task_id,input.file_path,input.side,input.line_start,input.line_end,input.code_excerpt,input.body,now_seconds()])?;
        self.get(&id)
    }
    pub fn update(&self, id: &str, body: &str, resolved: bool) -> Result<ReviewComment, CommentError> {
        validate_body(body)?;
        let old = self.get(id)?;
        self.0.conn.execute("UPDATE review_comments SET body=?2,resolved=?3,sent_at=CASE WHEN body<>?2 THEN NULL ELSE sent_at END WHERE id=?1",params![old.id,body,resolved])?;
        self.get(id)
    }
    pub fn delete(&self, id: &str) -> Result<(), CommentError> {
        if self.0.conn.execute("DELETE FROM review_comments WHERE id=?1", [id])? == 0 {
            return Err(CommentError::NotFound);
        }
        Ok(())
    }
    pub fn acknowledge(&self, task_id: &str, receipts: &[CommentReceipt]) -> Result<Vec<ReviewComment>, CommentError> {
        let tx = self.0.conn.unchecked_transaction()?;
        for receipt in receipts {
            tx.execute(
                "UPDATE review_comments SET sent_at=?4 WHERE id=?1 AND task_id=?2 AND body=?3 AND sent_at IS NULL",
                params![receipt.id, task_id, receipt.body, now_seconds()],
            )?;
        }
        tx.commit()?;
        self.list(task_id)
    }
}
/// TRD §4.7 prompt. Resolved or previously delivered comments are excluded.
pub fn comments_prompt(comments: &[ReviewComment]) -> String {
    let mut text = String::from("Review comments on your changes:");
    for comment in comments.iter().filter(|c| c.sent_at.is_none() && !c.resolved) {
        let range = if comment.line_start == comment.line_end {
            comment.line_start.to_string()
        } else {
            format!("{}-{}", comment.line_start, comment.line_end)
        };
        text.push_str(&format!("\n\n{}:{} ({})\n", comment.file_path, range, comment.side));
        for line in comment.code_excerpt.lines() {
            text.push_str("> ");
            text.push_str(line);
            text.push('\n');
        }
        text.push_str(&comment.body);
    }
    text
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comments_migrate_crud_prompt_and_delivery_receipts() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = crate::DataDirs::from_root(tmp.path());
        let old = rusqlite_migration::Migrations::from_slice(
            &crate::db::MIGRATION_LIST[..crate::db::MIGRATION_LIST.len() - 1],
        );
        {
            let store = Store::open_with_migrations(&dirs, &old).unwrap();
            store.kv_set("fixture", "kept").unwrap();
            store
                .conn
                .execute(
                    "INSERT INTO tasks(id,name,slug,branch,base_branch) VALUES('task','Task','task','task','main')",
                    [],
                )
                .unwrap();
        }
        let store = Store::open(&dirs).unwrap();
        assert_eq!(store.schema_version().unwrap(), crate::db::SCHEMA_VERSION);
        assert_eq!(store.kv_get("fixture").unwrap().as_deref(), Some("kept"));
        assert!(store.review_comments().list("task").unwrap().is_empty());
        let row = store
            .review_comments()
            .add(NewReviewComment {
                task_id: "task".into(),
                file_path: "src/界 file.rs".into(),
                side: "head".into(),
                line_start: 2,
                line_end: 3,
                code_excerpt: "let x = 1;\nnext();".into(),
                body: "Explain this".into(),
            })
            .unwrap();
        assert_eq!(
            comments_prompt(std::slice::from_ref(&row)),
            "Review comments on your changes:\n\nsrc/界 file.rs:2-3 (head)\n> let x = 1;\n> next();\nExplain this"
        );
        let receipt = CommentReceipt {
            id: row.id.clone(),
            body: row.body.clone(),
        };
        store.review_comments().update(&row.id, "Changed body", false).unwrap();
        store
            .review_comments()
            .acknowledge("task", std::slice::from_ref(&receipt))
            .unwrap();
        assert!(store.review_comments().get(&row.id).unwrap().sent_at.is_none());
        let rows = store
            .review_comments()
            .acknowledge(
                "task",
                &[CommentReceipt {
                    id: row.id.clone(),
                    body: "Changed body".into(),
                }],
            )
            .unwrap();
        assert!(rows[0].sent_at.is_some());
        let updated = store.review_comments().update(&row.id, "New feedback", true).unwrap();
        assert!(updated.sent_at.is_none());
        assert_eq!(comments_prompt(&[updated]), "Review comments on your changes:");
        // Resolving after delivery but before its acknowledgement still records that delivery.
        let acknowledged = store
            .review_comments()
            .acknowledge(
                "task",
                &[CommentReceipt {
                    id: row.id.clone(),
                    body: "New feedback".into(),
                }],
            )
            .unwrap();
        assert!(acknowledged[0].resolved);
        assert!(acknowledged[0].sent_at.is_some());
        store.review_comments().delete(&row.id).unwrap();
        assert!(store.review_comments().get(&row.id).is_err());
        assert!(
            store
                .review_comments()
                .add(NewReviewComment {
                    task_id: "task".into(),
                    file_path: "a".into(),
                    side: "bad".into(),
                    line_start: 0,
                    line_end: 1,
                    code_excerpt: "".into(),
                    body: "bad".into()
                })
                .is_err()
        );
    }
}
