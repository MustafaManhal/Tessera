CREATE TABLE mcp_servers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL CHECK(transport IN ('stdio','http')),
 command TEXT, args TEXT NOT NULL, url TEXT, env_keys TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE mcp_installs (
 mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL, config_path TEXT NOT NULL, installed_at INTEGER NOT NULL,
 PRIMARY KEY(mcp_server_id,agent_id,config_path)
);
CREATE TABLE skills (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('agents_md','claude_skill','rules_file')),
 body TEXT NOT NULL, install_targets TEXT NOT NULL DEFAULT '[]'
);
