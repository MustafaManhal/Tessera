-- Tessera sync (05-backend-schema §8). The server never sees plaintext: docs hold ciphertext and nonces only.
CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    github_id INTEGER NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

-- Sessions are random bearer tokens; only their SHA-256 is stored.
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE docs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc TEXT NOT NULL,
    version INTEGER NOT NULL,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, doc)
);
