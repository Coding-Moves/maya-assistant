import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '923001234567@s.whatsapp.net';
process.env.OWNER_NAME = 'Muawiya';
process.env.DATABASE_PATH = ':memory:';
process.env.GROUP_ALLOWLIST = 'allowed@g.us';
process.env.VU_LMS_SYNC = 'true';
process.env.VU_STUDENT_ID = 'test-student';
process.env.VU_PASSWORD = 'test-password';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { createTask } = await import('../src/db/repos/tasks.ts');
const { createMemory } = await import('../src/db/repos/memories.ts');
const { createTimetableDraft, confirmTimetable } = await import('../src/db/repos/timetables.ts');
const { ask, askPrompt } = await import('../src/features/ask.ts');

migrate();
after(() => db.close());

test('separate ask prompt requests a warm, honest reply in the owner language', () => {
  const prompt = askPrompt('Kal koi quiz hai?');
  assert.match(prompt, /Muawiya/);
  assert.match(prompt, /Roman Urdu/);
  assert.match(prompt, /gentle older sister/);
  assert.match(prompt, /Never invent tasks/);
  assert.match(prompt, /cannot post in groups/);
  assert.match(prompt, /configured to sign in on a schedule/);
  assert.match(prompt, /checks are scheduled, not live during each chat/);
});

test('separate ask context identifies imported VU deadlines', () => {
  const taskId = createTask({ type: 'quiz', subject: 'CS101', title: 'Quiz 1' });
  db.prepare("INSERT INTO source_tasks (source, external_id, task_id) VALUES ('vu-classic-todo', ?, ?)")
    .run('quiz:cs101:quiz 1', taskId);
  const prompt = askPrompt('Can you read my VU quiz deadlines?');
  assert.match(prompt, /"source":"vu-classic-todo"/);
  assert.match(prompt, /"title":"Quiz 1"/);
});

test('private questions receive bounded saved-memory and weekday timetable context', () => {
  createMemory({ category: 'preference', title: 'Study preference', body: 'I study best in the morning',
    lifecycle: 'permanent', sourceKind: 'owner_text' });
  const { token } = createTimetableDraft({ is_timetable: true, title: 'Classes', valid_from: null, valid_until: null,
    entries: [{ day_of_week: 2, start_local: '09:00', end_local: '10:00', subject: 'CS101', location: null, teacher: null, uncertainty: null },
      { day_of_week: 3, start_local: '11:00', end_local: '12:00', subject: 'MTH501', location: null, teacher: null, uncertainty: null }] },
  'owner@s.whatsapp.net', 'Asia/Karachi', 'media-1');
  confirmTimetable(token, 'owner@s.whatsapp.net');
  const memoryPrompt = askPrompt('What is my study preference?');
  assert.match(memoryPrompt, /I study best in the morning/);
  const timetablePrompt = askPrompt('What class do I have on Tuesday?');
  assert.match(timetablePrompt, /"subject":"CS101"/);
  assert.doesNotMatch(timetablePrompt, /"subject":"MTH501"/);
});

test('slow separate answer uses typing and never sends thinking text', async () => {
  const events = [];
  await ask('Any quiz?', async () => {
    events.push('generate');
    await new Promise((resolve) => setTimeout(resolve, 25));
    return 'Your quiz is tomorrow.';
  }, async (text) => {
    events.push(text);
    return true;
  }, async (work) => {
    events.push('composing');
    try { return await work(); }
    finally { events.push('paused'); }
  }, 5);
  assert.deepEqual(events, ['composing', 'generate', 'paused', 'Your quiz is tomorrow.']);
});

test('separate ask pauses typing and apologizes on AI failure', async () => {
  const events = [];
  await ask('Any quiz?', async () => { throw new Error('API down'); }, async (text) => {
    events.push(text);
    return true;
  }, async (work) => {
    events.push('composing');
    try { return await work(); }
    finally { events.push('paused'); }
  });
  assert.deepEqual(events, [
    'composing',
    'paused',
    "Sorry, I'm having trouble answering right now. Could you try again in a little while?",
  ]);
});
