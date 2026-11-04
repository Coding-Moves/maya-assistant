import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from '../client.js';
import { clearMemoryIds, getMemory, listMemories, type Memory } from './memories.js';

const snapshotSchema = z.object({ id: z.number().int().positive(), revision: z.number().int().positive() });
const payloadSchema = z.object({ items: z.array(snapshotSchema).min(1).max(100) });

export function pendingMemoryChanges(actorJid: string, now = new Date()): {
  token: string;
  action: 'delete' | 'clear';
  items: Memory[];
}[] {
  const rows = db.prepare<[string, string], { token: string; action: 'delete' | 'clear'; payload_json: string }>(
    `SELECT token, action, payload_json FROM memory_confirmations
     WHERE actor_jid = ? AND action IN ('delete', 'clear')
       AND consumed_at IS NULL AND expires_at > ? ORDER BY rowid DESC LIMIT 10`,
  ).all(actorJid, now.toISOString());
  return rows.map((row) => ({
    token: row.token,
    action: row.action,
    items: payloadSchema.parse(JSON.parse(row.payload_json)).items
      .map(({ id }) => getMemory(id)).filter((item): item is Memory => item !== null),
  }));
}

function createConfirmation(action: 'delete' | 'clear', actorJid: string, items: Memory[], now = new Date()): string {
  if (!actorJid) throw new Error('Verified owner identity is unavailable');
  if (items.length === 0 || items.length > 100) throw new Error('Choose between one and 100 memories');
  const token = randomBytes(6).toString('hex');
  const payload = payloadSchema.parse({ items: items.map(({ id, revision }) => ({ id, revision })) });
  db.transaction(() => {
    db.prepare(`UPDATE memory_confirmations SET consumed_at = ? WHERE actor_jid = ?
      AND action IN ('delete', 'clear') AND consumed_at IS NULL`).run(now.toISOString(), actorJid);
    db.prepare(`INSERT INTO memory_confirmations
      (token, action, actor_jid, payload_json, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(token, action, actorJid, JSON.stringify(payload), new Date(now.getTime() + 15 * 60_000).toISOString());
  })();
  return token;
}

export function requestMemoryDelete(id: number, actorJid: string, now = new Date()): string {
  const item = getMemory(id);
  if (!item) throw new Error('Memory not found');
  return createConfirmation('delete', actorJid, [item], now);
}

export function requestCategoryClear(category: string, actorJid: string, now = new Date()): { token: string; count: number } {
  const categoryName = z.string().trim().min(1).max(60).parse(category);
  const items = listMemories({ category: categoryName, limit: 100 });
  const more = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM memory_items WHERE category = ? COLLATE NOCASE',
  ).get(categoryName)!.n > items.length;
  if (more) throw new Error('This category has over 100 memories; delete a narrower set');
  if (items.length === 0) throw new Error('No memories in that category');
  return { token: createConfirmation('clear', actorJid, items, now), count: items.length };
}

export function confirmMemoryChange(token: string, actorJid: string, now = new Date()): { action: 'delete' | 'clear'; count: number } {
  return db.transaction(() => {
    const row = db.prepare<[string, string], { action: string; payload_json: string; expires_at: string }>(
      `SELECT action, payload_json, expires_at FROM memory_confirmations
       WHERE token = ? AND actor_jid = ? AND consumed_at IS NULL`,
    ).get(token, actorJid);
    if (!row || row.expires_at <= now.toISOString() || !['delete', 'clear'].includes(row.action))
      throw new Error('Confirmation expired or already used');
    const { items } = payloadSchema.parse(JSON.parse(row.payload_json));
    for (const snapshot of items) {
      const current = getMemory(snapshot.id);
      if (!current || current.revision !== snapshot.revision)
        throw new Error('A memory changed; request a new confirmation');
    }
    const count = clearMemoryIds(items.map(({ id }) => id), now);
    if (count !== items.length) throw new Error('Memory clear was incomplete');
    db.prepare('UPDATE memory_confirmations SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL')
      .run(now.toISOString(), token);
    return { action: row.action as 'delete' | 'clear', count };
  })();
}
