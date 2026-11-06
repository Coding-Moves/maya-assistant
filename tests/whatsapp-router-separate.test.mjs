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
const { attachWhatsAppRouter, waitForOwnerReplies } =
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
  const viewedStatuses = [];
  const commentedStatuses = [];
  let finishDelayedMapping;
  const delayedMapping = new Promise((resolve) => { finishDelayedMapping = resolve; });
  const detach = attachWhatsAppRouter({
    ev,
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => lid === '654@lid'
          ? '123@s.whatsapp.net'
          : lid === '765@lid'
            ? delayedMapping
            : '999@s.whatsapp.net',
      },
    },
  }, undefined, async (key) => { viewedStatuses.push(key.id); },
  async (message) => { commentedStatuses.push(message.key.id); });
  try {
    const ids = [1, 2, 3, 4, 5].map((index) =>
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
        { ...message('status', 'status@broadcast', `done ${ids[4]}`, false),
          key: { id: 'status', remoteJid: 'status@broadcast', remoteJidAlt: '123@s.whatsapp.net', participant: '123@s.whatsapp.net', fromMe: false },
          broadcast: true },
        { ...message('status', 'status@broadcast', `done ${ids[4]}`, false),
          key: { id: 'status', remoteJid: 'status@broadcast', participant: '123@s.whatsapp.net', fromMe: false },
          broadcast: true },
        { ...message('stranger-status', 'status@broadcast', `done ${ids[4]}`, false),
          key: { id: 'stranger-status', remoteJid: 'status@broadcast', remoteJidAlt: '123@s.whatsapp.net', participant: '999@s.whatsapp.net', fromMe: false },
          broadcast: true },
        { ...message('lid-status', 'status@broadcast', `done ${ids[4]}`, false),
          key: { id: 'lid-status', remoteJid: 'status@broadcast', participant: '321@lid', fromMe: false },
          broadcast: true },
        { ...message('mapped-lid-status', 'status@broadcast', `done ${ids[4]}`, false),
          key: { id: 'mapped-lid-status', remoteJid: 'status@broadcast', participant: '654@lid', fromMe: false },
          broadcast: true },
        { ...message('other-lid-status', 'status@broadcast', `done ${ids[4]}`, false),
          key: { id: 'other-lid-status', remoteJid: 'status@broadcast', participant: '999@lid', fromMe: false },
          broadcast: true },
        { ...message('status-flag', '123@s.whatsapp.net', `done ${ids[4]}`, false), broadcast: true },
      ],
    });

    await waitForOwnerReplies();
    assert.deepEqual(openTasks().map(({ id }) => id), ids.slice(1));
    assert.deepEqual(viewedStatuses, ['status', 'lid-status', 'mapped-lid-status']);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(viewedStatuses, ['status', 'lid-status', 'mapped-lid-status']);
    assert.deepEqual(commentedStatuses, ['status', 'lid-status', 'mapped-lid-status']);
    assert.deepEqual(
      db.prepare('SELECT text FROM messages ORDER BY id').all(),
      [{ text: 'Quiz on Monday' }],
    );

    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        message('late-owner', '654@lid', `done ${ids[3]}`, false),
        message('other-lid', '999@lid', `done ${ids[4]}`, false),
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(openTasks().map(({ id }) => id), [ids[1], ids[2], ids[4]]);

    const delayedId = createTask({ type: 'quiz', title: 'Quiz after disconnect' });
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [message('late-result', '765@lid', `done ${delayedId}`, false)],
    });
    detach();
    finishDelayedMapping('123@s.whatsapp.net');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(openTasks().some((task) => task.id === delayedId), true);
  } finally {
    detach();
    clearOwnerIdentity();
  }
});

test('owner messages are serialized and excess work is bounded', async () => {
  setOwnerIdentity({ chatJid: '123@s.whatsapp.net', knownJids: new Set(['123@s.whatsapp.net']) });
  const ev = new EventEmitter();
  const detach = attachWhatsAppRouter({ ev });
  try {
    const ids = Array.from({ length: 5 }, (_, i) => createTask({ type: 'quiz', title: `Burst quiz ${i}` }));
    ev.emit('messages.upsert', { type: 'notify', messages: ids.map((id) => ({
      key: { id: `burst-${id}`, remoteJid: '123@s.whatsapp.net', fromMe: false },
      message: { conversation: `done ${id}` }, messageTimestamp: 1_700_000_000,
    })) });
    await waitForOwnerReplies();
    assert.equal(openTasks().some(({ id }) => id === ids[4]), true);
    assert.ok(ids.slice(0, 4).every((id) => !openTasks().some((task) => task.id === id)));
  } finally { detach(); clearOwnerIdentity(); }
});
