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

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- Owner controls are deliberately separate from deployment secrets.
CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY CHECK (key IN ('MEDIA_ENABLED', 'MEDIA_MAX_BYTES', 'MEDIA_BATCH_SIZE', 'EXTRACT_BATCH_SIZE')),
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_policies (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  ingest_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ingest_enabled IN (0, 1)),
  media_enabled INTEGER NOT NULL DEFAULT 1 CHECK (media_enabled IN (0, 1)),
  extraction_enabled INTEGER NOT NULL DEFAULT 1 CHECK (extraction_enabled IN (0, 1)),
  retrieval_enabled INTEGER NOT NULL DEFAULT 1 CHECK (retrieval_enabled IN (0, 1)),
  paused_until TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_action_confirmations (
  token TEXT PRIMARY KEY,
  actor_jid TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  target TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  state_revision TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_action_confirmations_actor ON owner_action_confirmations(actor_jid, expires_at);

CREATE TABLE IF NOT EXISTS owner_action_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_jid TEXT NOT NULL,
  source_ref TEXT,
  operation_key TEXT UNIQUE,
  tool_name TEXT NOT NULL,
  target TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'proposed', 'rejected', 'failed')),
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_agent_requests (
  actor_jid TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'completed')),
  reply TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_jid, source_ref)
);

-- A short-lived, owner-bound preview of task changes extracted from owner text or media.
CREATE TABLE IF NOT EXISTS owner_task_update_drafts (
  actor_jid TEXT PRIMARY KEY,
  source_ref TEXT,
  payload_json TEXT NOT NULL,
  state_revision TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_task_update_drafts_expiry ON owner_task_update_drafts(expires_at);

CREATE TABLE IF NOT EXISTS owner_task_update_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  source_ref TEXT,
  action TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_task_update_events_task ON owner_task_update_events(task_id, id);

CREATE TABLE IF NOT EXISTS owner_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
  sent_at TEXT,
  source_ref TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_reminders_due ON owner_reminders(status, sent_at, due_at);

CREATE TABLE IF NOT EXISTS extraction_failures (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  failed_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  owner_notified_at TEXT               -- NULL until sendToOwner succeeds
);

CREATE TABLE IF NOT EXISTS media_jobs (
  message_id    INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  payload       BLOB NOT NULL,             -- encoded WhatsApp message for restart-safe retry
  mime_type     TEXT NOT NULL,
  caption       TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0
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
  due_precision    TEXT NOT NULL DEFAULT 'time', -- 'date' for VU items with no exact time
  calendar_event_id TEXT,                   -- deterministic Google Calendar event ID
  status           TEXT NOT NULL DEFAULT 'open',  -- open | done | cancelled | expired
  reminded_evening INTEGER NOT NULL DEFAULT 0,
  reminded_morning INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_unprocessed ON messages(processed, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_failure_batch ON messages(failure_batch_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE INDEX IF NOT EXISTS idx_media_jobs_attempts ON media_jobs(attempts, message_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, due_at);

-- One owner-bound, short-lived clarification for indistinguishable task names.
CREATE TABLE IF NOT EXISTS owner_task_choices (
  actor_jid TEXT PRIMARY KEY,
  candidate_ids_json TEXT NOT NULL,
  language TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Short private conversation continuity, purged after 48 hours.
CREATE TABLE IF NOT EXISTS owner_dialogue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_jid TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  answer_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_dialogue_actor ON owner_dialogue(actor_jid, created_at DESC);

CREATE TABLE IF NOT EXISTS source_sync_state (
  source TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_failure_at TEXT
);

CREATE TABLE IF NOT EXISTS calendar_jobs (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS calendar_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_at TEXT NOT NULL,
  local_day TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  important INTEGER NOT NULL DEFAULT 0,
  reminded_at TEXT,
  seen INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_day ON calendar_events(local_day, important);

INSERT OR IGNORE INTO calendar_meta (key, value)
VALUES ('instance_id', lower(hex(randomblob(16))));

CREATE TRIGGER IF NOT EXISTS queue_calendar_task_insert
AFTER INSERT ON tasks WHEN NEW.due_at IS NOT NULL
BEGIN
  INSERT INTO calendar_jobs (task_id) VALUES (NEW.id)
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS queue_calendar_task_update
AFTER UPDATE OF subject, type, title, details, due_at, due_precision, status ON tasks
BEGIN
  INSERT INTO calendar_jobs (task_id) VALUES (NEW.id)
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
END;

-- Owner-saved knowledge is separate from group messages and academic tasks.
CREATE TABLE IF NOT EXISTS memory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('permanent', 'semi', 'temporary')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'review', 'completed', 'archived', 'draft')),
  due_at TEXT,
  expires_at TEXT,
  review_at TEXT,
  completed_at TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('owner_text', 'owner_media')),
  source_ref TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (lifecycle != 'semi' OR review_at IS NOT NULL OR expires_at IS NOT NULL),
  CHECK (lifecycle != 'temporary' OR due_at IS NOT NULL OR expires_at IS NOT NULL),
  CHECK (lifecycle != 'permanent' OR (due_at IS NULL AND expires_at IS NULL AND review_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_memory_lifecycle ON memory_items(lifecycle, status, category, id);
CREATE INDEX IF NOT EXISTS idx_memory_expiry ON memory_items(lifecycle, status, due_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_memory_review ON memory_items(lifecycle, status, review_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, body, content='memory_items', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE OF title, body ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS memory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL,
  source_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_events_target ON memory_events(memory_id, id);

CREATE TABLE IF NOT EXISTS timetable_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'archived')),
  timezone TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  source_ref TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  UNIQUE(memory_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_timetable_active ON timetable_versions(memory_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_timetable_versions ON timetable_versions(memory_id, version DESC);

CREATE TABLE IF NOT EXISTS timetable_entries (
  version_id INTEGER NOT NULL REFERENCES timetable_versions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  day_of_week INTEGER CHECK (day_of_week BETWEEN 1 AND 7),
  start_local TEXT,
  end_local TEXT,
  subject TEXT,
  location TEXT,
  teacher TEXT,
  uncertainty TEXT,
  PRIMARY KEY (version_id, position)
);
CREATE INDEX IF NOT EXISTS idx_timetable_day ON timetable_entries(version_id, day_of_week, start_local);

CREATE TABLE IF NOT EXISTS memory_confirmations (
  token TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('delete', 'clear', 'timetable')),
  actor_jid TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_confirmations_expiry ON memory_confirmations(expires_at);

CREATE TABLE IF NOT EXISTS memory_save_drafts (
  actor_jid TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_tasks (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (source, external_id)
);
