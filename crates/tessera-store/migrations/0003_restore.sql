CREATE TABLE layouts (
    window_id TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL CHECK(json_valid(state)),
    version INTEGER NOT NULL DEFAULT 1,
    bounds TEXT CHECK(bounds IS NULL OR json_valid(bounds)),
    updated_at INTEGER NOT NULL
);
CREATE TABLE pane_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    window_id TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    shell TEXT NOT NULL DEFAULT '',
    scrollback BLOB,
    cols INTEGER NOT NULL DEFAULT 80,
    rows INTEGER NOT NULL DEFAULT 24,
    updated_at INTEGER NOT NULL
);
CREATE INDEX pane_sessions_oldest ON pane_sessions(updated_at, id);
