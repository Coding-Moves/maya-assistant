import { config } from '../config/env.js';
import { db } from '../db/client.js';
import { localDateInTimezone } from '../utils/time.js';
import { calendarRequest } from './calendar.js';

interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
}

interface GoogleEventPage {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  localDay: string;
  allDay: 0 | 1;
  important: 0 | 1;
  remindedAt: string | null;
}

const columns = `id, title, description, location, start_at AS startAt,
  local_day AS localDay, all_day AS allDay, important, reminded_at AS remindedAt`;

export function upcomingCalendarEvents(limit = 50, now = new Date()): CalendarEvent[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid calendar limit');
  return db.prepare<[string, string, number], CalendarEvent>(
    `SELECT ${columns} FROM calendar_events
     WHERE (start_at >= ? OR (all_day = 1 AND local_day = ?))
       AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.calendar_event_id = calendar_events.id)
     ORDER BY start_at LIMIT ?`,
  ).all(now.toISOString(), localDateInTimezone(now), limit);
}

export function importantCalendarEventsOnDay(day: string, now = new Date()): CalendarEvent[] {
  return db.prepare<[string, string], CalendarEvent>(
    `SELECT ${columns} FROM calendar_events
     WHERE local_day = ? AND important = 1 AND reminded_at IS NULL
       AND (all_day = 1 OR start_at >= ?)
       AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.calendar_event_id = calendar_events.id)
     ORDER BY start_at`,
  ).all(day, now.toISOString());
}

export function lastCalendarReadAt(): string | null {
  return db.prepare<[], { value: string }>(
    "SELECT value FROM calendar_meta WHERE key = 'last_events_read_at'",
  ).get()?.value ?? null;
}

export function markCalendarEventReminded(id: string, startAt: string): void {
  db.prepare(`UPDATE calendar_events SET reminded_at = ?
    WHERE id = ? AND start_at = ? AND reminded_at IS NULL`).run(new Date().toISOString(), id, startAt);
}

export async function syncUpcomingCalendarEvents(request: typeof fetch = fetch, now = new Date()): Promise<void> {
  if (!config.CALENDAR_SYNC || config.BOT_MODE !== 'separate') return;
  const last = lastCalendarReadAt();
  if (last && now.getTime() - new Date(last).getTime() < 60 * 60_000) return;

  const start = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString();
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  const visitedPages = new Set<string>();
  do {
    if (pageToken && (visitedPages.has(pageToken) || visitedPages.size >= 20))
      throw new Error('Google Calendar pagination did not finish safely');
    if (pageToken) visitedPages.add(pageToken);
    const query = new URLSearchParams({
      timeMin: start,
      timeMax: end,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await calendarRequest(request, 'GET', `?${query}`);
    if (!response.ok) throw new Error(`Google Calendar events read failed (${response.status})`);
    const page = await response.json() as GoogleEventPage;
    if (page.items !== undefined && !Array.isArray(page.items))
      throw new Error('Google Calendar events response is invalid');
    events.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const upsert = db.prepare(`INSERT INTO calendar_events
    (id, title, description, location, start_at, local_day, all_day, important, seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, description = excluded.description, location = excluded.location,
      start_at = excluded.start_at, local_day = excluded.local_day,
      all_day = excluded.all_day, important = excluded.important, seen = 1,
      reminded_at = CASE WHEN calendar_events.start_at = excluded.start_at
        THEN calendar_events.reminded_at ELSE NULL END`);
  db.transaction(() => {
    db.prepare('UPDATE calendar_events SET seen = 0').run();
    for (const event of events) {
      if (!event.id || event.status === 'cancelled') continue;
      const allDay = Boolean(event.start?.date && !event.start?.dateTime);
      const rawStart = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00.000Z` : null);
      if (!rawStart) continue;
      const date = new Date(rawStart);
      if (Number.isNaN(date.getTime())) continue;
      const title = (event.summary ?? 'Untitled event').slice(0, 500);
      upsert.run(event.id, title, event.description?.slice(0, 8000) ?? null,
        event.location?.slice(0, 500) ?? null, date.toISOString(),
        allDay ? event.start!.date : localDateInTimezone(date),
        allDay ? 1 : 0, /\bimportant\b/i.test(title) ? 1 : 0);
    }
    db.prepare('DELETE FROM calendar_events WHERE seen = 0').run();
    db.prepare(`INSERT INTO calendar_meta (key, value) VALUES ('last_events_read_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(now.toISOString());
  })();
}
