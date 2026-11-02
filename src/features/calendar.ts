import { config } from '../config/env.js';
import { db } from '../db/client.js';
import { logger } from '../utils/logger.js';

interface CalendarJob {
  taskId: number;
  revision: number;
  eventId: string | null;
  subject: string | null;
  title: string;
  details: string | null;
  dueAt: string | null;
  status: string;
}

type Request = typeof fetch;
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(request: Request): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const response = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      refresh_token: config.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) throw new Error(`Google token refresh failed (${response.status})`);
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('Google token response is missing access_token');
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000,
  };
  return cachedToken.value;
}

async function calendarRequest(request: Request, method: string, path: string, body?: object): Promise<Response> {
  const token = await accessToken(request);
  const response = await request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.GOOGLE_CALENDAR_ID)}/events${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) cachedToken = null;
  return response;
}

function eventBody(job: CalendarJob, eventId: string): object {
  const due = new Date(job.dueAt!);
  return {
    id: eventId,
    summary: [job.subject, job.title].filter(Boolean).join(' — ').slice(0, 500),
    description: (job.details ?? '').slice(0, 8000),
    start: { dateTime: due.toISOString() },
    end: { dateTime: new Date(due.getTime() + 30 * 60_000).toISOString() },
  };
}

function assertResponse(response: Response, operation: string): void {
  if (!response.ok) throw new Error(`Google Calendar ${operation} failed (${response.status})`);
}

async function syncJob(job: CalendarJob, request: Request): Promise<void> {
  const eventId = job.eventId ?? `maya${job.taskId.toString(16).padStart(8, '0')}`;
  const path = `/${encodeURIComponent(eventId)}`;
  if (job.status !== 'open' || !job.dueAt) {
    if (job.eventId) {
      const response = await calendarRequest(request, 'DELETE', path);
      if (response.status !== 404) assertResponse(response, 'delete');
      db.prepare('UPDATE tasks SET calendar_event_id = NULL WHERE id = ?').run(job.taskId);
    }
  } else {
    // Persist the ID first. A crash after Google creates the event can then be reconciled.
    db.prepare('UPDATE tasks SET calendar_event_id = ? WHERE id = ?').run(eventId, job.taskId);
    const body = eventBody(job, eventId);
    const response = await calendarRequest(request, job.eventId ? 'PATCH' : 'POST', job.eventId ? path : '', body);
    if (response.status === 409) {
      assertResponse(await calendarRequest(request, 'PATCH', path, body), 'update');
    } else if (response.status === 404 && job.eventId) {
      assertResponse(await calendarRequest(request, 'POST', '', body), 'create');
    } else {
      assertResponse(response, job.eventId ? 'update' : 'create');
    }
  }
  // A concurrent task edit increments revision and remains queued for another pass.
  db.prepare('DELETE FROM calendar_jobs WHERE task_id = ? AND revision = ?').run(job.taskId, job.revision);
}

export async function syncCalendarOnce(request: Request = fetch): Promise<void> {
  if (!config.CALENDAR_SYNC) return;
  const jobs = db.prepare<[], CalendarJob>(`
    SELECT j.task_id AS taskId, j.revision, t.calendar_event_id AS eventId,
      t.subject, t.title, t.details, t.due_at AS dueAt, t.status
    FROM calendar_jobs j JOIN tasks t ON t.id = j.task_id
    ORDER BY j.task_id LIMIT 20
  `).all();
  for (const job of jobs) {
    try {
      await syncJob(job, request);
    } catch (error) {
      logger.error({ taskId: job.taskId, errorType: error instanceof Error ? error.name : 'unknown' }, 'Calendar sync failed');
      logger.debug({ err: error }, 'Calendar sync failure details');
    }
  }
}
