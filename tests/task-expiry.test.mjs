import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { createTask, expirePastDueTasks, openTasks } = await import('../src/db/repos/tasks.ts');
const { upsertVuItems } = await import('../src/sources/vu/classic-todo.ts');
migrate();
after(() => db.close());

test('past deadline becomes expired, never completed', () => {
  const old = createTask({ type: 'quiz', subject: 'MTH1304', title: 'Old quiz', dueAt: '2026-01-01T00:00:00.000Z' });
  const future = createTask({ type: 'quiz', title: 'Future quiz', dueAt: '2027-01-01T00:00:00.000Z' });
  assert.equal(expirePastDueTasks(new Date('2026-02-01T00:00:00.000Z')), 1);
  assert.equal(openTasks().some((task) => task.id === old), false);
  assert.equal(openTasks().some((task) => task.id === future), true);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(old).status, 'expired');
});

test('VU rescheduling into the future reopens an expired source task', () => {
  const item = { externalId: 'mth1304-quiz', kind: 'quiz', course: 'MTH1304', title: 'Quiz 1',
    dueAt: '2026-01-01T09:00:00.000Z', duePrecision: 'time' };
  assert.equal(upsertVuItems([item]).created, 1);
  expirePastDueTasks(new Date('2026-02-01T00:00:00.000Z'));
  assert.equal(upsertVuItems([{ ...item, dueAt: '2027-01-01T09:00:00.000Z' }]).updated, 1);
  assert.ok(openTasks().some(({ title, subject }) => title === 'Quiz 1' && subject === 'MTH1304'));
});
