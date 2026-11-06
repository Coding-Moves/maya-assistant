import { db } from '../client.js';
import { config } from '../../config/env.js';

export interface MediaJob {
  messageId: number;
  payload: Buffer;
  mimeType: string;
  caption: string | null;
  attempts: number;
}

function checkedId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('Invalid media message ID');
  return id;
}

export function enqueueMediaJob(messageId: number, payload: Buffer, mimeType: string, caption: string | null): void {
  db.prepare('INSERT INTO media_jobs (message_id, payload, mime_type, caption) VALUES (?, ?, ?, ?)')
    .run(checkedId(messageId), payload, mimeType, caption);
}

export function pendingMediaJobs(limit: number): MediaJob[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid media batch size');
  return db.prepare<[number], MediaJob>(
    `SELECT message_id AS messageId, payload, mime_type AS mimeType, caption, attempts
     FROM media_jobs JOIN messages m ON m.id = media_jobs.message_id
     WHERE ${config.BOT_MODE === 'separate' ? `m.chat_id IN (SELECT id FROM groups WHERE active = 1)
       AND NOT EXISTS (SELECT 1 FROM group_policies p WHERE p.group_id = m.chat_id
         AND (p.ingest_enabled = 0 OR p.media_enabled = 0 OR p.paused_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))` : '1 = 1'}
     ORDER BY message_id LIMIT ?`,
  ).all(limit);
}

export function completeMediaJob(messageId: number, text: string): void {
  const content = text.trim();
  if (!content) throw new Error('Media text is empty');
  db.transaction(() => {
    const updated = db.prepare('UPDATE messages SET text = ? WHERE id = ? AND processed = 0')
      .run(content, checkedId(messageId)).changes;
    if (updated !== 1) throw new Error('Pending media message is unavailable');
    db.prepare('DELETE FROM media_jobs WHERE message_id = ?').run(messageId);
  })();
}

export function skipMediaJob(messageId: number): void {
  db.transaction(() => {
    const updated = db.prepare("UPDATE messages SET text = '', processed = 1 WHERE id = ? AND processed = 0")
      .run(checkedId(messageId)).changes;
    if (updated !== 1) throw new Error('Pending media message is unavailable');
    db.prepare('DELETE FROM media_jobs WHERE message_id = ?').run(messageId);
  })();
}

export function failMediaJob(messageId: number): boolean {
  return db.transaction(() => {
    const result = db.prepare('UPDATE media_jobs SET attempts = attempts + 1 WHERE message_id = ?')
      .run(checkedId(messageId));
    if (result.changes !== 1) return false;
    const job = db.prepare<[number], { attempts: number }>(
      'SELECT attempts FROM media_jobs WHERE message_id = ?',
    ).get(messageId);
    if (!job || job.attempts < 3) return false;
    const failureBatchId = Number(db.prepare('INSERT INTO extraction_failures DEFAULT VALUES').run().lastInsertRowid);
    const updated = db.prepare("UPDATE messages SET text = '', processed = -1, failure_batch_id = ? WHERE id = ? AND processed = 0")
      .run(failureBatchId, messageId).changes;
    if (updated !== 1) throw new Error('Pending media message is unavailable');
    db.prepare('DELETE FROM media_jobs WHERE message_id = ?').run(messageId);
    return true;
  })();
}

export function pruneInactiveMediaJobs(limit = 100): number {
  const ids = db.prepare<[number], { message_id: number }>(`SELECT j.message_id FROM media_jobs j
    JOIN messages m ON m.id = j.message_id LEFT JOIN groups g ON g.id = m.chat_id
    WHERE g.id IS NULL OR g.active = 0 ORDER BY j.message_id LIMIT ?`).all(limit);
  for (const { message_id } of ids) skipMediaJob(message_id);
  return ids.length;
}
