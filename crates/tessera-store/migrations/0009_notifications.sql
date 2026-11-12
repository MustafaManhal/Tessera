CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    task_id TEXT,
    pane_session_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
);
CREATE INDEX idx_notifications_read_at ON notifications (is_read, at);
