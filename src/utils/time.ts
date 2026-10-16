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
