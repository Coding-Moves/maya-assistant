import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { getMemory } = await import('../src/db/repos/memories.ts');
const {
  activeTimetables, createTimetableDraft, confirmTimetable,
  correctTimetableEntry, getTimetableDraft, cleanupTimetableDrafts,
  timetableForDay,
} = await import('../src/db/repos/timetables.ts');

migrate();
after(() => db.close());

const actor = 'owner@s.whatsapp.net';
const original = {
  is_timetable: true, title: 'VU classes', valid_from: '2026-11-01', valid_until: '2027-02-01',
  entries: [
    { day_of_week: 2, start_local: '09:00', end_local: '10:00', subject: 'CS101', location: 'Room A', teacher: null, uncertainty: null },
    { day_of_week: 4, start_local: '11:00', end_local: '12:00', subject: 'MTH501', location: null, teacher: null, uncertainty: 'Room illegible' },
  ],
};

test('a timetable remains a draft until the verified owner confirms it', () => {
  const { token, draft, previous } = createTimetableDraft(original, actor, 'Asia/Karachi', 'wa-media-1');
  assert.equal(previous, null);
  assert.equal(draft.memory.status, 'draft');
  assert.equal(activeTimetables().length, 0);
  assert.equal(getTimetableDraft(token, 'wrong@s.whatsapp.net'), null);
  assert.throws(() => confirmTimetable(token, 'wrong@s.whatsapp.net'), /expired or was already confirmed/);
  const active = confirmTimetable(token, actor);
  assert.equal(active.version.state, 'active');
  assert.equal(active.memory.status, 'active');
  assert.deepEqual(timetableForDay(2)[0].entries.map(({ subject }) => subject), ['CS101']);
  assert.throws(() => confirmTimetable(token, actor), /expired or was already confirmed/);
});

test('invalid or incomplete replacement cannot overwrite the active timetable; correction then switches atomically', () => {
  const replacement = {
    ...original,
    entries: [{ day_of_week: 2, start_local: '14:00', end_local: null, subject: 'CS101', location: 'Room B', teacher: null, uncertainty: 'End time missing' }],
  };
  const { token, previous } = createTimetableDraft(replacement, actor, 'Asia/Karachi', 'wa-media-2');
  assert.equal(previous.version.version, 1);
  assert.throws(() => confirmTimetable(token, actor), /needs a day, start, end, and subject/);
  assert.equal(activeTimetables()[0].entries[0].startLocal, '09:00');
  correctTimetableEntry(token, actor, 1, 'end_local', '15:00');
  const active = confirmTimetable(token, actor);
  assert.equal(active.version.version, 2);
  assert.equal(active.entries[0].endLocal, '15:00');
  assert.equal(activeTimetables()[0].entries[0].startLocal, '14:00');
  assert.equal(db.prepare("SELECT state FROM timetable_versions WHERE version = 1 AND memory_id = ?").get(active.memory.id).state, 'archived');
  assert.equal(getMemory(active.memory.id)?.sourceRef, 'wa-media-2');
});

test('failed schema validation and expired drafts leave the current version intact', () => {
  assert.throws(() => createTimetableDraft({ ...original, valid_from: '2026-02-30' }, actor, 'Asia/Karachi', null), /Invalid date/);
  const now = new Date('2026-11-04T10:00:00Z');
  const { token, draft } = createTimetableDraft(original, actor, 'Asia/Karachi', 'wa-media-3', now);
  assert.equal(getTimetableDraft(token, actor, new Date('2026-11-04T10:31:00Z')), null);
  assert.equal(cleanupTimetableDrafts(new Date('2026-11-04T10:31:00Z')), 1);
  assert.equal(db.prepare('SELECT id FROM timetable_versions WHERE id = ?').get(draft.version.id), undefined);
  assert.equal(activeTimetables()[0].version.version, 2);
});
