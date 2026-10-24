import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.GROUP_ALLOWLIST = 'allowed@g.us';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { createTask, openTasks } = await import('../src/db/repos/tasks.ts');
const { clearOwnerIdentity, resolveOwnerIdentity, setOwnerIdentity } =
  await import('../src/channels/whatsapp/identity.ts');
const { attachWhatsAppRouter } =
  await import('../src/channels/whatsapp/router.ts');

migrate();
after(() => db.close());

test('separate mode handles only inbound owner chat and ignores its own outgoing group messages', async () => {
  setOwnerIdentity(
    await resolveOwnerIdentity({
      signalRepository: {
        lidMapping: { getLIDForPN: async () => '321@lid' },
      },
    }),
  );
  const ev = new EventEmitter();
  const detach = attachWhatsAppRouter({ ev });
  try {
    const ids = [1, 2, 3].map((index) =>
      createTask({ type: 'quiz', title: `Quiz ${index}` }),
    );
    const message = (id, remoteJid, text, fromMe) => ({
      key: { id, remoteJid, fromMe },
      message: { conversation: text },
      messageTimestamp: 1_700_000_000,
    });
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        message('owner', '321@lid', `done ${ids[0]}`, false),
        message('stranger', '999@s.whatsapp.net', `done ${ids[1]}`, false),
        message('outgoing', '123@s.whatsapp.net', `done ${ids[2]}`, true),
        message('own-group', 'allowed@g.us', 'Outgoing from Maya', true),
        message('inbound-group', 'allowed@g.us', 'Quiz on Monday', false),
      ],
    });

    assert.deepEqual(openTasks().map(({ id }) => id), ids.slice(1));
    assert.deepEqual(
      db.prepare('SELECT text FROM messages ORDER BY id').all(),
      [{ text: 'Quiz on Monday' }],
    );
  } finally {
    detach();
    clearOwnerIdentity();
  }
});
