-- Connected accounts (FR-54): the token lives only in the OS keychain; the row keeps login, id, scopes, keychain_ref.
CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    account_login TEXT NOT NULL,
    account_id TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '',
    keychain_ref TEXT NOT NULL,
    connected_at INTEGER NOT NULL,
    UNIQUE (provider, account_id)
);
