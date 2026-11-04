import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'self';
process.env.DATABASE_PATH = ':memory:';
process.env.GROUP_ALLOWLIST = 'allowed@g.us';
process.env.MEDIA_ENABLED = 'true';
process.env.MEDIA_MAX_BYTES = '5';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { getUnprocessed, pendingFailureBatches, recentMessages } = await import('../src/db/repos/messages.ts');
const { pendingMediaJobs } = await import('../src/db/repos/media.ts');
const { enqueueGroupMedia, processPendingMedia } = await import('../src/features/media.ts');
const { attachWhatsAppRouter } = await import('../src/channels/whatsapp/router.ts');

migrate();
after(() => db.close());

const image = (id, caption = undefined, fileLength = 4) => ({
  key: { id, remoteJid: 'allowed@g.us', fromMe: false },
  messageTimestamp: 1_700_000_000,
  message: { imageMessage: { mimetype: 'image/jpeg', caption, fileLength, mediaKey: Buffer.from('key') } },
});

test('router queues only media from an allowlisted group', () => {
  const ev = new EventEmitter();
  const detach = attachWhatsAppRouter({ ev });
  try {
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        image('allowed-image'),
        { ...image('blocked-image'), key: { id: 'blocked-image', remoteJid: 'blocked@g.us', fromMe: false } },
      ],
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE external_id = 'allowed-image'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE external_id = 'blocked-image'").get().count, 0);
  } finally {
    detach();
    db.prepare("DELETE FROM messages WHERE external_id = 'allowed-image'").run();
  }
});

test('queues allowlisted media until vision text is ready, then deduplicates', async () => {
  assert.equal(enqueueGroupMedia(image('media-1', 'Quiz poster'), 'Class'), true);
  assert.equal(getUnprocessed(10).length, 0);
  assert.equal(pendingMediaJobs(10).length, 1);
  await processPendingMedia({
    socket: {},
    download: async () => Readable.from([Buffer.from('1234')]),
    recognize: async () => 'CS301 quiz closes Friday at 5 PM',
  });
  assert.equal(getUnprocessed(10)[0].text, 'Quiz poster\n\nCS301 quiz closes Friday at 5 PM');
  assert.equal(pendingMediaJobs(10).length, 0);
  assert.equal(enqueueGroupMedia(image('media-1', 'Quiz poster'), 'Class'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
});

test('reads an allowlisted PDF as a message for task extraction', async () => {
  const pdf = {
    ...image('pdf-1'),
    message: { documentMessage: { mimetype: 'application/pdf', fileLength: 4, mediaKey: Buffer.from('key') } },
  };
  assert.equal(enqueueGroupMedia(pdf, 'Class'), true);
  await processPendingMedia({
    socket: {},
    download: async () => Readable.from([Buffer.from('%PDF')]),
    recognize: async (bytes, mimeType) => {
      assert.equal(bytes.toString(), '%PDF');
      assert.equal(mimeType, 'application/pdf');
      return 'CS101 Assignment 2 due 5 November';
    },
  });
  assert.equal(db.prepare("SELECT text FROM messages WHERE external_id = 'pdf-1'").get().text, 'CS101 Assignment 2 due 5 November');
});

test('queues voice notes and short video for group understanding', async () => {
  const audio = { ...image('voice-group'), message: { audioMessage: {
    mimetype: 'audio/ogg; codecs=opus', fileLength: 4, mediaKey: Buffer.from('key'),
  } } };
  const video = { ...image('video-group'), message: { videoMessage: {
    mimetype: 'video/mp4', fileLength: 4, mediaKey: Buffer.from('key'),
  } } };
  assert.equal(enqueueGroupMedia(audio, 'Class'), true);
  assert.equal(enqueueGroupMedia(video, 'Class'), true);
  const types = [];
  await processPendingMedia({ socket: {}, download: async () => Readable.from([Buffer.from('1234')]),
    recognize: async (_bytes, mimeType) => { types.push(mimeType); return 'Student discussed the quiz'; } });
  assert.deepEqual(types, ['audio/ogg', 'video/mp4']);
});

test('skips images without academic text and uses a caption when oversized', async () => {
  enqueueGroupMedia(image('media-2'), 'Class');
  await processPendingMedia({
    socket: {},
    download: async () => Readable.from([Buffer.from('1234')]),
    recognize: async () => 'NO_TEXT',
  });
  assert.equal(db.prepare("SELECT processed FROM messages WHERE external_id = 'media-2'").get().processed, 1);
  assert.equal(db.prepare("SELECT text FROM messages WHERE external_id = 'media-2'").get().text, '');
  assert.ok(!recentMessages(['allowed@g.us'], 20).some((message) => message.externalId === 'media-2'));
  enqueueGroupMedia(image('media-3', 'Assignment due Monday', 6), 'Class');
  assert.equal(db.prepare("SELECT text FROM messages WHERE external_id = 'media-3'").get().text, 'Assignment due Monday');
  enqueueGroupMedia(image('media-stream-over', 'Quiz on Tuesday', null), 'Class');
  await processPendingMedia({
    socket: {},
    download: async () => Readable.from([Buffer.from('123456')]),
    recognize: async () => { throw new Error('Should not call Gemini'); },
  });
  assert.equal(db.prepare("SELECT text FROM messages WHERE external_id = 'media-stream-over'").get().text, 'Quiz on Tuesday');
  assert.equal(pendingMediaJobs(10).length, 0);
});

test('quarantines a media item after three failed attempts and leaves no pending job', async () => {
  enqueueGroupMedia(image('media-4'), 'Class');
  const fail = () => processPendingMedia({
    socket: {},
    download: async () => { throw new Error('download failed'); },
    recognize: async () => { throw new Error('Should not call Gemini'); },
  });
  await fail();
  await fail();
  await fail();
  assert.equal(db.prepare("SELECT processed FROM messages WHERE external_id = 'media-4'").get().processed, -1);
  assert.equal(db.prepare("SELECT text FROM messages WHERE external_id = 'media-4'").get().text, '');
  assert.ok(!recentMessages(['allowed@g.us'], 20).some((message) => message.externalId === 'media-4'));
  assert.equal(pendingMediaJobs(10).length, 0);
  assert.equal(pendingFailureBatches().length, 1);
});
