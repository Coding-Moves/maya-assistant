import { sendToOwner } from '../channels/whatsapp/send.js';
import { config } from '../config/env.js';
import { formatInTimezone, localDateInTimezone } from '../utils/time.js';
import { importantCalendarEventsOnDay, markCalendarEventReminded } from './calendar-read.js';

let running = false;

export async function remindImportantCalendarEvents(
  now = new Date(),
  send: typeof sendToOwner = sendToOwner,
): Promise<boolean> {
  if (!config.CALENDAR_SYNC || config.BOT_MODE !== 'separate' || running) return false;
  running = true;
  try {
    const events = importantCalendarEventsOnDay(localDateInTimezone(now), now);
    if (events.length === 0) return false;
    const lines = events.map((event) => event.allDay
      ? `• ${event.title} (all day)`
      : `• ${event.title} at ${formatInTimezone(new Date(event.startAt), { timeStyle: 'short' })}`);
    const message = events.length === 1
      ? `A gentle reminder: ${lines[0]!.slice(2)} is on your calendar today.`
      : `A few important things on your calendar today:\n${lines.join('\n')}`;
    if (!await send(message)) return false;
    for (const event of events) markCalendarEventReminded(event.id, event.startAt);
    return true;
  } finally {
    running = false;
  }
}
