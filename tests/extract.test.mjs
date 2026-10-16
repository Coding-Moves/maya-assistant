import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.GROUP_ALLOWLIST = 'allowed@g.us';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { insertMessage, getUnprocessed, pendingFailureBatches } =
  await import('../src/db/repos/messages.ts');
const { openTasks } = await import('../src/db/repos/tasks.ts');
const { extractOnce } = await import('../src/features/extract.ts');

migrate();
after(() => db.close());

function addMessage(externalId, text) {
  return insertMessage({
    externalId,
    chatId: 'allowed@g.us',
    text,
    sentAt: '2026-10-16T12:00:00.000Z',
  });
}

test('creates, updates, and cancels tasks with message provenance', async () => {
  const createMessageId = addMessage('create', 'Quiz on Monday');
  await extractOnce(
    async () => ({
      actions: [
        {
          op: 'create',
          subject: 'Course',
          type: 'quiz',
          title: 'Quiz',
          details: null,
          due_at: '2026-10-19T10:00:00Z',
          source_msg_ref: createMessageId,
        },
      ],
    }),
    async () => true,
  );
  const [created] = openTasks();
  assert.equal(created.sourceMsgId, createMessageId);
  assert.equal(created.lastMsgId, createMessageId);
  assert.equal(getUnprocessed(10).length, 0);

  const updateMessageId = addMessage('update', 'Quiz moved');
  await extractOnce(
    async () => ({
      actions: [
        {
          op: 'update',
          task_id: created.id,
          due_at: '2026-10-20T10:00:00Z',
          source_msg_ref: updateMessageId,
        },
      ],
    }),
    async () => true,
  );
  assert.equal(openTasks()[0].dueAt, '2026-10-20T10:00:00.000Z');
  assert.equal(openTasks()[0].lastMsgId, updateMessageId);

  const cancelMessageId = addMessage('cancel', 'Quiz cancelled');
  await extractOnce(
    async () => ({
      actions: [
        {
          op: 'cancel',
          task_id: created.id,
          reason: 'Cancelled',
          source_msg_ref: cancelMessageId,
        },
      ],
    }),
    async () => true,
  );
  assert.equal(openTasks().length, 0);
  assert.deepEqual(
    db
      .prepare('SELECT status, last_msg_id FROM tasks WHERE id = ?')
      .get(created.id),
    {
      status: 'cancelled',
      last_msg_id: cancelMessageId,
    },
  );
});

test('rolls back invalid actions, retries, quarantines, and notifies once', async () => {
  const messageId = addMessage('bad', 'Invalid task reference');
  const before = db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
  const notifications = [];
  const generate = async () => ({
    actions: [
      {
        op: 'create',
        subject: null,
        type: 'quiz',
        title: 'Should roll back',
        details: null,
        due_at: null,
        source_msg_ref: messageId,
      },
      {
        op: 'update',
        task_id: 999999,
        due_at: null,
        source_msg_ref: messageId,
      },
    ],
  });
  const send = async (text) => {
    notifications.push(text);
    return false;
  };

  await extractOnce(generate, send);
  await extractOnce(generate, send);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count,
    before,
  );
  assert.equal(getUnprocessed(10)[0].extractAttempts, 2);
  await extractOnce(generate, send);
  assert.equal(getUnprocessed(10).length, 0);
  assert.deepEqual(
    db
      .prepare('SELECT processed, extract_attempts FROM messages WHERE id = ?')
      .get(messageId),
    {
      processed: -1,
      extract_attempts: 3,
    },
  );
  assert.equal(pendingFailureBatches().length, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], new RegExp(`message IDs: ${messageId}`));
  await extractOnce(
    async () => {
      throw new Error('Should skip empty batch');
    },
    async (text) => {
      notifications.push(text);
      return true;
    },
  );
  assert.equal(pendingFailureBatches().length, 0);
  assert.equal(notifications.length, 2);
});
