import { config } from '../config/env.js';

export function toUtcIso(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid date');
  }
  return date.toISOString();
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
