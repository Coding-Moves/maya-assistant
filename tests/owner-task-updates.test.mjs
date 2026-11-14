import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { createTask, openTasks } = await import('../src/db/repos/tasks.ts');
const { handleOwnerTaskUpdateConfirmation, stageOwnerTaskUpdate } = await import('../src/features/owner-task-updates.ts');
migrate();
after(() => db.close());

test('an owner media update is previewed then applied once, without losing provenance', async () => {
  const id = createTask({ subject: 'MTH1304', type: 'quiz', title: 'Jumble Match Quiz', dueAt: '2027-01-10T09:00:00.000Z' });
  const preview = await stageOwnerTaskUpdate('The image has the corrected MTH1304 deadline. Update it.', '123@s.whatsapp.net', 'wa-media-1', async () => ({
    actions: [{ op: 'update', title: 'Jumble Match Quiz', due_at: '2027-01-12T09:00:00+05:00' }],
  }));
  assert.match(preview, /Update: MTH1304 — Jumble Match Quiz/);
  const reply = handleOwnerTaskUpdateConfirmation('yes', '123@s.whatsapp.net');
  assert.match(reply, /1 updated/);
  const task = openTasks().find((item) => item.id === id);
  assert.equal(task?.subject, 'MTH1304');
  assert.equal(task?.dueAt, '2027-01-12T04:00:00.000Z');
  assert.equal(handleOwnerTaskUpdateConfirmation('yes', '123@s.whatsapp.net'), null);
});

test('an ambiguous media change is never applied by a broad confirmation', async () => {
  createTask({ subject: 'CS101', type: 'quiz', title: 'Quiz 1' });
  createTask({ subject: 'CS102', type: 'quiz', title: 'Quiz 1' });
  const preview = await stageOwnerTaskUpdate('Update Quiz 1 from this screenshot.', '123@s.whatsapp.net', 'wa-media-2', async () => ({
    actions: [{ op: 'update', title: 'Quiz 1', due_at: '2027-01-15T09:00:00+05:00' }],
  }));
  assert.match(preview, /Need clarification/);
  assert.match(handleOwnerTaskUpdateConfirmation('yes', '123@s.whatsapp.net'), /need a clearer/i);
  assert.equal(openTasks().filter((task) => task.title === 'Quiz 1').every((task) => task.dueAt === null), true);
});
