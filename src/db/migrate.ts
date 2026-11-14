import { readFileSync } from 'node:fs';
import { db } from './client.js';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function migrate(): void {
  db.transaction(() => {
    const version = Number(db.pragma('user_version', { simple: true }));
    if (version > 2) throw new Error(`Database schema version ${version} is newer than this Maya build`);
    const hadMessageFts = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get());
    db.exec(schema);
    if (!hadMessageFts) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    const columns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    if (!columns.some(({ name }) => name === 'calendar_event_id')) {
      db.exec('ALTER TABLE tasks ADD COLUMN calendar_event_id TEXT');
      db.exec("INSERT OR IGNORE INTO calendar_jobs (task_id) SELECT id FROM tasks WHERE due_at IS NOT NULL AND status = 'open'");
    }
    if (!columns.some(({ name }) => name === 'due_precision')) {
      db.exec("ALTER TABLE tasks ADD COLUMN due_precision TEXT NOT NULL DEFAULT 'time'");
    }
    const dialogueColumns = db.prepare('PRAGMA table_info(owner_dialogue)').all() as { name: string }[];
    if (dialogueColumns.length > 0 && !dialogueColumns.some(({ name }) => name === 'answer_ref')) {
      db.exec('ALTER TABLE owner_dialogue ADD COLUMN answer_ref TEXT');
    }
    if (version < 2) db.pragma('user_version = 2');
  })();
}
