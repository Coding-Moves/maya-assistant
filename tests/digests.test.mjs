import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.TIMEZONE = 'America/New_York';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { insertMessage } = await import('../src/db/repos/messages.ts');
const { createTask, openTasks, updateTask } =
  await import('../src/db/repos/tasks.ts');
const { runDigest } = await import('../src/features/digests.ts');

migrate();
after(() => db.close());

test('morning and evening select local calendar days across daylight saving time', async () => {
  const today = createTask({
    type: 'quiz',
    title: 'Today quiz',
    dueAt: '2026-03-08T04:00:00Z', // March 7, 11 PM in New York
  });
  const tomorrowEarly = createTask({
    type: 'assignment',
    title: 'Tomorrow early',
    dueAt: '2026-03-08T05:30:00Z', // March 8, 12:30 AM EST
  });
  const tomorrowLate = createTask({
    type: 'exam',
    title: 'Tomorrow late',
    dueAt: '2026-03-09T03:30:00Z', // March 8, 11:30 PM EDT
  });
  createTask({
    type: 'quiz',
    title: 'Day after tomorrow',
    dueAt: '2026-03-09T04:30:00Z',
  });
  const now = new Date('2026-03-08T04:30:00Z'); // March 7, 11:30 PM EST
  const sent = [];
  const send = async (text) => {
    sent.push(text);
    return true;
  };

  assert.equal(await runDigest('morning', now, send), true);
  assert.match(sent[0], /Today quiz/);
  assert.doesNotMatch(sent[0], /Tomorrow early/);
  assert.equal(
    openTasks().find((task) => task.id === today)?.remindedMorning,
    1,
  );

  assert.equal(await runDigest('evening', now, send), true);
  assert.match(sent[1], /Tomorrow early/);
  assert.match(sent[1], /Tomorrow late/);
  assert.doesNotMatch(sent[1], /Day after tomorrow/);
  assert.equal(
    openTasks().find((task) => task.id === tomorrowEarly)?.remindedEvening,
    1,
  );
  assert.equal(
    openTasks().find((task) => task.id === tomorrowLate)?.remindedEvening,
    1,
  );
  assert.equal(await runDigest('evening', now, send), false);
  assert.equal(sent.length, 2);
});

test('a failed send leaves reminder flags clear for a retry', async () => {
  const id = createTask({
    type: 'quiz',
    title: 'Retry quiz',
    dueAt: '2026-04-02T14:00:00Z',
  });
  const now = new Date('2026-04-02T11:00:00Z');
  assert.equal(await runDigest('morning', now, async () => false), false);
  assert.equal(openTasks().find((task) => task.id === id)?.remindedMorning, 0);
  assert.equal(await runDigest('morning', now, async () => true), true);
  assert.equal(openTasks().find((task) => task.id === id)?.remindedMorning, 1);
});

test('a due date changed during sending is not marked reminded', async () => {
  const sourceMsgId = insertMessage({
    externalId: 'moved-during-reminder',
    chatId: 'test@g.us',
    text: 'Quiz moved',
    sentAt: '2026-05-01T10:00:00Z',
  });
  const id = createTask({
    sourceMsgId,
    type: 'quiz',
    title: 'Moving quiz',
    dueAt: '2026-05-02T14:00:00Z',
  });
  const sent = await runDigest(
    'morning',
    new Date('2026-05-02T11:00:00Z'),
    async () => {
      updateTask(id, { lastMsgId: sourceMsgId, dueAt: '2026-05-03T14:00:00Z' });
      return true;
    },
  );
  assert.equal(sent, true);
  assert.equal(openTasks().find((task) => task.id === id)?.remindedMorning, 0);
});
