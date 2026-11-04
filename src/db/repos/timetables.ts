import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from '../client.js';
import { createMemory, getMemory, listMemories, type Memory } from './memories.js';

const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid date');
const entrySchema = z.object({
  day_of_week: z.number().int().min(1).max(7).nullable(),
  start_local: localTime.nullable(),
  end_local: localTime.nullable(),
  subject: z.string().trim().min(1).max(160).nullable(),
  location: z.string().trim().max(160).nullable(),
  teacher: z.string().trim().max(160).nullable(),
  uncertainty: z.string().trim().max(240).nullable(),
});
export const timetableExtractionSchema = z.object({
  is_timetable: z.boolean(),
  title: z.string().trim().min(1).max(160).nullable(),
  valid_from: localDate.nullable(),
  valid_until: localDate.nullable(),
  entries: z.array(entrySchema).max(40),
});
export type TimetableExtraction = z.infer<typeof timetableExtractionSchema>;

export interface TimetableEntry {
  position: number;
  dayOfWeek: number | null;
  startLocal: string | null;
  endLocal: string | null;
  subject: string | null;
  location: string | null;
  teacher: string | null;
  uncertainty: string | null;
}
export interface TimetableVersion {
  id: number;
  memoryId: number;
  version: number;
  title: string;
  state: 'draft' | 'active' | 'archived';
  timezone: string;
  validFrom: string | null;
  validUntil: string | null;
  sourceRef: string | null;
  createdAt: string;
  confirmedAt: string | null;
}
export interface Timetable {
  memory: Memory;
  version: TimetableVersion;
  entries: TimetableEntry[];
}

const versionSchema = z.object({
  id: z.number().int().positive(), memoryId: z.number().int().positive(),
  version: z.number().int().positive(), title: z.string(), state: z.enum(['draft', 'active', 'archived']),
  timezone: z.string(), validFrom: z.string().nullable(), validUntil: z.string().nullable(),
  sourceRef: z.string().nullable(),
  createdAt: z.string(), confirmedAt: z.string().nullable(),
});
const storedEntrySchema = z.object({
  position: z.number().int().positive(), dayOfWeek: z.number().int().min(1).max(7).nullable(),
  startLocal: localTime.nullable(), endLocal: localTime.nullable(),
  subject: z.string().nullable(), location: z.string().nullable(),
  teacher: z.string().nullable(), uncertainty: z.string().nullable(),
});
const versionColumns = `id, memory_id AS memoryId, version, title, state, timezone,
  valid_from AS validFrom, valid_until AS validUntil,
  source_ref AS sourceRef, created_at AS createdAt, confirmed_at AS confirmedAt`;
const entryColumns = `position, day_of_week AS dayOfWeek, start_local AS startLocal,
  end_local AS endLocal, subject, location, teacher, uncertainty`;

function getVersion(id: number): TimetableVersion | null {
  const row = db.prepare<[number], unknown>(`SELECT ${versionColumns} FROM timetable_versions WHERE id = ?`).get(id);
  return row ? versionSchema.parse(row) : null;
}

function getEntries(versionId: number): TimetableEntry[] {
  return db.prepare<[number], unknown>(`SELECT ${entryColumns} FROM timetable_entries
    WHERE version_id = ? ORDER BY position`).all(versionId).map((row) => storedEntrySchema.parse(row));
}

export function activeTimetables(): Timetable[] {
  const rows = db.prepare<[], { id: number }>(`SELECT v.id FROM timetable_versions v
    JOIN memory_items m ON m.id = v.memory_id
    WHERE v.state = 'active' AND m.status = 'active' ORDER BY m.updated_at DESC, v.id DESC`).all();
  return rows.map(({ id }) => {
    const version = getVersion(id)!;
    return { memory: getMemory(version.memoryId)!, version, entries: getEntries(id) };
  });
}

export function timetableForDay(day: number): Timetable[] {
  if (!Number.isSafeInteger(day) || day < 1 || day > 7) throw new RangeError('Invalid weekday');
  return activeTimetables().map((timetable) => ({
    ...timetable, entries: timetable.entries.filter((entry) => entry.dayOfWeek === day),
  })).filter((timetable) => timetable.entries.length > 0);
}

