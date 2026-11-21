import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
after(() => db.close());

test('upgrades an existing task table without deleting its rows', () => {
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, due_at TEXT, status TEXT NOT NULL DEFAULT 'open')");
  db.exec("INSERT INTO tasks (id, due_at) VALUES (7, '2026-11-05T10:00:00.000Z')");
  db.exec(`CREATE TABLE owner_dialogue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_jid TEXT NOT NULL, question TEXT NOT NULL,
    answer TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  db.exec("INSERT INTO owner_dialogue (actor_jid, question, answer, created_at) VALUES ('123@s.whatsapp.net', 'Older question', 'Older answer', '2026-11-01T00:00:00.000Z')");
  migrate();
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
  assert.ok(columns.includes('calendar_event_id'));
  assert.ok(columns.includes('due_precision'));
  assert.deepEqual(db.prepare('SELECT id, due_precision FROM tasks').all(), [{ id: 7, due_precision: 'time' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_jobs WHERE task_id = 7').get().count, 1);
  const namespace = db.prepare("SELECT value FROM calendar_meta WHERE key = 'instance_id'").get().value;
  assert.match(namespace, /^[0-9a-f]{32}$/);
  migrate();
  assert.equal(db.prepare("SELECT value FROM calendar_meta WHERE key = 'instance_id'").get().value, namespace);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM owner_dialogue_fts WHERE owner_dialogue_fts MATCH 'Older'").get().count, 1);
});
