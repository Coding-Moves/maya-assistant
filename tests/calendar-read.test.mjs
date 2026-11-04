import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { URL } from 'node:url';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.CALENDAR_SYNC = 'true';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { syncUpcomingCalendarEvents, upcomingCalendarEvents } = await import('../src/features/calendar-read.ts');
const { remindImportantCalendarEvents } = await import('../src/features/calendar-reminders.ts');
migrate();
after(() => db.close());

test('reads paginated upcoming events and reminds important events once', async () => {
  const now = new Date('2026-11-04T00:00:00.000Z');
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