export function getTimetableDraft(token: string, actorJid: string, now = new Date()): Timetable | null {
  const confirmation = db.prepare<[string, string], { payload_json: string; expires_at: string }>(
    `SELECT payload_json, expires_at FROM memory_confirmations
     WHERE token = ? AND actor_jid = ? AND action = 'timetable' AND consumed_at IS NULL`,
  ).get(token, actorJid);
  if (!confirmation || confirmation.expires_at <= now.toISOString()) return null;
  const payload = z.object({ draftId: z.number().int().positive(), previousActiveId: z.number().int().positive().nullable() })
    .parse(JSON.parse(confirmation.payload_json));
  const version = getVersion(payload.draftId);
  const memory = version && getMemory(version.memoryId);
  return version?.state === 'draft' && memory ? { memory, version, entries: getEntries(version.id) } : null;
}

export function createTimetableDraft(
  raw: TimetableExtraction,
  actorJid: string,
  timezone: string,
  sourceRef: string | null,
  now = new Date(),
): { token: string; draft: Timetable; previous: Timetable | null } {
  const extraction = timetableExtractionSchema.parse(raw);
  if (!extraction.is_timetable || extraction.entries.length === 0)
    throw new Error('No timetable entries could be read');
  if (extraction.valid_from && extraction.valid_until && extraction.valid_from > extraction.valid_until)
    throw new Error('Timetable validity dates are reversed');
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  if (!actorJid) throw new Error('Verified owner identity is unavailable');
  return db.transaction(() => {
    const active = activeTimetables();
    if (active.length > 1) throw new Error('Several timetables exist; archive the one to replace first');
    const previous = active[0] ?? null;
    const pending = previous ? [] : listMemories({ category: 'timetable', status: 'draft', limit: 2 });
    if (pending.length > 1) throw new Error('Several timetable drafts exist; wait for them to expire');
    const memory = previous?.memory ?? pending[0] ?? createMemory({
      category: 'timetable', title: extraction.title ?? 'Class timetable',
      body: 'Structured class timetable', lifecycle: 'permanent',
      sourceKind: 'owner_media', sourceRef, status: 'draft',
    }, now);
    if (previous) db.prepare('UPDATE memory_items SET updated_at = ? WHERE id = ?')
      .run(now.toISOString(), memory.id);
    const nextVersion = Number(db.prepare<[number], { n: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS n FROM timetable_versions WHERE memory_id = ?',
    ).get(memory.id)!.n);
    const draftId = Number(db.prepare(`INSERT INTO timetable_versions
      (memory_id, version, title, state, timezone, valid_from, valid_until, source_ref, created_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`).run(
      memory.id, nextVersion, extraction.title ?? memory.title, timezone,
      extraction.valid_from, extraction.valid_until, sourceRef, now.toISOString(),
    ).lastInsertRowid);
    const insert = db.prepare(`INSERT INTO timetable_entries
      (version_id, position, day_of_week, start_local, end_local, subject, location, teacher, uncertainty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    extraction.entries.forEach((entry, index) => insert.run(
      draftId, index + 1, entry.day_of_week, entry.start_local, entry.end_local,
      entry.subject, entry.location, entry.teacher, entry.uncertainty,
    ));
    const token = randomBytes(6).toString('hex');
    db.prepare(`INSERT INTO memory_confirmations
      (token, action, actor_jid, payload_json, expires_at)
      VALUES (?, 'timetable', ?, ?, ?)`).run(token, actorJid,
      JSON.stringify({ draftId, previousActiveId: previous?.version.id ?? null }),
      new Date(now.getTime() + 30 * 60_000).toISOString());
    const draft = { memory: getMemory(memory.id)!, version: getVersion(draftId)!, entries: getEntries(draftId) };
    return { token, draft, previous };
  })();
}

export function correctTimetableEntry(
  token: string, actorJid: string, position: number,
  field: 'day_of_week' | 'start_local' | 'end_local' | 'subject' | 'location' | 'teacher',
  value: string,
  now = new Date(),
): Timetable {
  const draft = getTimetableDraft(token, actorJid, now);
  if (!draft) throw new Error('Timetable draft has expired or was already confirmed');
  if (!Number.isSafeInteger(position) || position < 1) throw new RangeError('Invalid entry number');
  const allowed = new Set(['day_of_week', 'start_local', 'end_local', 'subject', 'location', 'teacher']);
  if (!allowed.has(field)) throw new Error('Invalid timetable field');
  const parsed: string | number = field === 'day_of_week'
    ? z.coerce.number().int().min(1).max(7).parse(value)
    : field === 'start_local' || field === 'end_local'
      ? localTime.parse(value)
      : z.string().trim().min(1).max(160).parse(value);
  const changed = db.prepare(`UPDATE timetable_entries SET ${field} = ?
    WHERE version_id = ? AND position = ?`).run(parsed, draft.version.id, position).changes;
  if (changed !== 1) throw new Error('Timetable entry not found');
  return { ...draft, entries: getEntries(draft.version.id) };
}

export function confirmTimetable(token: string, actorJid: string, now = new Date()): Timetable {
  return db.transaction(() => {
    const draft = getTimetableDraft(token, actorJid, now);
    if (!draft) throw new Error('Timetable draft has expired or was already confirmed');
    if (draft.memory.status !== 'active' && draft.memory.status !== 'draft')
      throw new Error('This timetable was archived; review a new draft');
    const row = db.prepare<[string], { payload_json: string }>(
      'SELECT payload_json FROM memory_confirmations WHERE token = ?',
    ).get(token)!;
    const payload = z.object({ draftId: z.number().int().positive(), previousActiveId: z.number().int().positive().nullable() })
      .parse(JSON.parse(row.payload_json));
    const currentId = db.prepare<[number], { id: number }>(
      "SELECT id FROM timetable_versions WHERE memory_id = ? AND state = 'active'",
    ).get(draft.memory.id)?.id ?? null;
    if (currentId !== payload.previousActiveId) throw new Error('The active timetable changed; review a new draft');
    for (const entry of draft.entries) {
      if (!entry.dayOfWeek || !entry.startLocal || !entry.endLocal || !entry.subject)
        throw new Error(`Entry ${entry.position} needs a day, start, end, and subject before confirmation`);
      if (entry.endLocal <= entry.startLocal)
        throw new Error(`Entry ${entry.position} has an invalid time range`);
    }
    if (currentId !== null) db.prepare("UPDATE timetable_versions SET state = 'archived' WHERE id = ?").run(currentId);
    db.prepare("UPDATE timetable_versions SET state = 'active', confirmed_at = ? WHERE id = ?")
      .run(now.toISOString(), draft.version.id);
    db.prepare("UPDATE memory_items SET status = 'active', title = ?, source_ref = ?, updated_at = ? WHERE id = ?")
      .run(draft.version.title, draft.version.sourceRef, now.toISOString(), draft.memory.id);
    db.prepare('UPDATE memory_confirmations SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL')
      .run(now.toISOString(), token);
    db.prepare('INSERT INTO memory_events (memory_id, action, at, source_ref) VALUES (?, ?, ?, ?)')
      .run(draft.memory.id, currentId === null ? 'timetable_activate' : 'timetable_replace', now.toISOString(), draft.version.sourceRef);
    return { memory: getMemory(draft.memory.id)!, version: getVersion(draft.version.id)!, entries: getEntries(draft.version.id) };
  })();
}

export function cleanupTimetableDrafts(now = new Date()): number {
  return db.transaction(() => {
    const expired = db.prepare<[string], { payload_json: string }>(`SELECT payload_json FROM memory_confirmations
      WHERE action = 'timetable' AND consumed_at IS NULL AND expires_at <= ?`).all(now.toISOString());
    for (const row of expired) {
      const { draftId } = z.object({ draftId: z.number().int().positive() }).parse(JSON.parse(row.payload_json));
      const draft = getVersion(draftId);
      if (draft?.state === 'draft') {
        db.prepare('DELETE FROM timetable_versions WHERE id = ?').run(draftId);
        const memory = getMemory(draft.memoryId);
        if (memory?.status === 'draft' &&
          !db.prepare<[number], { id: number }>('SELECT id FROM timetable_versions WHERE memory_id = ? LIMIT 1').get(memory.id)) {
          db.prepare('DELETE FROM memory_items WHERE id = ?').run(memory.id);
        }
      }
    }
    db.prepare('DELETE FROM memory_confirmations WHERE expires_at <= ?').run(now.toISOString());
    return expired.length;
  })();
}
