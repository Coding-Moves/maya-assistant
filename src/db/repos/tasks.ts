import { db } from '../client.js';
import { normalizeUtcIso } from '../../utils/time.js';

export type TaskType =
  | 'quiz'
  | 'assignment'
  | 'exam'
  | 'announcement'
  | 'venue_change'
  | 'class'
  | 'other';

export interface Task {
  id: number;
  sourceMsgId: number | null;
  lastMsgId: number | null;
  subject: string | null;
  type: TaskType;
  title: string;
  details: string | null;
  dueAt: string | null;
  status: 'open' | 'done' | 'cancelled';
  remindedEvening: 0 | 1;
  remindedMorning: 0 | 1;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  sourceMsgId?: number | null;
  subject?: string | null;
  type: TaskType;
  title: string;
  details?: string | null;
  dueAt?: string | null;
}

export interface TaskChanges {
  lastMsgId: number;
  subject?: string | null;
  type?: TaskType;
  title?: string;
  details?: string | null;
  dueAt?: string | null;
}

const taskColumns = `
  id, source_msg_id AS sourceMsgId, last_msg_id AS lastMsgId,
  subject, type, title, details, due_at AS dueAt, status,
  reminded_evening AS remindedEvening, reminded_morning AS remindedMorning,
  created_at AS createdAt, updated_at AS updatedAt
`;

function checkedId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new RangeError('Task or message ID must be a positive integer');
  }
  return id;
}

export function createTask(task: NewTask): number {
  const sourceMsgId = task.sourceMsgId == null ? null : checkedId(task.sourceMsgId);
  const result = db
    .prepare(
      `INSERT INTO tasks
        (source_msg_id, last_msg_id, subject, type, title, details, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sourceMsgId,
      sourceMsgId,
      task.subject ?? null,
      task.type,
      task.title,
      task.details ?? null,
      task.dueAt == null ? null : normalizeUtcIso(task.dueAt),
    );
  return Number(result.lastInsertRowid);
}

export function updateTask(id: number, changes: TaskChanges): boolean {
  const assignments = [
    'last_msg_id = ?',
    "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  ];
  const values: (string | number | null)[] = [checkedId(changes.lastMsgId)];

  if (changes.subject !== undefined) {
    assignments.push('subject = ?');
    values.push(changes.subject);
  }
  if (changes.type !== undefined) {
    assignments.push('type = ?');
    values.push(changes.type);
  }
  if (changes.title !== undefined) {
    assignments.push('title = ?');
    values.push(changes.title);
  }
  if (changes.details !== undefined) {
    assignments.push('details = ?');
    values.push(changes.details);
  }
  if (changes.dueAt !== undefined) {
    const dueAt = changes.dueAt === null ? null : normalizeUtcIso(changes.dueAt);
    assignments.push('reminded_evening = CASE WHEN due_at IS NOT ? THEN 0 ELSE reminded_evening END');
    assignments.push('reminded_morning = CASE WHEN due_at IS NOT ? THEN 0 ELSE reminded_morning END');
    assignments.push('due_at = ?');
    values.push(dueAt, dueAt, dueAt);
  }

  return (
    db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND status = 'open'`)
      .run(...values, checkedId(id)).changes === 1
  );
}

export function cancelTask(id: number, lastMsgId: number, reason?: string): boolean {
  return (
    db
      .prepare(
        `UPDATE tasks SET status = 'cancelled', last_msg_id = ?,
         details = CASE WHEN ? IS NULL THEN details
           ELSE COALESCE(details || char(10), '') || ? END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'open'`,
      )
      .run(checkedId(lastMsgId), reason ?? null, reason == null ? null : `Cancelled: ${reason}`, checkedId(id))
      .changes === 1
  );
}

export function markDone(id: number): boolean {
  return (
    db
      .prepare(
        `UPDATE tasks SET status = 'done',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'open'`,
      )
      .run(checkedId(id)).changes === 1
  );
}

export function openTasks(): Task[] {
  return db
    .prepare<[], Task>(
      `SELECT ${taskColumns} FROM tasks WHERE status = 'open'
       ORDER BY due_at IS NULL, due_at, id`,
    )
    .all();
}

export function tasksDueBetween(startUtc: string, endUtc: string): Task[] {
  const start = normalizeUtcIso(startUtc);
  const end = normalizeUtcIso(endUtc);
  if (start >= end) throw new RangeError('End must be after start');
  return db
    .prepare<[string, string], Task>(
      `SELECT ${taskColumns} FROM tasks
       WHERE status = 'open' AND due_at >= ? AND due_at < ?
       ORDER BY due_at, id`,
    )
    .all(start, end);
}

export function markReminded(id: number, period: 'morning' | 'evening', expectedDueAt: string): boolean {
  const column = period === 'morning' ? 'reminded_morning' : 'reminded_evening';
  const dueAt = normalizeUtcIso(expectedDueAt);
  return (
    db
      .prepare(
        `UPDATE tasks SET ${column} = 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'open' AND due_at = ? AND ${column} = 0`,
      )
      .run(checkedId(id), dueAt).changes === 1
  );
}
