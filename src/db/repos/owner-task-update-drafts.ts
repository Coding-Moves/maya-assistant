import { db } from '../client.js';
import { cancelTaskFromOwner, createTask, openTasks, recentExpiredTasks, updateTaskFromOwner, type Task, type TaskType } from './tasks.js';

export interface DraftChange {
  op: 'create' | 'update' | 'cancel';
  taskId: number | null;
  subject?: string | null;
  type?: TaskType;
  title: string;
  details?: string | null;
  dueAt?: string | null;
  reason?: string | null;
  issue?: string | null;
}

export interface TaskUpdateDraft {
  actorJid: string;
  sourceRef: string | null;
  changes: DraftChange[];
  stateRevision: string;
  expiresAt: string;
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function currentTasks(): Task[] { return [...openTasks(), ...recentExpiredTasks()]; }

export function taskStateRevision(tasks = currentTasks()): string {
  return tasks.map(({ id, updatedAt, status }) => `${id}:${updatedAt}:${status}`).sort().join('|');
}

export function resolveDraftChange(change: Omit<DraftChange, 'taskId' | 'issue'>, tasks = currentTasks()): DraftChange {
  if (change.op === 'create') return { ...change, taskId: null, issue: null };
  const title = normalize(change.title);
  const subject = normalize(change.subject);
  const candidates = tasks.filter((task) => {
    const taskTitle = normalize(task.title);
    const titleMatch = taskTitle === title || (title.length >= 5 && (taskTitle.includes(title) || title.includes(taskTitle)));
    return titleMatch && (!subject || normalize(task.subject) === subject);
  });
  if (candidates.length === 1) return { ...change,
    ...(change.subject === undefined && { subject: candidates[0]!.subject }), taskId: candidates[0]!.id, issue: null };
  return { ...change, taskId: null, issue: candidates.length > 1 ? 'More than one task matches this name.' : 'I could not find a matching open task.' };
}

export function stageTaskUpdateDraft(actorJid: string, sourceRef: string | null,
  changes: Omit<DraftChange, 'taskId' | 'issue'>[], now = new Date()): TaskUpdateDraft {
  if (!actorJid || changes.length === 0 || changes.length > 12) throw new Error('A small verified task update is required');
  const resolved = changes.map((change) => resolveDraftChange(change));
  const draft: TaskUpdateDraft = { actorJid, sourceRef, changes: resolved, stateRevision: taskStateRevision(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString() };
  db.transaction(() => {
    db.prepare('UPDATE owner_task_update_drafts SET consumed_at = ? WHERE actor_jid = ? AND consumed_at IS NULL')
      .run(now.toISOString(), actorJid);
    db.prepare(`INSERT INTO owner_task_update_drafts (actor_jid, source_ref, payload_json, state_revision, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(actor_jid) DO UPDATE SET source_ref = excluded.source_ref, payload_json = excluded.payload_json,
        state_revision = excluded.state_revision, expires_at = excluded.expires_at, consumed_at = NULL`)
      .run(actorJid, sourceRef, JSON.stringify(draft.changes), draft.stateRevision, draft.expiresAt);
  })();
  return draft;
}

export function pendingTaskUpdateDraft(actorJid: string, now = new Date()): TaskUpdateDraft | null {
  const row = db.prepare<[string, string], { sourceRef: string | null; payloadJson: string; stateRevision: string; expiresAt: string }>(
    `SELECT source_ref AS sourceRef, payload_json AS payloadJson, state_revision AS stateRevision, expires_at AS expiresAt
     FROM owner_task_update_drafts WHERE actor_jid = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).get(actorJid, now.toISOString());
  return row ? { actorJid, sourceRef: row.sourceRef, changes: JSON.parse(row.payloadJson) as DraftChange[], stateRevision: row.stateRevision, expiresAt: row.expiresAt } : null;
}

export function discardTaskUpdateDraft(actorJid: string): boolean {
  return db.prepare('UPDATE owner_task_update_drafts SET consumed_at = ? WHERE actor_jid = ? AND consumed_at IS NULL')
    .run(new Date().toISOString(), actorJid).changes === 1;
}

export function applyTaskUpdateDraft(actorJid: string): { created: number; updated: number; cancelled: number; skipped: number } {
  return db.transaction(() => {
    const draft = pendingTaskUpdateDraft(actorJid);
    if (!draft) throw new Error('That update preview expired. Please send the information again.');
    if (draft.stateRevision !== taskStateRevision()) throw new Error('Your task list changed. Please ask me to prepare a fresh preview.');
    const result = { created: 0, updated: 0, cancelled: 0, skipped: 0 };
    for (const change of draft.changes) {
      if (change.issue) { result.skipped += 1; continue; }
      if (change.op === 'create') {
        const taskId = createTask({ ...(change.subject !== undefined && { subject: change.subject }), type: change.type ?? 'other', title: change.title,
          ...(change.details !== undefined && { details: change.details }), ...(change.dueAt !== undefined && { dueAt: change.dueAt }) });
        db.prepare('INSERT INTO owner_task_update_events (task_id, source_ref, action, at) VALUES (?, ?, ?, ?)')
          .run(taskId, draft.sourceRef, 'create', new Date().toISOString());
        result.created += 1;
      } else if (change.taskId && change.op === 'update') {
        const task = currentTasks().find(({ id }) => id === change.taskId);
        if (!task) throw new Error('A task changed before I could apply this preview.');
        const changed = updateTaskFromOwner(change.taskId, {
          ...(change.subject !== undefined && { subject: change.subject }),
          ...(change.type !== undefined && { type: change.type }),
          title: change.title,
          ...(change.details !== undefined && { details: change.details }),
          ...(change.dueAt !== undefined && { dueAt: change.dueAt }),
        });
        if (!changed) throw new Error('A task could not be updated safely.');
        db.prepare('INSERT INTO owner_task_update_events (task_id, source_ref, action, at) VALUES (?, ?, ?, ?)')
          .run(change.taskId, draft.sourceRef, 'update', new Date().toISOString());
        result.updated += 1;
      } else if (change.taskId && change.op === 'cancel') {
        const task = currentTasks().find(({ id }) => id === change.taskId);
        if (!task || !cancelTaskFromOwner(change.taskId, change.reason ?? undefined))
          throw new Error('A task could not be cancelled safely.');
        db.prepare('INSERT INTO owner_task_update_events (task_id, source_ref, action, at) VALUES (?, ?, ?, ?)')
          .run(change.taskId, draft.sourceRef, 'cancel', new Date().toISOString());
        result.cancelled += 1;
      }
    }
    const consumed = db.prepare('UPDATE owner_task_update_drafts SET consumed_at = ? WHERE actor_jid = ? AND consumed_at IS NULL AND expires_at > ?')
      .run(new Date().toISOString(), actorJid, new Date().toISOString()).changes;
    if (consumed !== 1) throw new Error('That update preview expired.');
    return result;
  })();
}
