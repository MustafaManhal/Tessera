//! "Send feedback" (reports, ideas, screenshots). Nothing leaves the computer until the person presses Send in the
//! dialog, which shows what goes along. Text is passed through the secret redactor once more, the optional technical
//! details are the same redacted report as "Copy error report", and screenshots are the ones the person attached.
use crate::{error::AppError, project_commands::with_store, state::AppState, sync_commands::DEFAULT_SERVER};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tessera_store::redact::redact;
use tessera_sync::feedback::{self, Attachment, Feedback, FeedbackError};

#[derive(Debug, Clone, Deserialize, Type)]
pub struct AttachmentInput {
    pub name: String,
    pub mime: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct FeedbackInput {
    /// `bug`, `idea`, `design` or `other`.
    pub kind: String,
    pub title: String,
    pub body: String,
    /// Optional: how to reach the person. Nothing is required.
    pub contact: String,
    pub include_report: bool,
    pub attachments: Vec<AttachmentInput>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct FeedbackSent {
    /// The reference to quote when asking about it.
    pub id: String,
}

fn server() -> String {
    if cfg!(debug_assertions)
        && let Ok(url) = std::env::var("TESSERA_FEEDBACK_URL")
        && !url.is_empty()
    {
        return url;
    }
    DEFAULT_SERVER.to_owned()
}

fn map(error: FeedbackError) -> AppError {
    let code = match &error {
        FeedbackError::Refused(_) => "feedback.refused",
        FeedbackError::TooMany => "feedback.too_many",
        FeedbackError::TooLarge => "feedback.too_large",
        FeedbackError::Network(_) => "feedback.network",
    };
    AppError::new(code, error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn feedback_send(app: tauri::AppHandle, input: FeedbackInput) -> Result<FeedbackSent, AppError> {
    let version = app.package_info().version.to_string();
    let logs = app.state::<AppState>().dirs.logs.clone();
    let schema = with_store(app, |store| Ok(store.schema_version().unwrap_or(0))).await?;
    let report = if input.include_report {
        let tail = crate::diagnostics_commands::log_tail(&logs, 200);
        let build = if cfg!(debug_assertions) { "debug" } else { "release" };
        crate::diagnostics_commands::build_report(&version, build, schema, "", "", &tail)
    } else {
        String::new()
    };
    let payload = Feedback {
        kind: input.kind,
        title: redact(&input.title).into_owned(),
        body: redact(&input.body).into_owned(),
        contact: input.contact,
        app_version: version,
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        report,
        attachments: input
            .attachments
            .into_iter()
            .map(|a| Attachment {
                name: a.name,
                mime: a.mime,
                data_base64: a.data_base64,
            })
            .collect(),
    };
    feedback::send(&server(), &payload)
        .await
        .map(|id| FeedbackSent { id })
        .map_err(map)
}
