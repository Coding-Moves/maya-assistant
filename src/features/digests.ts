import { sendToOwner } from '../channels/whatsapp/send.js';
import { config } from '../config/env.js';
import { markReminded, openTasks } from '../db/repos/tasks.js';
import { formatInTimezone } from '../utils/time.js';

export type DigestPeriod = 'morning' | 'evening';
type SendDigest = (text: string) => Promise<boolean>;

function localDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function nextDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + 1))
    .toISOString()
    .slice(0, 10);
}

export async function runDigest(
  period: DigestPeriod,
  now = new Date(),
  send: SendDigest = sendToOwner,
): Promise<boolean> {
  const today = localDay(now);
  const target = period === 'morning' ? today : nextDay(today);
  const tasks = openTasks().filter(
    (task) =>
      task.dueAt !== null &&
      localDay(new Date(task.dueAt)) === target &&
      (period === 'morning' ? !task.remindedMorning : !task.remindedEvening),
  );
  if (tasks.length === 0) return false;

  const lines = tasks.map(
    (task) =>
      `#${task.id} ${task.subject ? `${task.subject} — ` : ''}${task.title} (${formatInTimezone(new Date(task.dueAt!), { timeStyle: 'short' })})`,
  );
  const sent = await send(
    `Due ${period === 'morning' ? 'today' : 'tomorrow'}:\n${lines.join('\n')}`,
  );
  if (!sent) return false;

  for (const task of tasks) markReminded(task.id, period, task.dueAt!);
  return true;
}
