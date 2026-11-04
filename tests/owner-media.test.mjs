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
setOwnerIdentity(configuredOwnerIdentity());

test('voice note transcription reaches the command handler as plain owner text', async () => {
  const calls = [];
  const message = { key: { fromMe: false, id: 'voice-1', remoteJid: '123@s.whatsapp.net' }, message: {
    audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 4 },
  } };
  assert.equal(mediaDetails(message).mimeType, 'audio/ogg');
  await handleOwnerMedia(message, {}, async (bytes, type) => {
    calls.push([bytes.toString(), type]);
    return 'done 1';
  }, async (text) => { calls.push(text); }, async () => Readable.from([Buffer.from('opus')]));
  assert.deepEqual(calls, [['opus', 'audio/ogg'], 'done 1']);
});

test('video, PDFs, and image stickers are recognized as media', () => {
  assert.equal(mediaDetails({ message: { videoMessage: { mimetype: 'video/mp4' } } }).mimeType, 'video/mp4');
  assert.equal(mediaDetails({ message: { documentMessage: { mimetype: 'application/pdf' } } }).mimeType, 'application/pdf');
  assert.equal(mediaDetails({ message: { stickerMessage: {} } }).mimeType, 'image/webp');
});
