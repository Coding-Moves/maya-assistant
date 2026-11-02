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

test('invalid OAuth credentials stop the batch after one refresh attempt', async () => {
  const first = createTask({ type: 'quiz', title: 'First', dueAt: '2026-11-04T10:00:00.000Z' });
  const second = createTask({ type: 'quiz', title: 'Second', dueAt: '2026-11-04T11:00:00.000Z' });
  let calls = 0;
  await syncCalendarOnce(async () => { calls++; return new Response(null, { status: 400 }); });
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_jobs').get().count, 2);
  db.prepare('DELETE FROM tasks WHERE id IN (?, ?)').run(first, second);
});

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
  assert.match(created.body.id, /^[a-v0-9]{5,1024}$/);
  assert.equal(created.body.visibility, 'private');
  assert.equal(created.body.summary, 'CS101 — Chapter 1');
  assert.equal(created.body.start.dateTime, '2026-11-05T10:00:00.000Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_jobs').get().count, 0);

  db.prepare("INSERT INTO messages (external_id, chat_id, text, sent_at) VALUES ('update-1', 'group@g.us', 'Moved', '2026-11-02T10:00:00.000Z')").run();
  updateTask(id, { lastMsgId: 1, title: 'Chapter 2', dueAt: '2026-11-06T10:00:00.000Z' });
  await syncCalendarOnce(request);
  assert.ok(calls.some(({ method, body }) => method === 'PUT' && body.summary === 'CS101 — Chapter 2'));
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

test('an all-day deadline can become a timed event without retaining a date field', async () => {
  const id = createTask({ type: 'assignment', title: 'Assignment 4', dueAt: '2026-11-08T18:59:00.000Z', duePrecision: 'date' });
  const calls = [];
  const request = async (url, init) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response(null, { status: 200 });
  };
  await syncCalendarOnce(request);
  db.prepare("UPDATE tasks SET due_at = '2026-11-08T10:00:00.000Z', due_precision = 'time' WHERE id = ?").run(id);
  await syncCalendarOnce(request);
  const updated = calls.find(({ method, body }) => method === 'PUT' && body.summary === 'Assignment 4');
  assert.ok(updated);
  assert.equal(updated.body.id, undefined);
  assert.deepEqual(updated.body.start, { dateTime: '2026-11-08T10:00:00.000Z' });
  assert.deepEqual(updated.body.end, { dateTime: '2026-11-08T10:30:00.000Z' });
});

test('a saved event ID recovers when the remote event is missing', async () => {
  const id = createTask({ type: 'quiz', title: 'Retry quiz', dueAt: '2026-11-10T10:00:00.000Z' });
  const firstAttempt = async (url) => String(url).endsWith('/token')
    ? Response.json({ access_token: 'test-token', expires_in: 3600 })
    : new Response(null, { status: 503 });
  await syncCalendarOnce(firstAttempt);
  const saved = db.prepare('SELECT calendar_event_id AS eventId FROM tasks WHERE id = ?').get(id).eventId;
  assert.ok(saved);
  const methods = [];
  await syncCalendarOnce(async (url, init) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    methods.push(init.method);
    return new Response(null, { status: init.method === 'PUT' ? 404 : 200 });
  });
  assert.deepEqual(methods, ['PUT', 'POST']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_jobs WHERE task_id = ?').get(id).count, 0);
});

test('duplicate create response updates the same event', async () => {
  const id = createTask({ type: 'quiz', title: 'Duplicate response', dueAt: '2026-11-11T10:00:00.000Z' });
  const methods = [];
  await syncCalendarOnce(async (url, init) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    methods.push(init.method);
    return new Response(null, { status: init.method === 'POST' ? 409 : 200 });
  });
  assert.deepEqual(methods, ['POST', 'PUT']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_jobs WHERE task_id = ?').get(id).count, 0);
});
