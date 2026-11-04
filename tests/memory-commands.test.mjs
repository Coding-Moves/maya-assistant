import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { handleNaturalMemory } = await import('../src/features/memory-intent.ts');
const { handleMemoryShortcut } = await import('../src/features/memory.ts');
const { createMemory, getMemory } = await import('../src/db/repos/memories.ts');
const { createTimetableDraft, activeTimetables } = await import('../src/db/repos/timetables.ts');

migrate();
after(() => db.close());

const actor = '123@s.whatsapp.net';
const intent = (action, fields = {}) => ({
  action, lifecycle: null, category: null, title: null, body: null, date: null,
  target: null, target_id: null, page: null, entry: null, field: null,
  value: null, question: null, ...fields,
});

test('natural owner text saves only with explicit retention and preserves the source message', async () => {
  const classified = intent('save', {
    lifecycle: 'permanent', category: 'preference', title: 'Tea', body: 'I like green tea',
  });
  const classify = async () => classified;
  assert.match(await handleNaturalMemory('Remember that I like green tea', actor, 'owner-1', classify), /Should it be permanent/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_items').get().n, 0);
  const saved = await handleNaturalMemory('Remember permanently that I like green tea', actor, 'owner-2', classify);
  assert.match(saved, /remember Tea/);
  assert.equal(getMemory(1)?.sourceRef, 'owner-2');
  assert.equal(getMemory(1)?.body, 'I like green tea');
});

test('a short retention follow-up completes a voice memory without losing its source', async () => {
  const first = await handleNaturalMemory('Remember that I like quiet study sessions', actor, 'voice-follow-up',
    async () => intent('clarify', { question: 'How long should I keep that?' }));
  assert.match(first, /How long/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_save_drafts WHERE actor_jid = ?").get(actor).n, 1);
  const second = await handleNaturalMemory('Permanently', actor, 'reply-1',
    async (prompt) => {
      assert.match(prompt, /quiet study sessions/);
      assert.match(prompt, /Retention follow-up: Permanently/);
      return intent('save', { lifecycle: 'permanent', category: 'preference',
        title: 'Quiet study', body: 'I like quiet study sessions' });
    });
  assert.match(second, /remember Quiet study/);
  assert.equal(db.prepare("SELECT source_ref FROM memory_items WHERE title = 'Quiet study'").get().source_ref, 'voice-follow-up');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_save_drafts WHERE actor_jid = ?").get(actor).n, 0);
});

test('natural lookup and scoped deletion require an owner-bound follow-up', async () => {
  assert.match(await handleNaturalMemory('Show my Tea memory', actor, null,
    async () => intent('show', { target: 'Tea' })), /green tea/);
  const preview = await handleNaturalMemory('Delete my Tea memory', actor, null,
    async () => intent('delete', { target: 'Tea' }));
  assert.match(preview, /Yes, delete Tea/);
  assert.match(await handleNaturalMemory('Yes, delete Tea', 'other@s.whatsapp.net', null), /do not have a deletion/);
  assert.match(await handleNaturalMemory('Yes, delete Calendar', actor, null), /Yes, delete Tea/);
  assert.ok(getMemory(1));
  assert.match(await handleNaturalMemory('Yes, delete Tea', actor, null), /deleted 1 memory/);
  assert.equal(getMemory(1), null);
  assert.match(await handleNaturalMemory('Yes, delete Tea', actor, null), /do not have a deletion/);
});

test('model cannot choose an unspoken memory ID or clear all memories', async () => {
  const note = createMemory({ category: 'preference', title: 'Favourite tea', body: 'Green tea',
    lifecycle: 'permanent', sourceKind: 'owner_text', sourceRef: null });
  assert.match(await handleNaturalMemory('Delete my old note', actor, null,
    async () => intent('delete', { target_id: note.id })), /Which saved memory/);
  assert.match(await handleNaturalMemory('Update my old note', actor, null,
    async () => intent('update', { target: 'Favourite tea', body: 'Wrong target' })), /Which saved memory/);
  assert.equal(getMemory(note.id)?.body, 'Green tea');
  assert.match(await handleNaturalMemory('Clear my notes', actor, null,
    async () => intent('clear', { category: 'preference' })), /name the category/);
  assert.match(await handleNaturalMemory('Clear everything', actor, null,
    async () => intent('clear', { category: 'all' })), /one named category/);
});

test('a natural review-date change updates only the named memory date', async () => {
  const plan = createMemory({ category: 'study', title: 'CS101 plan', body: 'Study twice a week',
    lifecycle: 'semi', reviewAt: '2026-12-01T00:00:00.000Z', sourceKind: 'owner_text', sourceRef: null });
  const reply = await handleNaturalMemory('Change the review date for CS101 plan to 1 February 2027', actor, null,
    async () => intent('update', { target: 'CS101 plan', date: '2027-02-01' }));
  assert.match(reply, /Updated CS101 plan/);
  assert.match(getMemory(plan.id)?.reviewAt ?? '', /^2027-01-31T19:00:00/);
  assert.equal(getMemory(plan.id)?.body, 'Study twice a week');
});

test('a voice-transcribed temporary save uses the spoken end date and slash shortcuts stay brief', async () => {
  const reply = await handleNaturalMemory('Keep this until December 15: return the library book', actor, 'voice-1',
    async () => intent('save', { lifecycle: 'temporary', category: 'note', title: 'Library book',
      body: 'Return the library book', date: '2026-12-15' }));
  assert.match(reply, /Library book/);
  assert.equal(db.prepare("SELECT source_ref FROM memory_items WHERE title = 'Library book'").get()?.source_ref, 'voice-1');
  assert.match(handleMemoryShortcut('/memory'), /temporary memories/);
  assert.match(handleMemoryShortcut('/timetable 99'), /not available|not have an active timetable/);
  assert.equal(handleMemoryShortcut('memory save permanent something'), null);
});

test('ordinary owner conversation is not treated as a memory request', async () => {
  assert.equal(await handleNaturalMemory('Yes, that sounds good', null, null,
    async () => { throw new Error('Should not classify'); }), null);
  assert.equal(await handleNaturalMemory('How are you?', actor, null,
    async () => { throw new Error('Should not classify'); }), null);
});

test('natural timetable confirmation activates only the pending draft', async () => {
  createTimetableDraft({ is_timetable: true, title: 'Classes', valid_from: null, valid_until: null,
    entries: [{ day_of_week: 2, start_local: '09:00', end_local: '10:00', subject: 'CS101',
      location: null, teacher: null, uncertainty: null }] }, actor, 'Asia/Karachi', 'image-1');
  assert.equal(activeTimetables().length, 0);
  assert.match(await handleNaturalMemory('Yes, save the timetable', actor, null), /Saved Classes/);
  assert.equal(activeTimetables().length, 1);
  assert.match(handleMemoryShortcut('/timetable'), /CS101/);
});
