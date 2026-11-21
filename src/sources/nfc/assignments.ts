import { db } from '../../db/client.js';
import { createTask } from '../../db/repos/tasks.js';
import { recordTaskObservation } from '../../db/repos/task-observations.js';
import type { NfcAssignment } from './lms.js';

type Change = 'created' | 'updated' | 'unchanged';
export interface NfcReconciliationCounts {
  created: number;
  updated: number;
  unchanged: number;
  statusChanged: number;
  deadlineChanged: number;
  missing: number;
}

function upsert(item: NfcAssignment): { change: Change; statusChanged: boolean; deadlineChanged: boolean } {
  const previous = db.prepare<[string], { taskId: number | null; portalStatus: string; dueAt: string | null; title: string; subject: string | null; status: string }>(`
    SELECT n.task_id AS taskId, n.portal_status AS portalStatus, t.due_at AS dueAt, t.title, t.subject, t.status
    FROM nfc_assignments n LEFT JOIN tasks t ON t.id = n.task_id WHERE n.assignment_id = ?
  `).get(item.externalId);
  const now = new Date().toISOString();
  if (!previous?.taskId) {
    const taskId = createTask({ type: 'assignment', subject: item.course, title: item.title, dueAt: item.dueAt });
    if (item.status === 'expired') {
      db.prepare("UPDATE tasks SET status = 'expired', updated_at = ? WHERE id = ?").run(now, taskId);
    } else if (item.status === 'submitted' || item.status === 'reviewing' || item.status === 'graded') {
      db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(now, taskId);
    }
    db.prepare("INSERT INTO source_tasks (source, external_id, task_id) VALUES ('nfc-cms', ?, ?)").run(item.externalId, taskId);
    db.prepare(`INSERT INTO nfc_assignments
      (assignment_id, task_id, course_code, portal_status, marks, portal_url, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(item.externalId, taskId, item.course, item.status, item.marks, item.portalUrl, now);
    recordTaskObservation({ taskId, source: 'nfc-cms', status: item.status, dueAt: item.dueAt,
      observedAt: now, evidenceKind: 'portal' });
    return { change: 'created', statusChanged: false, deadlineChanged: false };
  }
  const statusChanged = previous.portalStatus !== item.status;
  const deadlineChanged = previous.dueAt !== item.dueAt;
  const changed = statusChanged || deadlineChanged ||
    previous.title !== item.title || previous.subject !== item.course;
  if (previous.status === 'open') {
    if (item.status === 'expired') db.prepare("UPDATE tasks SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'open'").run(now, previous.taskId);
    else if (item.status === 'submitted' || item.status === 'reviewing' || item.status === 'graded')
      db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ? AND status = 'open'").run(now, previous.taskId);
    else db.prepare(`UPDATE tasks SET subject = ?, title = ?, due_at = ?, reminded_morning = CASE WHEN due_at IS NOT ? THEN 0 ELSE reminded_morning END,
      reminded_evening = CASE WHEN due_at IS NOT ? THEN 0 ELSE reminded_evening END, updated_at = ? WHERE id = ? AND status = 'open'`)
      .run(item.course, item.title, item.dueAt, item.dueAt, item.dueAt, now, previous.taskId);
  }
  db.prepare(`UPDATE nfc_assignments SET course_code = ?, portal_status = ?, marks = ?, portal_url = ?, last_seen_at = ?
    WHERE assignment_id = ?`).run(item.course, item.status, item.marks, item.portalUrl, now, item.externalId);
  recordTaskObservation({ taskId: previous.taskId, source: 'nfc-cms', status: item.status, dueAt: item.dueAt,
    observedAt: now, evidenceKind: 'portal' });
  return { change: changed ? 'updated' : 'unchanged', statusChanged, deadlineChanged };
}

export function upsertNfcAssignments(items: NfcAssignment[]): NfcReconciliationCounts {
  return db.transaction(() => {
    const counts: NfcReconciliationCounts = { created: 0, updated: 0, unchanged: 0, statusChanged: 0, deadlineChanged: 0, missing: 0 };
    const now = new Date().toISOString();
    const seen = new Set(items.map(({ externalId }) => externalId));
    for (const item of items) {
      const result = upsert(item);
      counts[result.change] += 1;
      if (result.statusChanged) counts.statusChanged += 1;
      if (result.deadlineChanged) counts.deadlineChanged += 1;
    }
    const known = db.prepare<[], { assignmentId: string; taskId: number | null }>(`
      SELECT assignment_id AS assignmentId, task_id AS taskId FROM nfc_assignments
    `).all();
    for (const assignment of known) {
      if (seen.has(assignment.assignmentId) || assignment.taskId === null) continue;
      const observation = recordTaskObservation({ taskId: assignment.taskId, source: 'nfc-cms', status: 'missing',
        dueAt: null, observedAt: now, evidenceKind: 'missing_from_successful_listing' });
      if (observation.changed) counts.missing += 1;
    }
    return counts;
  })();
}
