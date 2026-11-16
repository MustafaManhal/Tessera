CREATE TABLE review_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('base','head')),
    line_start INTEGER NOT NULL CHECK(line_start > 0),
    line_end INTEGER NOT NULL CHECK(line_end >= line_start),
    code_excerpt TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at INTEGER,
    resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
    created_at INTEGER NOT NULL
);
CREATE INDEX review_comments_task_sent ON review_comments(task_id, sent_at);
