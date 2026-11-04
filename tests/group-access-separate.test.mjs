import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.GROUP_ALLOWLIST = 'class@g.us';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { attachWhatsAppRouter } = await import('../src/channels/whatsapp/router.ts');
const { joinedGroups } = await import('../src/db/repos/groups.ts');
const { askPrompt } = await import('../src/features/ask.ts');
migrate();
after(() => db.close());

test('separate mode stores every joined group and selects a named group for private Q&A', async () => {
  const ev = new EventEmitter();
  const sock = { ev, user: { id: 'bot@s.whatsapp.net', lid: 'bot@lid' }, groupFetchAllParticipating: async () => ({
    'class@g.us': { id: 'class@g.us', subject: 'Class' },
    'family@g.us': { id: 'family@g.us', subject: 'Family' },
  }) };
  const detach = attachWhatsAppRouter(sock);
  try {
    ev.emit('connection.update', { connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));
    const message = (id, chat, text) => ({
      key: { id, remoteJid: chat, fromMe: false },
      messageTimestamp: 1_700_000_000,
      message: { conversation: text },
    });
    ev.emit('messages.upsert', { type: 'notify', messages: [
      message('class-1', 'class@g.us', 'CS101 quiz is Friday'),
      message('family-1', 'family@g.us', 'Dinner at auntie’s'),
      message('other-1', 'someone@s.whatsapp.net', 'private secret'),
    ] });
    assert.deepEqual(joinedGroups().map(({ name }) => name), ['Class', 'Family']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
    const prompt = askPrompt('What is going on in Family?');
    assert.match(prompt, /Dinner at auntie/);
    assert.doesNotMatch(prompt, /CS101 quiz is Friday/);
    assert.doesNotMatch(prompt, /private secret/);
    ev.emit('group-participants.update', { id: 'family@g.us', action: 'remove', participants: [{ id: 'bot@lid' }] });
    assert.deepEqual(joinedGroups().map(({ name }) => name), ['Class']);
    assert.doesNotMatch(askPrompt('What is going on in Family?'), /Dinner at auntie/);
  } finally { detach(); }
});
