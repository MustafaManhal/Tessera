CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    trigger TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX automations_due ON automations(is_enabled, next_run_at);
CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    task_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('ok','failed','missed')),
    message TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
);
CREATE INDEX automation_runs_by_automation ON automation_runs(automation_id, at);
