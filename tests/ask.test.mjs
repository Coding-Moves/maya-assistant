import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.GROUP_ALLOWLIST = 'allowed@g.us';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { insertMessage } = await import('../src/db/repos/messages.ts');
const { createTask } = await import('../src/db/repos/tasks.ts');
const { ask } = await import('../src/features/ask.ts');

migrate();
after(() => db.close());

test('answers from allowlisted context without an early thinking message', async () => {
  createTask({
    type: 'quiz',
    title: 'Math quiz',
    dueAt: new Date(Date.now() + 60_000).toISOString(),
  });
  insertMessage({
    externalId: 'allowed',
    chatId: 'allowed@g.us',
    text: 'Quiz is tomorrow',
    sentAt: new Date().toISOString(),
  });
  insertMessage({
    externalId: 'blocked',
    chatId: 'blocked@g.us',
    text: 'Do not include me',
    sentAt: new Date().toISOString(),
  });
  const replies = [];
  let prompt = '';
  await ask(
    'What is due?',
    async (value) => {
      prompt = value;
      return 'Math quiz is due soon.';
    },
    async (value) => {
      replies.push(value);
      return true;
    },
    50,
  );
  assert.deepEqual(replies, ['Math quiz is due soon.']);
  assert.match(prompt, /Math quiz/);
  assert.match(prompt, /Quiz is tomorrow/);
  assert.doesNotMatch(prompt, /Do not include me/);
  assert.match(prompt, /dueNext14Days/);
});

test('sends thinking before a slow answer', async () => {
  const replies = [];
  await ask(
    'What is due?',
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'Math quiz.';
    },
    async (value) => {
      replies.push(value);
      return true;
    },
    5,
  );
  assert.deepEqual(replies, ['thinking...', 'Math quiz.']);
});
