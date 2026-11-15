import { db } from '../../db/client.js';
import { createTask } from '../../db/repos/tasks.js';
import type { NfcAssignment } from './lms.js';

type Change = 'created' | 'updated' | 'unchanged';

function upsert(item: NfcAssignment): Change {
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
    return 'created';
  }
  const changed = previous.portalStatus !== item.status || previous.dueAt !== item.dueAt ||
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
  return changed ? 'updated' : 'unchanged';
}

export function upsertNfcAssignments(items: NfcAssignment[]): { created: number; updated: number; unchanged: number } {
  return db.transaction(() => {
    const counts = { created: 0, updated: 0, unchanged: 0 };
    for (const item of items) counts[upsert(item)] += 1;
    return counts;
  })();
}
