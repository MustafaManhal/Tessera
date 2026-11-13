-- The first schema version (M0.4): small key/value app state.
-- IF NOT EXISTS keeps a hand-made or very early database (user_version 0)
-- migratable instead of failing on the table it already has.
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
