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

  const text = config.BOT_MODE === 'separate'
    ? warmDigest(period, tasks)
    : `Due ${period === 'morning' ? 'today' : 'tomorrow'}:\n${tasks.map(
      (task) => `#${task.id} ${task.subject ? `${task.subject} — ` : ''}${task.title} (${formatInTimezone(new Date(task.dueAt!), { timeStyle: 'short' })})`,
    ).join('\n')}`;
  const sent = await send(text);
  if (!sent) return false;

  for (const task of tasks) markReminded(task.id, period, task.dueAt!);
  return true;
}

function warmDigest(period: DigestPeriod, tasks: ReturnType<typeof openTasks>): string {
  const when = period === 'morning' ? 'today' : 'tomorrow';
  const greeting = period === 'morning'
    ? `Good morning${config.OWNER_NAME ? ` ${config.OWNER_NAME}` : ''} ☀️`
    : 'Good evening 🌙';
  const items = tasks.map((task) =>
    `${task.subject ? `${task.subject} — ` : ''}${task.title} at ${formatInTimezone(new Date(task.dueAt!), { timeStyle: 'short' })}`,
  );
  if (items.length === 1)
    return `${greeting} Just a gentle reminder — your ${items[0]} is ${when}. You've got this!`;
  if (items.length === 2)
    return `${greeting} A gentle reminder for ${when}: ${items[0]}, and ${items[1]}. You've got this!`;
  return `${greeting} Here's what's coming up ${when}:\n${items.map((item) => `• ${item}`).join('\n')}\nYou've got this!`;
}
