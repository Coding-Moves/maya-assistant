import { z } from 'zod';
import { db } from '../client.js';

const draftSchema = z.object({ text: z.string().trim().min(1).max(4_000), sourceRef: z.string().max(200).nullable() });
export type MemorySaveDraft = z.infer<typeof draftSchema>;

export function pendingMemorySave(actorJid: string, now = new Date()): MemorySaveDraft | null {
  const row = db.prepare<[string, string], { payload_json: string }>(
    'SELECT payload_json FROM memory_save_drafts WHERE actor_jid = ? AND expires_at > ?',
  ).get(actorJid, now.toISOString());
  return row ? draftSchema.parse(JSON.parse(row.payload_json)) : null;
}

export function stageMemorySave(actorJid: string, draft: MemorySaveDraft, now = new Date()): void {
  if (!actorJid) throw new Error('Verified owner identity is unavailable');
  const payload = draftSchema.parse(draft);
  db.prepare(`INSERT INTO memory_save_drafts (actor_jid, payload_json, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(actor_jid) DO UPDATE SET payload_json = excluded.payload_json, expires_at = excluded.expires_at`)
    .run(actorJid, JSON.stringify(payload), new Date(now.getTime() + 15 * 60_000).toISOString());
}

export function clearMemorySave(actorJid: string): void {
  db.prepare('DELETE FROM memory_save_drafts WHERE actor_jid = ?').run(actorJid);
}
