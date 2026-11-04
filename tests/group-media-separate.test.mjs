import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';
process.env.MEDIA_ENABLED = 'true';
process.env.MEDIA_MAX_BYTES = '20';
process.env.MEDIA_BATCH_SIZE = '3';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { enqueueGroupMedia, processPendingMedia } = await import('../src/features/media.ts');
migrate();
after(() => db.close());

const message = (id, content) => ({
  key: { id, remoteJid: 'family@g.us', fromMe: false },
  messageTimestamp: 1_700_000_000,
  message: content,
});

test('separate mode reads group voice, video, and text attachments', async () => {
  assert.equal(enqueueGroupMedia(message('audio', { audioMessage: {
    mimetype: 'audio/ogg; codecs=opus', fileLength: 4, mediaKey: Buffer.from('key'),
  } }), 'Family'), true);
  assert.equal(enqueueGroupMedia(message('video', { videoMessage: {
    mimetype: 'video/mp4', fileLength: 4, mediaKey: Buffer.from('key'),
  } }), 'Family'), true);
  assert.equal(enqueueGroupMedia(message('text', { documentMessage: {
    mimetype: 'text/plain', fileLength: 4, mediaKey: Buffer.from('key'),
  } }), 'Family'), true);
  const modelTypes = [];
  await processPendingMedia({ socket: {}, download: async () => Readable.from([Buffer.from('Quiz')]),
    recognize: async (_bytes, mimeType) => { modelTypes.push(mimeType); return 'Voice or video description'; } });
  assert.deepEqual(modelTypes, ['audio/ogg', 'video/mp4']);
  assert.deepEqual(db.prepare('SELECT text FROM messages ORDER BY id').all(), [
    { text: 'Voice or video description' },
    { text: 'Voice or video description' },
    { text: 'Quiz' },
  ]);
});
