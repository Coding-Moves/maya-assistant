import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.TIMEZONE = 'Asia/Karachi';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { openTasks, markDone } = await import('../src/db/repos/tasks.ts');
const { VuClassicTodoSource } = await import('../src/sources/vu/classic-todo.ts');
const folder = mkdtempSync(join(tmpdir(), 'maya-vu-test-'));
const path = join(folder, 'todo.csv');
const header = 'source_id,kind,course,title,due_date,due_time\n';
migrate();
after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });

test('imports only quiz and assignment deadlines, then updates without duplicates', async () => {
  writeFileSync(path, header + 'q1,quiz,CS101,Quiz 1,2026-11-05,23:59\na1,assignment,CS101,Assignment 1,2026-11-06,\n');
  const source = new VuClassicTodoSource(path);
  await source.start();
  assert.deepEqual(source.counts, { created: 2, updated: 0, unchanged: 0 });
  assert.equal(openTasks().length, 2);
  const assignment = openTasks().find((task) => task.type === 'assignment');
  assert.equal(assignment.duePrecision, 'date');
  assert.equal(assignment.dueAt, '2026-11-06T18:59:00.000Z');
  assert.equal(openTasks().find((task) => task.type === 'quiz').dueAt, '2026-11-05T18:59:00.000Z');
  await source.start();
  assert.deepEqual(source.counts, { created: 0, updated: 0, unchanged: 2 });
  writeFileSync(path, header + 'q1,quiz,CS101,Quiz 1,2026-11-07,23:59\na1,assignment,CS101,Assignment 1,2026-11-06,\n');
  await source.start();
  assert.deepEqual(source.counts, { created: 0, updated: 1, unchanged: 1 });
  assert.equal(openTasks().length, 2);
  assert.equal(openTasks().find((task) => task.type === 'quiz').dueAt, '2026-11-07T18:59:00.000Z');
  markDone(assignment.id);
  await source.start();
  assert.equal(openTasks().length, 1);
});

test('rejects non-course activity and rolls back malformed batches', async () => {
  const before = db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
  writeFileSync(path, header + 'q2,quiz,CS101,Quiz 2,2026-11-09,23:59\nn1,notice,CS101,Event,2026-11-10,\n');
  const source = new VuClassicTodoSource(path);
  await assert.rejects(source.start(), /kind must be quiz or assignment/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, before);
});
