CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT REFERENCES tasks(id),
    pane_session_id TEXT NOT NULL DEFAULT '',
    pane_id TEXT,
    agent_id TEXT,
    profile_id TEXT REFERENCES agent_profiles(id),
    status TEXT CHECK(status IN ('starting','working','needs_input','idle','error','exited')),
    status_source TEXT,
    status_at INTEGER,
    external_session_id TEXT,
    exit_code INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    prompt TEXT,
    started_at INTEGER,
    ended_at INTEGER
);
CREATE INDEX agent_sessions_task ON agent_sessions(task_id);
CREATE INDEX agent_sessions_status ON agent_sessions(status);
CREATE TABLE agent_events (
    id TEXT PRIMARY KEY NOT NULL,
    agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
    kind TEXT,
    payload TEXT,
    at INTEGER
);
CREATE INDEX agent_events_session_at ON agent_events(agent_session_id, at);
