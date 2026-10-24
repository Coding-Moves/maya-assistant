import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '923001234567@s.whatsapp.net';
process.env.OWNER_NAME = 'Muawiya';
process.env.DATABASE_PATH = ':memory:';
process.env.TIMEZONE = 'Asia/Karachi';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { createTask, markDone, openTasks } = await import('../src/db/repos/tasks.ts');
const { handleOwnerText } = await import('../src/features/commands.ts');
const { runDigest } = await import('../src/features/digests.ts');
const { runWeeklyPlan } = await import('../src/features/weeklyPlan.ts');

migrate();
after(() => db.close());

test('separate commands sound friendly and name the completed task', async () => {
  const id = createTask({ type: 'quiz', title: 'Chapter 1 quiz' });
  const replies = [];
  const send = async (text) => { replies.push(text); return true; };
  const noAi = async () => { throw new Error('Commands must not call AI'); };
  await handleOwnerText('help', send, noAi);
  await handleOwnerText('tasks', send, noAi);
  await handleOwnerText(`done ${id}`, send, noAi);
  assert.match(replies[0], /keep an eye on your chosen groups/);
  assert.match(replies[1], /Chapter 1 quiz/);
  assert.match(replies[2], /ticked off Chapter 1 quiz/);
  assert.equal(openTasks().some((task) => task.id === id), false);
});

test('two tasks are described in a short sentence', async () => {
  const first = createTask({ type: 'quiz', title: 'Math quiz' });
  const second = createTask({ type: 'assignment', title: 'Essay' });
  const replies = [];
  await handleOwnerText('tasks', async (text) => { replies.push(text); return true; });
  assert.match(replies[0], /Math quiz and Essay coming up/);
  assert.doesNotMatch(replies[0], /•|\n/);
  markDone(first);
  markDone(second);
});

test('separate digest reads like a caring reminder', async () => {
  createTask({ type: 'quiz', title: 'Morning quiz', dueAt: '2026-10-24T05:00:00Z' });
  const replies = [];
  assert.equal(await runDigest('morning', new Date('2026-10-24T00:00:00Z'), async (text) => {
    replies.push(text);
    return true;
  }), true);
  assert.match(replies[0], /Good morning Muawiya/);
  assert.match(replies[0], /Morning quiz/);
  assert.match(replies[0], /You've got this/);
  assert.doesNotMatch(replies[0], /#\d/);
});

test('separate weekly plan asks for a short caring message', async () => {
  createTask({ type: 'assignment', title: 'Essay', dueAt: '2026-10-26T09:00:00Z' });
  let prompt = '';
  assert.equal(await runWeeklyPlan(new Date('2026-10-24T00:00:00Z'), async (value) => {
    prompt = value;
    return 'You have your essay this week.';
  }, async () => true), true);
  assert.match(prompt, /Muawiya/);
  assert.match(prompt, /caring older sister/);
  assert.match(prompt, /Essay/);
});
