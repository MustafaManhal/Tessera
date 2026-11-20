-- Agents typed into a shell pane (`claude`, `codex resume <id>`), so a restored pane can continue the conversation.
-- One row per pane: the agent, its folder, the flags a resume keeps (JSON array), the conversation id once known and
-- whether the agent was still running (0 once the user ended it). Launched agents keep using agent_sessions.
CREATE TABLE pane_agents (
    pane_id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    program TEXT NOT NULL,
    cwd TEXT NOT NULL,
    flags TEXT NOT NULL DEFAULT '[]',
    external_session_id TEXT,
    running INTEGER NOT NULL DEFAULT 1,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
