import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '923001234567@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { createTask, openTasks } = await import('../src/db/repos/tasks.ts');
const { handleOwnerText } = await import('../src/features/commands.ts');
const { clearCompletionContext } = await import('../src/features/natural-done.ts');
const { ask: askQuestion } = await import('../src/features/ask.ts');

migrate();
after(() => db.close());

const replies = [];
const questions = [];
const send = async (text) => { replies.push(text); return true; };
const ask = async (text) => { questions.push(text); };

test('only open task can be completed naturally in English', async () => {
  clearCompletionContext();
  const id = createTask({ type: 'quiz', title: 'Chapter 1 quiz' });
  await handleOwnerText("I've done it", send, ask);
  assert.match(replies.at(-1), /ticked off Chapter 1 quiz/);
  assert.equal(openTasks().some((task) => task.id === id), false);
  assert.deepEqual(questions, []);
});

test('ambiguous Roman Urdu completion asks by name, then accepts a name', async () => {
  clearCompletionContext();
  const quiz = createTask({ type: 'quiz', title: 'Math quiz' });
  createTask({ type: 'assignment', title: 'Essay' });
  await handleOwnerText('ho gaya', send, ask);
  assert.match(replies.at(-1), /Which one did you finish/);
  assert.match(replies.at(-1), /Math quiz/);
  assert.match(replies.at(-1), /Essay/);
  assert.doesNotMatch(replies.at(-1), /#\d|done \d/);
  await handleOwnerText('Math quiz', send, ask);
  assert.match(replies.at(-1), /ticked off Math quiz/);
  assert.equal(openTasks().some((task) => task.id === quiz), false);
  assert.deepEqual(questions, []);
});

test('recently discussed task wins when several tasks are open', async () => {
  clearCompletionContext();
  createTask({ type: 'quiz', title: 'Science quiz' });
  await askQuestion('What about Essay?', async () => 'Your Essay is due tomorrow.', send, async (work) => work());
  await handleOwnerText('ہو گیا', send, ask);
  assert.match(replies.at(-1), /ticked off Essay/);
  assert.deepEqual(openTasks().map((task) => task.title), ['Science quiz']);
});

test('done number still uses the explicit command and small talk reaches ask', async () => {
  clearCompletionContext();
  const id = createTask({ type: 'quiz', title: 'Physics quiz' });
  await handleOwnerText(`done ${id}`, send, ask);
  assert.match(replies.at(-1), /ticked off Physics quiz/);
  await handleOwnerText('hi', send, ask);
  assert.deepEqual(questions, ['hi']);
});
