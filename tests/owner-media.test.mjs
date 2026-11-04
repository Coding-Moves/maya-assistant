import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.MEDIA_ENABLED = 'true';
process.env.MEDIA_MAX_BYTES = '100';
process.env.DATABASE_PATH = ':memory:';

const { handleOwnerMedia } = await import('../src/features/owner-media.ts');
const { mediaDetails } = await import('../src/features/media.ts');
const { configuredOwnerIdentity, setOwnerIdentity } = await import('../src/channels/whatsapp/identity.ts');
const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { activeTimetables } = await import('../src/db/repos/timetables.ts');
const { handleNaturalMemory } = await import('../src/features/memory-intent.ts');
setOwnerIdentity(configuredOwnerIdentity());
migrate();

test('voice note transcription reaches the command handler as plain owner text', async () => {
  const calls = [];
  const message = { key: { fromMe: false, id: 'voice-1', remoteJid: '123@s.whatsapp.net' }, message: {
    audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 4 },
  } };
  assert.equal(mediaDetails(message).mimeType, 'audio/ogg');
  await handleOwnerMedia(message, {}, async (bytes, type) => {
    calls.push([bytes.toString(), type]);
    return 'Done 1.';
  }, async (text) => { calls.push(text); }, async () => Readable.from([Buffer.from('opus')]));
  assert.deepEqual(calls, [['opus', 'audio/ogg'], 'Done 1']);
});

test('a spoken memory request saves through the same verified owner text path', async () => {
  let reply = '';
  await handleOwnerMedia({ key: { fromMe: false, id: 'voice-memory-1', remoteJid: '123@s.whatsapp.net' },
    message: { audioMessage: { mimetype: 'audio/ogg', fileLength: 4 } } }, {},
  async () => 'Remember permanently that I prefer studying in the morning',
  async (text, _send, _answer, _run, sourceRef) => {
    reply = await handleNaturalMemory(text, '123@s.whatsapp.net', sourceRef,
      async () => ({ action: 'save', lifecycle: 'permanent', category: 'preference',
        title: 'Study time', body: 'I prefer studying in the morning', date: null,
        target: null, target_id: null, page: null, entry: null, field: null,
        value: null, question: null }));
  }, async () => Readable.from([Buffer.from('opus')]));
  assert.match(reply, /remember Study time/);
  assert.equal(db.prepare("SELECT source_ref FROM memory_items WHERE title = 'Study time'").get().source_ref, 'voice-memory-1');
});

test('video, PDFs, and image stickers are recognized as media', () => {
  assert.equal(mediaDetails({ message: { videoMessage: { mimetype: 'video/mp4' } } }).mimeType, 'video/mp4');
  assert.equal(mediaDetails({ message: { documentMessage: { mimetype: 'application/pdf' } } }).mimeType, 'application/pdf');
  assert.equal(mediaDetails({ message: { stickerMessage: {} } }).mimeType, 'image/webp');
});

test('owner text attachment reaches questions without a media model request', async () => {
  let input = '';
  await handleOwnerMedia({ key: { fromMe: false, id: 'text-1', remoteJid: '123@s.whatsapp.net' },
    message: { documentMessage: { mimetype: 'text/plain', fileLength: 4 } } }, {},
  async () => { throw new Error('Text should not use Gemini media input'); },
  async (text) => { input = text; }, async () => Readable.from([Buffer.from('Quiz')]));
  assert.match(input, /Media content: Quiz/);
});

test('an owner timetable image becomes a draft and never activates before confirmation', async () => {
  await handleOwnerMedia({ key: { fromMe: false, id: 'table-1', remoteJid: '123@s.whatsapp.net' },
    message: { imageMessage: { mimetype: 'image/png', caption: 'save timetable', fileLength: 4 } } }, {},
  async () => { throw new Error('Explicit timetable should not call the description model'); },
  async () => { throw new Error('Timetable should not enter ordinary questions'); },
  async () => Readable.from([Buffer.from('image')]),
  async () => ({ is_timetable: true, title: 'Classes', valid_from: null, valid_until: null,
    entries: [{ day_of_week: 2, start_local: '09:00', end_local: '10:00', subject: 'CS101', location: null, teacher: null, uncertainty: null }] }));
  assert.equal(activeTimetables().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM timetable_versions WHERE state = 'draft'").get().n, 1);
});
