import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { rememberGroup } = await import('../src/db/repos/groups.ts');
const { insertMessage } = await import('../src/db/repos/messages.ts');
const { createTask, expirePastDueTasks, openTasks } = await import('../src/db/repos/tasks.ts');
const { extractOnce } = await import('../src/features/extract.ts');
migrate();
rememberGroup('class@g.us', 'Class');
after(() => db.close());

test('a later group reschedule reopens the same expired task with message provenance', async () => {
  const id = createTask({ type: 'quiz', subject: 'MTH1304', title: 'Quiz 1',
    dueAt: '2026-01-01T09:00:00.000Z' });
  expirePastDueTasks();
  const messageId = insertMessage({ externalId: 'reschedule', chatId: 'class@g.us',
    text: 'MTH1304 Quiz 1 moved to 1 February 2027 at 9 AM',
    sentAt: new Date().toISOString() });
  await extractOnce(async (prompt) => {
    assert.match(prompt, /"status":"expired"/);
    return { actions: [{ op: 'update', task_id: id, due_at: '2027-02-01T09:00:00.000Z',
      source_msg_ref: messageId }] };
  }, async () => true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal(openTasks()[0].id, id);
  assert.equal(openTasks()[0].lastMsgId, messageId);
});

test('a different course cannot reopen an expired quiz with the same generic title', async () => {
  const id = createTask({ type: 'quiz', subject: 'CS101', title: 'Quiz 1',
    dueAt: '2026-01-01T09:00:00.000Z' });
  expirePastDueTasks();
  const messageId = insertMessage({ externalId: 'wrong-course', chatId: 'class@g.us',
    text: 'MTH1304 Quiz 1 moved to 1 February 2027 at 9 AM', sentAt: new Date().toISOString() });
  await extractOnce(async () => ({ actions: [{ op: 'update', task_id: id,
    due_at: '2027-02-01T09:00:00.000Z', source_msg_ref: messageId }] }), async () => true);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'expired');
  assert.equal(db.prepare('SELECT extract_attempts FROM messages WHERE id = ?').get(messageId).extract_attempts, 1);
});
