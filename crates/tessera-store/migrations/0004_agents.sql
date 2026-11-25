CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT,
    model TEXT,
    extra_args TEXT,
    env TEXT,
    skip_permissions INTEGER DEFAULT 0,
    is_default INTEGER,
    created_at INTEGER,
    updated_at INTEGER
);
CREATE INDEX agent_profiles_agent ON agent_profiles(agent_id);
CREATE UNIQUE INDEX agent_profiles_one_default ON agent_profiles(agent_id) WHERE is_default = 1;
CREATE TABLE agent_installs (
    agent_id TEXT PRIMARY KEY,
    binary_path TEXT,
    version TEXT,
    detected_at INTEGER,
    hooks_state TEXT CHECK(hooks_state IN ('none','installed','outdated','unsupported'))
);
