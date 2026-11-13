-- Tessera feedback (M12 follow-up): reports, ideas and screenshots people choose to send from the app. Nothing is sent
-- without the person pressing Send. The sender's address is never stored, only a salted hash used to rate-limit.
CREATE TABLE feedback (
    id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    report TEXT NOT NULL DEFAULT '',
    sender_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX feedback_created ON feedback(created_at);
CREATE INDEX feedback_sender ON feedback(sender_hash, created_at);

CREATE TABLE feedback_attachments (
    id TEXT PRIMARY KEY NOT NULL,
    feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data_base64 TEXT NOT NULL
);
CREATE INDEX feedback_attachments_by_feedback ON feedback_attachments(feedback_id);
