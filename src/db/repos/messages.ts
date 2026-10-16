import { db } from '../client.js';
import { normalizeUtcIso } from '../../utils/time.js';

export interface Message {
  id: number;
  source: string;
  externalId: string;
  chatId: string;
  chatName: string | null;
  senderName: string | null;
  text: string;
  sentAt: string;
  processed: -1 | 0 | 1;
  extractAttempts: number;
  failureBatchId: number | null;
}

export interface NewMessage {
  source?: string;
  externalId: string;
  chatId: string;
  chatName?: string | null;
  senderName?: string | null;
  text: string;
  sentAt: string;
}

export interface FailureBatch {
  id: number;
  failedAt: string;
  messageIds: number[];
}

const messageColumns = `
  id, source, external_id AS externalId, chat_id AS chatId,
  chat_name AS chatName, sender_name AS senderName, text,
  sent_at AS sentAt, processed, extract_attempts AS extractAttempts,
  failure_batch_id AS failureBatchId
`;

function checkedIds(ids: readonly number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new RangeError('Message IDs must be positive integers');
  }
  return unique;
}

function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('Limit must be a positive integer');
  }
  return limit;
}

function placeholders(count: number): string {
  return Array(count).fill('?').join(', ');
}

export function insertMessage(message: NewMessage): number | null {
  const result = db
    .prepare(
      `INSERT INTO messages
        (source, external_id, chat_id, chat_name, sender_name, text, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, chat_id, external_id) DO NOTHING`,
    )
    .run(
      message.source ?? 'whatsapp',
      message.externalId,
      message.chatId,
      message.chatName ?? null,
      message.senderName ?? null,
      message.text,
      normalizeUtcIso(message.sentAt),
    );
  return result.changes === 1 ? Number(result.lastInsertRowid) : null;
}

export function getUnprocessed(limit: number): Message[] {
  return db
    .prepare<[number], Message>(
      `SELECT ${messageColumns} FROM messages
       WHERE processed = 0 ORDER BY sent_at, id LIMIT ?`,
    )
    .all(checkedLimit(limit));
}

export function incrementExtractAttempts(ids: readonly number[]): number {
  const unique = checkedIds(ids);
  if (unique.length === 0) return 0;
  return db
    .prepare(
      `UPDATE messages SET extract_attempts = extract_attempts + 1
       WHERE processed = 0 AND id IN (${placeholders(unique.length)})`,
    )
    .run(...unique).changes;
}

export function quarantineFailedBatch(ids: readonly number[]): number | null {
  const unique = checkedIds(ids);
  if (unique.length === 0) return null;

  return db.transaction(() => {
    const eligible = db
      .prepare<number[], { id: number }>(
        `SELECT id FROM messages WHERE processed = 0 AND extract_attempts >= 3
         AND id IN (${placeholders(unique.length)})`,
      )
      .all(...unique)
      .map((row) => row.id);
    if (eligible.length === 0) return null;

    const batchId = Number(db.prepare('INSERT INTO extraction_failures DEFAULT VALUES').run().lastInsertRowid);
    db.prepare(
      `UPDATE messages SET processed = -1, failure_batch_id = ?
       WHERE id IN (${placeholders(eligible.length)})`,
    ).run(batchId, ...eligible);
    return batchId;
  })();
}

export function pendingFailureBatches(): FailureBatch[] {
  const batches = db
    .prepare<[], { id: number; failedAt: string }>(
      `SELECT id, failed_at AS failedAt FROM extraction_failures
       WHERE owner_notified_at IS NULL ORDER BY id`,
    )
    .all();
  const messagesForBatch = db.prepare<[number], { id: number }>(
    'SELECT id FROM messages WHERE failure_batch_id = ? ORDER BY id',
  );
  return batches.map((batch) => ({
    ...batch,
    messageIds: messagesForBatch.all(batch.id).map((row) => row.id),
  }));
}

export function markFailureBatchNotified(id: number): boolean {
  checkedIds([id]);
  return (
    db
      .prepare(
        `UPDATE extraction_failures
         SET owner_notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND owner_notified_at IS NULL`,
      )
      .run(id).changes === 1
  );
}

export function markProcessed(ids: readonly number[]): number {
  const unique = checkedIds(ids);
  if (unique.length === 0) return 0;
  return db
    .prepare(`UPDATE messages SET processed = 1 WHERE processed = 0 AND id IN (${placeholders(unique.length)})`)
    .run(...unique).changes;
}

export function recentMessages(chatIds: readonly string[], limit: number): Message[] {
  if (chatIds.length === 0) return [];
  const rows = db
    .prepare<unknown[], Message>(
      `SELECT ${messageColumns} FROM messages
       WHERE chat_id IN (${placeholders(chatIds.length)})
       ORDER BY sent_at DESC, id DESC LIMIT ?`,
    )
    .all(...chatIds, checkedLimit(limit));
  return rows.reverse();
}
