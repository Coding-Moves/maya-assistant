CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL DEFAULT 'whatsapp',
  external_id  TEXT NOT NULL,              -- WhatsApp message id
  chat_id      TEXT NOT NULL,
  chat_name    TEXT,
  sender_name  TEXT,
  text         TEXT NOT NULL,
  sent_at      TEXT NOT NULL,              -- ISO UTC, from the message timestamp
  processed    INTEGER NOT NULL DEFAULT 0, -- 0 = pending, 1 = processed, -1 = quarantined
  extract_attempts INTEGER NOT NULL DEFAULT 0,
  failure_batch_id INTEGER REFERENCES extraction_failures(id),
  UNIQUE (source, chat_id, external_id)
);

CREATE TABLE IF NOT EXISTS extraction_failures (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  failed_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  owner_notified_at TEXT               -- NULL until sendToOwner succeeds
);

CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_msg_id    INTEGER REFERENCES messages(id), -- message that created the task
  last_msg_id      INTEGER REFERENCES messages(id), -- message that last created/updated/cancelled it
  subject          TEXT,                   -- course or topic, e.g. "MTH501"
  type             TEXT NOT NULL,          -- quiz | assignment | exam | announcement | venue_change | class | other
  title            TEXT NOT NULL,
  details          TEXT,
  due_at           TEXT,                   -- ISO UTC; NULL if no date
  status           TEXT NOT NULL DEFAULT 'open',  -- open | done | cancelled
  reminded_evening INTEGER NOT NULL DEFAULT 0,
  reminded_morning INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_unprocessed ON messages(processed, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_failure_batch ON messages(failure_batch_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, due_at);
