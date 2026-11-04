import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { URL } from 'node:url';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';
process.env.CALENDAR_SYNC = 'true';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { syncUpcomingCalendarEvents, upcomingCalendarEvents } = await import('../src/features/calendar-read.ts');
const { remindImportantCalendarEvents } = await import('../src/features/calendar-reminders.ts');
const { askPrompt } = await import('../src/features/ask.ts');
migrate();
after(() => db.close());

test('reads paginated upcoming events and reminds important events once', async () => {
  const now = new Date('2026-11-04T00:00:00.000Z');
  assert.match(askPrompt('Any meetings today?', now), /no successful upcoming-event read has happened yet/);
  const calls = [];
  const request = async (url) => {
    const value = String(url);
    if (value.endsWith('/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    calls.push(value);
    const page = new URL(value).searchParams.get('pageToken');
    return Response.json(page ? { items: [{ id: '2', summary: 'Important: team meeting', start: { dateTime: '2026-11-04T08:00:00Z' } }] }
      : { items: [{ id: '1', summary: 'Lunch', start: { dateTime: '2026-11-04T07:00:00Z' } }], nextPageToken: 'next' });
  };
  await syncUpcomingCalendarEvents(request, now);
  assert.match(askPrompt('Any meetings today?', now), /were last read at 2026-11-04T00:00:00.000Z/);
  assert.equal(calls.length, 2);
  assert.equal(upcomingCalendarEvents(10, now).length, 2);
  const sent = [];
  assert.equal(await remindImportantCalendarEvents(now, async (text) => { sent.push(text); return true; }), true);
  assert.match(sent[0], /team meeting/);
  assert.doesNotMatch(sent[0], /Lunch/);
  assert.equal(await remindImportantCalendarEvents(now, async () => { throw new Error('sent twice'); }), false);
  await assert.rejects(syncUpcomingCalendarEvents(async () => new Response(null, { status: 503 }), new Date('2026-11-04T02:00:00Z')));
  assert.equal(upcomingCalendarEvents(10, now).length, 2);
});

test('a timed event that has already started does not trigger a late reminder', async () => {
  db.prepare(`INSERT INTO calendar_events
    (id, title, start_at, local_day, important) VALUES (?, ?, ?, ?, 1)`)
    .run('late-event', 'Important: old meeting', '2026-11-04T08:00:00.000Z', '2026-11-04');
  const send = async () => { throw new Error('Past event should not be sent'); };
  assert.equal(await remindImportantCalendarEvents(new Date('2026-11-04T09:00:00.000Z'), send), false);
});
