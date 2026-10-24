import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '923001234567@s.whatsapp.net';
process.env.OWNER_NAME = 'Muawiya';
process.env.DATABASE_PATH = ':memory:';
process.env.GROUP_ALLOWLIST = 'allowed@g.us';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
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
