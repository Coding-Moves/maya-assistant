import { z } from 'zod';
import { db } from '../client.js';
import { normalizeUtcIso } from '../../utils/time.js';

const lifecycleSchema = z.enum(['permanent', 'semi', 'temporary']);
const statusSchema = z.enum(['active', 'review', 'completed', 'archived', 'draft']);
const text = z.string().trim().min(1).max(4_000);
const title = z.string().trim().min(1).max(160);
const category = z.string().trim().min(1).max(60);
const rowSchema = z.object({
  id: z.number().int().positive(), category, title, body: text,
  lifecycle: lifecycleSchema, status: statusSchema,
  dueAt: z.string().nullable(), expiresAt: z.string().nullable(),
  reviewAt: z.string().nullable(), completedAt: z.string().nullable(),
  sourceKind: z.enum(['owner_text', 'owner_media']), sourceRef: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(),
});

export type Memory = z.infer<typeof rowSchema>;
export type Lifecycle = z.infer<typeof lifecycleSchema>;
export type MemoryStatus = z.infer<typeof statusSchema>;

export interface NewMemory {
  category: string;
  title: string;
  body: string;
  lifecycle: Lifecycle;
  dueAt?: string | null;
  expiresAt?: string | null;
  reviewAt?: string | null;
  sourceKind: 'owner_text' | 'owner_media';
  sourceRef?: string | null;
  status?: MemoryStatus;
}

const columns = `id, category, title, body, lifecycle, status,
  due_at AS dueAt, expires_at AS expiresAt, review_at AS reviewAt,
  completed_at AS completedAt, source_kind AS sourceKind,
  source_ref AS sourceRef, revision, created_at AS createdAt,
  updated_at AS updatedAt, archived_at AS archivedAt`;
const graceMs = 7 * 24 * 60 * 60 * 1_000;

function checkedId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('Invalid memory ID');
  return id;
}

function iso(value?: string | null): string | null {
  return value == null ? null : normalizeUtcIso(value);
}

function validateLifecycle(lifecycle: Lifecycle, dueAt: string | null, expiresAt: string | null, reviewAt: string | null): void {
  lifecycleSchema.parse(lifecycle);
  if (lifecycle === 'permanent' && (dueAt || expiresAt || reviewAt))
    throw new Error('Permanent memories cannot have an automatic end or review date');
  if (lifecycle === 'semi' && !reviewAt && !expiresAt)
    throw new Error('Semi-permanent memories need a review or end date');
  if (lifecycle === 'temporary' && !dueAt && !expiresAt)
    throw new Error('Temporary memories need a due or expiry date');
}

function audit(id: number, action: string, sourceRef: string | null = null, now = new Date()): void {
  db.prepare('INSERT INTO memory_events (memory_id, action, at, source_ref) VALUES (?, ?, ?, ?)')
    .run(id, action, now.toISOString(), sourceRef);
}

