import { z } from 'zod';
import { db } from '../client.js';

export interface OwnerReminder {
  id: number;
  title: string;
  dueAt: string;
  status: 'open' | 'cancelled';
  sentAt: string | null;
  revision: number;
}

const cols = 'id, title, due_at AS dueAt, status, sent_at AS sentAt, revision';
const titleSchema = z.string().trim().min(1).max(160);

function futureDue(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now.getTime() ||
    date.getTime() > now.getTime() + 366 * 24 * 60 * 60_000)
    throw new Error('Reminder time must be in the next year');
  return date.toISOString();
}

export function getOwnerReminder(id: number): OwnerReminder | null {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('Invalid reminder ID');
  return db.prepare<[number], OwnerReminder>(`SELECT ${cols} FROM owner_reminders WHERE id = ?`).get(id) ?? null;
}

export function listOwnerReminders(limit = 20): OwnerReminder[] {
  const checked = z.number().int().min(1).max(50).parse(limit);
  return db.prepare<[number], OwnerReminder>(`SELECT ${cols} FROM owner_reminders
    WHERE status = 'open' AND sent_at IS NULL ORDER BY due_at, id LIMIT ?`).all(checked);
}

export function createOwnerReminder(title: string, dueAt: string, sourceRef: string | null): OwnerReminder {
  const parsedTitle = titleSchema.parse(title);
  const parsedDue = futureDue(dueAt);
  const now = new Date().toISOString();
  const result = db.prepare(`INSERT INTO owner_reminders
    (title, due_at, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(parsedTitle, parsedDue, sourceRef, now, now);
  return getOwnerReminder(Number(result.lastInsertRowid))!;
}

export function updateOwnerReminder(id: number, title: string, dueAt: string): OwnerReminder {
  const current = getOwnerReminder(id);
  if (!current || current.status !== 'open' || current.sentAt) throw new Error('That reminder is no longer upcoming');
  const changed = db.prepare(`UPDATE owner_reminders SET title = ?, due_at = ?, revision = revision + 1,
    updated_at = ? WHERE id = ? AND status = 'open' AND sent_at IS NULL`)
    .run(titleSchema.parse(title), futureDue(dueAt), new Date().toISOString(), id).changes;
  if (changed !== 1) throw new Error('That reminder changed. Please ask again.');
  return getOwnerReminder(id)!;
}

export function cancelOwnerReminder(id: number): OwnerReminder {
  const current = getOwnerReminder(id);
  if (!current || current.status !== 'open' || current.sentAt) throw new Error('That reminder is no longer upcoming');
  db.prepare(`UPDATE owner_reminders SET status = 'cancelled', revision = revision + 1,
    updated_at = ? WHERE id = ? AND status = 'open' AND sent_at IS NULL`)
    .run(new Date().toISOString(), id);
  return getOwnerReminder(id)!;
}

export function dueOwnerReminders(now = new Date(), limit = 20): OwnerReminder[] {
  return db.prepare<[string, number], OwnerReminder>(`SELECT ${cols} FROM owner_reminders
    WHERE status = 'open' AND sent_at IS NULL AND due_at <= ? ORDER BY due_at, id LIMIT ?`)
    .all(now.toISOString(), limit);
}

export function markOwnerReminderSent(id: number, now = new Date()): boolean {
  return db.prepare(`UPDATE owner_reminders SET sent_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND status = 'open' AND sent_at IS NULL`)
    .run(now.toISOString(), now.toISOString(), id).changes === 1;
}
