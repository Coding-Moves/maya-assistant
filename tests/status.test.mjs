import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.MEDIA_MAX_BYTES = '5';

const { configuredOwnerIdentity, clearOwnerIdentity, setOwnerIdentity } = await import('../src/channels/whatsapp/identity.ts');
const { commentOnOwnerStatus, ownerStatusPrompt } = await import('../src/features/status.ts');

const ownerStatus = (id, message) => ({
  key: { id, remoteJid: 'status@broadcast', participant: '123@s.whatsapp.net', fromMe: false },
  message,
});

test('comments privately on owner Status text without treating it as a command', async () => {
  setOwnerIdentity(configuredOwnerIdentity());
  try {
    const sent = [];
    let prompt;
    await commentOnOwnerStatus(
      ownerStatus('text', { extendedTextMessage: { text: 'Some worlds are fictional, but the memories we create in them are real.' } }),
      {},
      async (value, media) => { prompt = value; assert.equal(media, undefined); return 'Those memories really do stay with us 🌿'; },
      async (text) => { sent.push(text); return true; },
      async (work) => work(),
    );
    assert.match(prompt, /Some worlds are fictional/);
    assert.deepEqual(sent, ['Those memories really do stay with us 🌿']);
    assert.match(ownerStatusPrompt('hello'), /untrusted content/);
  } finally {
    clearOwnerIdentity();
  }
});

test('comments on a bounded owner photo and falls back to caption when media is oversized', async () => {
  setOwnerIdentity(configuredOwnerIdentity());
  try {
    const sent = [];
    const observed = [];
    const generate = async (prompt, media) => { observed.push({ prompt, media }); return 'Lovely moment'; };
    const send = async (text) => { sent.push(text); return true; };
    const typing = async (work) => work();
    const photo = (id, length) => ownerStatus(id, {
      imageMessage: { mimetype: 'image/jpeg', caption: 'A happy day', fileLength: length },
    });
    await commentOnOwnerStatus(photo('photo', 4), {}, generate, send, typing,
      async () => Readable.from([Buffer.from('1234')]));
    assert.equal(observed[0].media.mimeType, 'image/jpeg');
    assert.equal(observed[0].media.bytes.toString(), '1234');
    assert.match(observed[0].prompt, /A happy day/);

    await commentOnOwnerStatus(photo('large', 6), {}, generate, send, typing,
      async () => { throw new Error('oversized media must not download'); });
    assert.equal(observed[1].media, undefined);
    assert.equal(sent.length, 2);

    await commentOnOwnerStatus(ownerStatus('uncaptioned-large', {
      imageMessage: { mimetype: 'image/jpeg', fileLength: 6 },
    }), {}, generate, send, typing);
    assert.equal(sent.length, 2);
  } finally {
    clearOwnerIdentity();
  }
});

test('does not comment on another person or another broadcast, even when alternate JID is owner', async () => {
  setOwnerIdentity(configuredOwnerIdentity());
  try {
    let calls = 0;
    const generate = async () => { calls += 1; return 'No'; };
    const send = async () => { calls += 1; return true; };
    const typing = async (work) => work();
    const stranger = ownerStatus('other', { conversation: 'hello' });
    stranger.key.participant = '999@s.whatsapp.net';
    stranger.key.remoteJidAlt = '123@s.whatsapp.net';
    await commentOnOwnerStatus(stranger, {}, generate, send, typing);
    const broadcast = ownerStatus('broadcast', { conversation: 'hello' });
    broadcast.key.remoteJid = '999@broadcast';
    await commentOnOwnerStatus(broadcast, {}, generate, send, typing);
    assert.equal(calls, 0);
  } finally {
    clearOwnerIdentity();
  }
});

test('comments on a supported video within the streaming limit, skips oversized uncaptained media', async () => {
  setOwnerIdentity(configuredOwnerIdentity());
  try {
    const observed = [];
    const sent = [];
    const generate = async (_prompt, media) => { observed.push(media); return 'That looks fun!'; };
    const send = async (text) => { sent.push(text); return true; };
    const typing = async (work) => work();
    const video = (id) => ownerStatus(id, { videoMessage: { mimetype: 'video/mp4' } });
    await commentOnOwnerStatus(video('short'), {}, generate, send, typing,
      async () => Readable.from([Buffer.from('12'), Buffer.from('34')]));
    assert.equal(observed[0].mimeType, 'video/mp4');
    assert.equal(observed[0].bytes.toString(), '1234');
    await commentOnOwnerStatus(video('large'), {}, generate, send, typing,
      async () => Readable.from([Buffer.from('123'), Buffer.from('456')]));
    assert.equal(sent.length, 1);
  } finally {
    clearOwnerIdentity();
  }
});
