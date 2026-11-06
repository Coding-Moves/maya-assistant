import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';
process.env.MEDIA_ENABLED = 'true';
process.env.MEDIA_MAX_BYTES = '5000000';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { getRuntimeSetting, setRuntimeSetting, resetRuntimeSetting } = await import('../src/config/runtime.ts');
const { getGroupPolicy, setGroupPolicy, setGroupPause } = await import('../src/db/repos/group-policies.ts');
const { ingestGroupMessage } = await import('../src/features/ingest.ts');
const { enqueueGroupMedia, processPendingMedia } = await import('../src/features/media.ts');
const { getUnprocessed, recentJoinedGroupMessages } = await import('../src/db/repos/messages.ts');
const { pendingMediaJobs } = await import('../src/db/repos/media.ts');
migrate();
after(() => db.close());

const message = (id, text = 'Quiz tomorrow') => ({
  key: { id, remoteJid: 'class@g.us', fromMe: false },
  messageTimestamp: 1_700_000_000,
  message: { conversation: text },
});

test('live settings use env defaults, persist overrides and reject unsafe values', () => {
  assert.equal(getRuntimeSetting('MEDIA_MAX_BYTES'), 5_000_000);
  assert.equal(setRuntimeSetting('MEDIA_MAX_BYTES', 10_000_000), 10_000_000);
  assert.equal(getRuntimeSetting('MEDIA_MAX_BYTES'), 10_000_000);
  assert.throws(() => setRuntimeSetting('MEDIA_MAX_BYTES', 10_000_001));
  assert.throws(() => setRuntimeSetting('GEMINI_API_KEY', 'secret'));
  assert.equal(resetRuntimeSetting('MEDIA_MAX_BYTES'), 5_000_000);
  assert.equal(getRuntimeSetting('MEDIA_MAX_BYTES'), 5_000_000);
});

test('group policy separately controls ingestion, extraction and retrieval', () => {
  ingestGroupMessage(message('first'), 'Quiz tomorrow', 'Class');
  const first = getGroupPolicy('class@g.us');
  assert.equal(first?.active, true);
  assert.equal(getUnprocessed(10).length, 1);
  assert.equal(recentJoinedGroupMessages([], 10).length, 1);
  setGroupPolicy('class@g.us', 'extraction', false);
  assert.equal(getUnprocessed(10).length, 0);
  assert.equal(recentJoinedGroupMessages([], 10).length, 1);
  setGroupPolicy('class@g.us', 'retrieval', false);
  assert.equal(recentJoinedGroupMessages([], 10).length, 0);
  setGroupPolicy('class@g.us', 'ingest', false);
  assert.equal(ingestGroupMessage(message('second'), 'Assignment Friday', 'Class'), null);
  setGroupPolicy('class@g.us', 'ingest', true);
  setGroupPolicy('class@g.us', 'extraction', true);
  setGroupPolicy('class@g.us', 'retrieval', true);
  assert.equal(getUnprocessed(10).length, 1);
  setGroupPause('class@g.us', '2030-01-01T00:00:00Z', new Date('2029-12-10'));
  assert.equal(getUnprocessed(10).length, 0);
  setGroupPause('class@g.us', null);
  assert.equal(getUnprocessed(10).length, 1);
});

test('oversized group file is never downloaded and media policy blocks queued files', async () => {
  const file = (id, length) => ({ ...message(id), message: {
    documentMessage: { mimetype: 'application/pdf', fileLength: length,
      caption: 'Quiz date is Friday', mediaKey: Buffer.from('key') },
  } });
  assert.equal(enqueueGroupMedia(file('book', 11_000_000), 'Class'), true);
  assert.equal(pendingMediaJobs(10).length, 0);
  assert.equal(db.prepare("SELECT text FROM messages WHERE external_id = 'book'").get().text, 'Quiz date is Friday');
  assert.equal(enqueueGroupMedia(file('small', 100), 'Class'), true);
  assert.equal(pendingMediaJobs(10).length, 1);
  setGroupPolicy('class@g.us', 'media', false);
  assert.equal(pendingMediaJobs(10).length, 0);
  let downloads = 0;
  await processPendingMedia({ socket: {}, download: async () => {
    downloads += 1; return Readable.from([Buffer.from('pdf')]);
  }, recognize: async () => 'Quiz' });
  assert.equal(downloads, 0);
  setGroupPolicy('class@g.us', 'media', true);
  assert.equal(pendingMediaJobs(10).length, 1);
});
