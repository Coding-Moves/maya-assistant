import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.BOT_MODE = 'self';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { createTask, openTasks } = await import('../src/db/repos/tasks.ts');
const { handleOwnerText } = await import('../src/features/commands.ts');
const { ownerInput } = await import('../src/channels/whatsapp/trigger.ts');

migrate();
after(() => db.close());

test('command aliases reply without calling AI', async () => {
  const id = createTask({ type: 'quiz', title: 'Math quiz' });
  const replies = [];
  const questions = [];
  const send = async (text) => {
    replies.push(text);
    return true;
  };
  const ask = async (text) => {
    questions.push(text);
  };

  for (const input of ['help', '?', 'task', 'tasks', 'list']) {
    await handleOwnerText(input, send, ask);
  }
  await handleOwnerText(ownerInput('maya task', true), send, ask);
  assert.match(replies[0], /Commands:/);
  assert.match(replies[1], /Commands:/);
  for (const reply of replies.slice(2)) assert.match(reply, /Math quiz/);

  await handleOwnerText('complete nope', send, ask);
  assert.match(replies.at(-1), /Use: done/);
  assert.equal(openTasks().length, 1);

  await handleOwnerText(`complete ${id}`, send, ask);
  assert.match(replies.at(-1), /marked done/);
  assert.equal(openTasks().length, 0);

  const next = createTask({ type: 'assignment', title: 'Essay' });
  await handleOwnerText(`done ${next}`, send, ask);
  assert.equal(openTasks().length, 0);
  assert.deepEqual(questions, []);

  await handleOwnerText('What can you do?', send, ask);
  assert.deepEqual(questions, ['What can you do?']);
});

test('hidden debug command runs a job without calling AI', async () => {
  const replies = [];
  const jobs = [];
  const send = async (text) => {
    replies.push(text);
    return true;
  };
  const ask = async () => {
    throw new Error('Debug commands must not call AI');
  };
  const run = async (name) => {
    jobs.push(name);
    return 'not-sent';
  };

  await handleOwnerText('debug run morning', send, ask, run);
  await handleOwnerText('debug run evening', send, ask, run);
  await handleOwnerText('debug run weekly', send, ask, run);
  await handleOwnerText('debug run invalid', send, ask, run);

  assert.deepEqual(jobs, ['morning', 'evening', 'weekly']);
  assert.equal(replies.length, 4);
  assert.match(replies[0], /no message sent/);
  assert.match(replies[3], /Use: debug run/);
});