export function createMemory(input: NewMemory, now = new Date()): Memory {
  const parsed = {
    category: category.parse(input.category), title: title.parse(input.title), body: text.parse(input.body),
    dueAt: iso(input.dueAt), expiresAt: iso(input.expiresAt), reviewAt: iso(input.reviewAt),
    sourceRef: input.sourceRef == null ? null : z.string().max(200).parse(input.sourceRef),
  };
  validateLifecycle(input.lifecycle, parsed.dueAt, parsed.expiresAt, parsed.reviewAt);
  const status = statusSchema.parse(input.status ?? 'active');
  return db.transaction(() => {
    const duplicate = db.prepare<[string, string, string], { id: number }>(
      `SELECT id FROM memory_items WHERE category = ? COLLATE NOCASE AND title = ? COLLATE NOCASE
       AND lifecycle = ? AND status IN ('active', 'review', 'draft') LIMIT 1`,
    ).get(parsed.category, parsed.title, input.lifecycle);
    if (duplicate) throw new Error(`A memory with this title already exists as #${duplicate.id}; update it instead`);
    const at = now.toISOString();
    const id = Number(db.prepare(`INSERT INTO memory_items
      (category, title, body, lifecycle, status, due_at, expires_at, review_at,
       source_kind, source_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.category, parsed.title, parsed.body, input.lifecycle, status,
      parsed.dueAt, parsed.expiresAt, parsed.reviewAt, input.sourceKind,
      parsed.sourceRef, at, at,
    ).lastInsertRowid);
    audit(id, 'create', parsed.sourceRef, now);
    return getMemory(id)!;
  })();
}

export function getMemory(id: number): Memory | null {
  const row = db.prepare<[number], unknown>(`SELECT ${columns} FROM memory_items WHERE id = ?`).get(checkedId(id));
  return row == null ? null : rowSchema.parse(row);
}

export function listMemories(filter: {
  lifecycle?: Lifecycle;
  category?: string;
  status?: MemoryStatus;
  limit?: number;
} = {}): Memory[] {
  const limit = filter.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Memory list limit must be 1–100');
  const rows = db.prepare<unknown[], unknown>(`SELECT ${columns} FROM memory_items
    WHERE (? IS NULL OR lifecycle = ?) AND (? IS NULL OR category = ? COLLATE NOCASE)
      AND (? IS NULL OR status = ?)
    ORDER BY updated_at DESC, id DESC LIMIT ?`).all(
    filter.lifecycle ?? null, filter.lifecycle ?? null,
    filter.category ?? null, filter.category ?? null,
    filter.status ?? null, filter.status ?? null, limit,
  );
  return rows.map((row) => rowSchema.parse(row));
}

export function searchMemories(query: string, limit = 8): Memory[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RangeError('Memory search limit must be 1–20');
  const stop = new Set(['what', 'when', 'where', 'which', 'is', 'are', 'my', 'me', 'the', 'a', 'an', 'do', 'you', 'know', 'about', 'have', 'i']);
  const words = (query.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !stop.has(word.toLocaleLowerCase())).slice(0, 8);
  if (words.length === 0) return [];
  const expression = words.map((word) => `"${word}"`).join(' OR ');
  const rows = db.prepare<[string, number], { id: number }>(`SELECT memory_items.id FROM memory_fts
    JOIN memory_items ON memory_items.id = memory_fts.rowid
    WHERE memory_fts MATCH ? AND memory_items.status IN ('active', 'review')
    ORDER BY bm25(memory_fts), memory_items.updated_at DESC LIMIT ?`).all(expression, limit);
  return rows.map(({ id }) => getMemory(id)!);
}

export function updateMemory(
  id: number,
  changes: { title?: string; body?: string; category?: string; dueAt?: string | null; expiresAt?: string | null; reviewAt?: string | null },
  operation: 'update' | 'replace' = 'update',
  now = new Date(),
): Memory {
  return db.transaction(() => {
    const current = getMemory(id);
    if (!current || !['active', 'review', 'completed'].includes(current.status)) throw new Error('Memory is unavailable');
    if (current.category === 'timetable') throw new Error('Use the timetable commands to change a timetable');
    const next = {
      title: changes.title === undefined ? current.title : title.parse(changes.title),
      body: changes.body === undefined ? current.body : text.parse(changes.body),
      category: changes.category === undefined ? current.category : category.parse(changes.category),
      dueAt: changes.dueAt === undefined ? current.dueAt : iso(changes.dueAt),
      expiresAt: changes.expiresAt === undefined ? current.expiresAt : iso(changes.expiresAt),
      reviewAt: changes.reviewAt === undefined ? current.reviewAt : iso(changes.reviewAt),
    };
    validateLifecycle(current.lifecycle, next.dueAt, next.expiresAt, next.reviewAt);
    db.prepare(`UPDATE memory_items SET title = ?, body = ?, category = ?, due_at = ?,
      expires_at = ?, review_at = ?, status = CASE WHEN status = 'review' THEN 'active' ELSE status END,
      revision = revision + 1,
      updated_at = ? WHERE id = ?`).run(
      next.title, next.body, next.category, next.dueAt, next.expiresAt, next.reviewAt, now.toISOString(), id,
    );
    audit(id, operation, null, now);
    return getMemory(id)!;
  })();
}

export function archiveMemory(id: number, now = new Date()): boolean {
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE memory_items SET status = 'archived', archived_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND status IN ('active', 'review', 'completed')`).run(now.toISOString(), now.toISOString(), checkedId(id)).changes;
    if (changed) audit(id, 'archive', null, now);
    return changed === 1;
  })();
}

export function completeMemory(id: number, now = new Date()): boolean {
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE memory_items SET status = 'completed', completed_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND lifecycle = 'temporary' AND status = 'active'`).run(now.toISOString(), now.toISOString(), checkedId(id)).changes;
    if (changed) audit(id, 'complete', null, now);
    return changed === 1;
  })();
}

export function deleteMemory(id: number, now = new Date()): boolean {
  return db.transaction(() => {
    const changed = db.prepare('DELETE FROM memory_items WHERE id = ?').run(checkedId(id)).changes;
    if (changed) audit(id, 'delete', null, now);
    return changed === 1;
  })();
}

export function clearMemoryIds(ids: readonly number[], now = new Date()): number {
  const unique = [...new Set(ids.map(checkedId))];
  return db.transaction(() => {
    let count = 0;
    for (const id of unique) if (deleteMemory(id, now)) count += 1;
    return count;
  })();
}

export function cleanupMemories(now = new Date()): { reviewed: number; deleted: number } {
  const at = now.toISOString();
  return db.transaction(() => {
    const reviewRows = db.prepare<[string, string], { id: number }>(`SELECT id FROM memory_items
      WHERE lifecycle = 'semi' AND status = 'active'
      AND ((review_at IS NOT NULL AND review_at <= ?) OR (expires_at IS NOT NULL AND expires_at <= ?))
      ORDER BY id LIMIT 500`)
      .all(at, at);
    for (const { id } of reviewRows) {
      db.prepare("UPDATE memory_items SET status = 'review', updated_at = ?, revision = revision + 1 WHERE id = ?").run(at, id);
      audit(id, 'review_due', null, now);
    }
    const scanTemporary = db.prepare<[number], { id: number }>(
      "SELECT id FROM memory_items WHERE lifecycle = 'temporary' AND id > ? ORDER BY id LIMIT 500",
    );
    let deleted = 0;
    let cursor = 0;
    for (;;) {
      const page = scanTemporary.all(cursor);
      if (page.length === 0) break;
      for (const { id } of page) {
        cursor = id;
        const item = getMemory(id)!;
        const anchors = [item.dueAt, item.expiresAt, item.completedAt].filter((value): value is string => value !== null);
        if (anchors.length === 0) continue;
        const last = Math.max(...anchors.map((value) => Date.parse(value)));
        if (last + graceMs <= now.getTime() && (item.status === 'completed' || item.status === 'archived' ||
          (item.dueAt !== null && item.dueAt <= at) || (item.expiresAt !== null && item.expiresAt <= at))) {
          if (deleteMemory(item.id, now)) deleted += 1;
        }
      }
    }
    return { reviewed: reviewRows.length, deleted };
  })();
}
