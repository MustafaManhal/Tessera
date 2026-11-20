-- Automatic error reports and usage events from the app (0.1.20). On by default; the app says so once and Settings,
-- Privacy turns it off. Everything is redacted by the app first (secrets, the home folder). No network address is kept:
-- `install_hash` is a hash of a random id made at install, `sender_hash` a salted hash used only for the rate limit.
CREATE TABLE report_batches (
    id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    install_hash TEXT NOT NULL,
    session TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    build TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    os_version TEXT NOT NULL DEFAULT '',
    arch TEXT NOT NULL DEFAULT '',
    locale TEXT NOT NULL DEFAULT '',
    log_tail TEXT NOT NULL DEFAULT '',
    sender_hash TEXT NOT NULL
);
CREATE INDEX report_batches_created ON report_batches(created_at);
CREATE INDEX report_batches_sender ON report_batches(sender_hash, created_at);
CREATE INDEX report_batches_install ON report_batches(install_hash, created_at);

CREATE TABLE report_events (
    id TEXT PRIMARY KEY NOT NULL,
    batch_id TEXT NOT NULL REFERENCES report_batches(id) ON DELETE CASCADE,
    install_hash TEXT NOT NULL,
    app_version TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX report_events_kind ON report_events(kind, at);
CREATE INDEX report_events_name ON report_events(name, at);
CREATE INDEX report_events_batch ON report_events(batch_id);
