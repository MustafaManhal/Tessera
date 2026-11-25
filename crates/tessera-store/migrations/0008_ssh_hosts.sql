-- SSH hosts added by hand (FR-62, S-19). Hosts from ~/.ssh/config are read live and never copied here, except when
-- the user stores a setting for one (auth method or a keychain password): then a row with from_ssh_config = 1 holds it.
CREATE TABLE ssh_hosts (
    id TEXT PRIMARY KEY NOT NULL,
    alias TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER,
    user TEXT,
    auth TEXT NOT NULL DEFAULT 'agent' CHECK (auth IN ('agent', 'key', 'password')),
    key_path TEXT,
    from_ssh_config INTEGER NOT NULL DEFAULT 0,
    keychain_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
