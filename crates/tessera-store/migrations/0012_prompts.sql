-- IF NOT EXISTS: a dev database from the worker-2 branch already has these tables (it numbered this migration 0010).
CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    variables TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    uses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_history (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    targets TEXT NOT NULL DEFAULT '[]',
    at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_history_at ON prompt_history (at);
