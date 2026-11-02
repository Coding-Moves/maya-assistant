import { config } from '../config/env.js';

export function toUtcIso(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid date');
  }
  return date.toISOString();
}

export function normalizeUtcIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new RangeError('Expected an ISO UTC timestamp');
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new RangeError('Invalid ISO UTC timestamp');
  }
  return toUtcIso(date);
}

export function formatInTimezone(
  date: Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return new Intl.DateTimeFormat('en', {
    ...options,
    timeZone: config.TIMEZONE,
  }).format(date);
}

export function localDateInTimezone(date: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: config.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function localDateTimeToUtc(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    throw new RangeError('Expected YYYY-MM-DD and HH:mm');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (hour! > 23 || minute! > 59 || new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) !== date)
    throw new RangeError('Invalid local date or time');
  const wanted = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let candidate = wanted;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: config.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(candidate));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const shown = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'));
    candidate += wanted - shown;
  }
  const shownTime = new Intl.DateTimeFormat('en', {
    timeZone: config.TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(candidate));
  if (localDateInTimezone(new Date(candidate)) !== date || shownTime !== time)
    throw new RangeError('Local time does not exist in timezone');
  return new Date(candidate).toISOString();
}

export function formatTaskDue(task: { dueAt: string | null; duePrecision: 'date' | 'time' }): string {
  if (!task.dueAt) return 'no due date';
  const date = new Date(task.dueAt);
  return task.duePrecision === 'date'
    ? formatInTimezone(date, { dateStyle: 'medium' }) + ' (time not specified)'
    : formatInTimezone(date);
}
