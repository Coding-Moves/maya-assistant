import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'self';
process.env.DATABASE_PATH = ':memory:';
process.env.GROUP_ALLOWLIST = 'allowed@g.us';

const { config } = await import('../src/config/env.ts');
const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { parseMessageText } = await import('../src/channels/whatsapp/parse.ts');
const { attachWhatsAppRouter } =
  await import('../src/channels/whatsapp/router.ts');

migrate();
after(() => db.close());

test('extracts plain text and captions through ephemeral and view-once wrappers', () => {
  assert.equal(parseMessageText({ conversation: 'Plain text' }), 'Plain text');
  assert.equal(
    parseMessageText({ extendedTextMessage: { text: 'Extended' } }),
    'Extended',
  );
  assert.equal(
    parseMessageText({ imageMessage: { caption: 'Image caption' } }),
    'Image caption',
  );
  assert.equal(
    parseMessageText({ documentMessage: { caption: 'Document caption' } }),
    'Document caption',
  );
  assert.equal(
    parseMessageText({ videoMessage: { caption: 'Video caption' } }),
    'Video caption',
  );
  assert.equal(
    parseMessageText({
      ephemeralMessage: {
        message: {
          viewOnceMessageV2: {
            message: { imageMessage: { caption: 'Nested caption' } },
          },
        },
      },
    }),
    'Nested caption',
  );
  assert.equal(parseMessageText({ conversation: '   ' }), null);
  assert.equal(parseMessageText({ stickerMessage: {} }), null);
});

test('stores only live allowlisted text, with metadata, UTC time, and deduplication', async () => {
  const ev = new EventEmitter();
  const groupId = config.GROUP_ALLOWLIST[0];
  const sock = {
    ev,
    groupFetchAllParticipating: async () => ({
      [groupId]: { id: groupId, subject: 'Allowed group' },
    }),
  };
  const detach = attachWhatsAppRouter(sock);
  try {
    ev.emit('connection.update', { connection: 'open' });
    await new Promise((resolve) => setImmediate(resolve));

    const message = (id, remoteJid, text, timestamp = 1_700_000_000) => ({
      key: { id, remoteJid, fromMe: false },
      message: { conversation: text },
      messageTimestamp: timestamp,
      pushName: 'Student',
    });
    ev.emit('messages.upsert', {
      type: 'append',
      messages: [message('history', groupId, 'Past message')],
    });
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        message('keep', groupId, 'Quiz on Monday'),
        message('keep', groupId, 'Quiz on Monday'),
        {
          ...message('caption', groupId, '', { toString: () => '1700000001' }),
          message: {
            viewOnceMessage: {
              message: { documentMessage: { caption: 'Assignment posted' } },
            },
          },
        },
        message('blocked', 'blocked@g.us', 'Private group'),
        message('direct', 'someone@s.whatsapp.net', 'Private chat'),
        message('bot', groupId, `🤖 ${config.BOT_NAME}: reply`),
        message('no-time', groupId, 'Missing time', null),
      ],
    });

    const rows = db
      .prepare(
        'SELECT source, external_id, chat_id, chat_name, sender_name, text, sent_at FROM messages ORDER BY id',
      )
      .all();
    assert.deepEqual(rows, [
      {
        source: 'whatsapp',
        external_id: 'keep',
        chat_id: groupId,
        chat_name: 'Allowed group',
        sender_name: 'Student',
        text: 'Quiz on Monday',
        sent_at: new Date(1_700_000_000_000).toISOString(),
      },
      {
        source: 'whatsapp',
        external_id: 'caption',
        chat_id: groupId,
        chat_name: 'Allowed group',
        sender_name: 'Student',
        text: 'Assignment posted',
        sent_at: new Date(1_700_000_001_000).toISOString(),
      },
    ]);
  } finally {
    detach();
  }
});
