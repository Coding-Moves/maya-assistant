import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'self';
process.env.DATABASE_PATH = ':memory:';
process.env.GROUP_ALLOWLIST = 'allowed@g.us';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { insertMessage } = await import('../src/db/repos/messages.ts');
const { createTask } = await import('../src/db/repos/tasks.ts');
const { ask } = await import('../src/features/ask.ts');

migrate();
after(() => db.close());

test('answers from allowlisted context', async () => {
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
    async (work) => work(),
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

test('self mode skips typing presence and sends only a fast answer', async () => {
  const events = [];
  await ask(
    'Hello',
    async () => {
      events.push('generate');
      return 'Hi!';
    },
    async (value) => {
      events.push(value);
      return true;
    },
    async () => { throw new Error('Self mode must not show typing'); },
    20,
  );
  assert.deepEqual(events, ['generate', 'Hi!']);
});

test('self mode sends delayed thinking progress for a slow answer', async () => {
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
    async () => { throw new Error('Self mode must not show typing'); },
    5,
  );
  assert.deepEqual(replies, ['thinking...', 'Math quiz.']);
});

test('self mode sends an error reply after AI failure', async () => {
  const events = [];
  await ask(
    'What is due?',
    async () => { throw new Error('API unavailable'); },
    async (text) => {
      events.push(text);
      return true;
    },
    async () => { throw new Error('Self mode must not show typing'); },
  );
  assert.deepEqual(events, [
    'I could not answer right now. Please try again later.',
  ]);
});
