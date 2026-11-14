CREATE TABLE agent_installs_hooks (
    agent_id TEXT PRIMARY KEY,
    binary_path TEXT,
    version TEXT,
    detected_at INTEGER,
    hooks_state TEXT CHECK(hooks_state IN ('none','installed','outdated','unsupported','conflict','unparseable'))
);
INSERT INTO agent_installs_hooks SELECT * FROM agent_installs;
DROP TABLE agent_installs;
ALTER TABLE agent_installs_hooks RENAME TO agent_installs;
