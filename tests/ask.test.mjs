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
  assert.match(prompt, /About you:/);
  assert.match(prompt, /allowlisted WhatsApp groups/);
  assert.match(prompt, /reminders and a weekly plan when the app is running/);
  assert.match(prompt, /Respond naturally to greetings and small talk/);
  assert.match(
    prompt,
    /For deadline or task questions without supporting data/,
  );
});

test('cancels the thinking timer after a fast answer', async () => {
  const replies = [];
  await ask(
    'Hello',
    async () => 'Hi!',
    async (value) => {
      replies.push(value);
      return true;
    },
    10,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(replies, ['Hi!']);
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

test('marks thinking as progress so it can be skipped at low quota', async () => {
  const replies = [];
  await ask(
    'What is due?',
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'Math quiz.';
    },
    async (text, kind) => {
      if (kind === 'progress') return false;
      replies.push(text);
      return true;
    },
    5,
  );
  assert.deepEqual(replies, ['Math quiz.']);
});
