import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.CALENDAR_SYNC = 'true';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { createTask, updateTask, markDone } = await import('../src/db/repos/tasks.ts');
const { syncCalendarOnce } = await import('../src/features/calendar.ts');
migrate();
after(() => db.close());

test('creates, updates and removes one calendar event as a task changes', async () => {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body && !String(url).endsWith('/token') ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    return new Response(null, { status: init.method === 'DELETE' ? 204 : 200 });
  };
  const id = createTask({ type: 'quiz', title: 'Chapter 1', subject: 'CS101', dueAt: '2026-11-05T10:00:00.000Z' });
  await syncCalendarOnce(request);
  const created = calls.find(({ method, url }) => method === 'POST' && !url.endsWith('/token'));
  assert.ok(created);
  assert.equal(created.body.summary, 'CS101 — Chapter 1');
  assert.equal(created.body.start.dateTime, '2026-11-05T10:00:00.000Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_jobs').get().count, 0);

  db.prepare("INSERT INTO messages (external_id, chat_id, text, sent_at) VALUES ('update-1', 'group@g.us', 'Moved', '2026-11-02T10:00:00.000Z')").run();
  updateTask(id, { lastMsgId: 1, title: 'Chapter 2', dueAt: '2026-11-06T10:00:00.000Z' });
  await syncCalendarOnce(request);
  assert.ok(calls.some(({ method, body }) => method === 'PATCH' && body.summary === 'CS101 — Chapter 2'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_jobs').get().count, 0);

  markDone(id);
  await syncCalendarOnce(request);
  assert.ok(calls.some(({ method }) => method === 'DELETE'));
  assert.equal(db.prepare('SELECT calendar_event_id AS eventId FROM tasks WHERE id = ?').get(id).eventId, null);
});

test('failed Google request leaves the job queued for retry', async () => {
  const id = createTask({ type: 'assignment', title: 'Essay', dueAt: '2026-11-07T10:00:00.000Z' });
  await syncCalendarOnce(async (url) => String(url).endsWith('/token')
    ? Response.json({ access_token: 'test-token', expires_in: 3600 })
    : new Response(null, { status: 503 }));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_jobs WHERE task_id = ?').get(id).count, 1);
});

test('date-only VU task becomes an all-day event', async () => {
  const id = createTask({ type: 'assignment', title: 'Assignment 3', dueAt: '2026-11-06T18:59:00.000Z', duePrecision: 'date' });
  let event;
  await syncCalendarOnce(async (url, init) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (init.method === 'POST') event = JSON.parse(init.body);
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(event.start, { date: '2026-11-06' });
  assert.deepEqual(event.end, { date: '2026-11-07' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_jobs WHERE task_id = ?').get(id).count, 0);
});
