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
});
