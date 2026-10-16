import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.DATABASE_PATH = ':memory:';
process.env.GEMINI_API_KEY = 'test';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { insertMessage } = await import('../src/db/repos/messages.ts');
const { createTask, markReminded, openTasks, updateTask } = await import('../src/db/repos/tasks.ts');

after(() => db.close());

test('a reminder cannot mark a due date that changed during sending', () => {
  migrate();
  const sourceMsgId = insertMessage({
    externalId: 'reminder-race',
    chatId: 'test@g.us',
    text: 'Quiz moved',
    sentAt: '2026-10-16T09:00:00Z',
  });
  assert.notEqual(sourceMsgId, null);

  const originalDueAt = '2026-10-20T09:00:00Z';
  const newDueAt = '2026-10-21T09:00:00Z';
  const taskId = createTask({ sourceMsgId, type: 'quiz', title: 'Quiz', dueAt: originalDueAt });

  assert.equal(updateTask(taskId, { lastMsgId: sourceMsgId, dueAt: newDueAt }), true);
  assert.equal(markReminded(taskId, 'morning', originalDueAt), false);
  assert.equal(openTasks()[0]?.remindedMorning, 0);

  assert.equal(markReminded(taskId, 'morning', newDueAt), true);
  assert.equal(openTasks()[0]?.remindedMorning, 1);
});
