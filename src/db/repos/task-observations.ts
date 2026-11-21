import { db } from '../client.js';

export interface TaskObservation {
  taskId: number;
  source: string;
  status: string;
  dueAt: string | null;
  observedAt: string;
  evidenceKind: 'portal' | 'missing_from_successful_listing' | 'owner_report';
}

export interface ObservationResult {
  changed: boolean;
  previous: Pick<TaskObservation, 'status' | 'dueAt'> | null;
}

/**
 * Store only a meaningful source-state transition. Repeated successful polls of
 * unchanged data do not add history or trigger another owner notification.
 */
export function recordTaskObservation(observation: TaskObservation): ObservationResult {
  const previous = db.prepare<[number, string], { status: string; dueAt: string | null }>(`
    SELECT observed_status AS status, due_at AS dueAt FROM task_observations
    WHERE task_id = ? AND source = ?
    ORDER BY id DESC LIMIT 1
  `).get(observation.taskId, observation.source) ?? null;
  const changed = !previous || previous.status !== observation.status || previous.dueAt !== observation.dueAt;
  if (changed) {
    db.prepare(`INSERT INTO task_observations
      (task_id, source, observed_status, due_at, observed_at, evidence_kind)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(observation.taskId, observation.source, observation.status, observation.dueAt,
        observation.observedAt, observation.evidenceKind);
  }
  return { changed, previous };
}

export function recentTaskObservations(source: string, since: string): Array<TaskObservation & { title: string; subject: string | null }> {
  return db.prepare<[string, string], TaskObservation & { title: string; subject: string | null }>(`
    SELECT o.task_id AS taskId, o.source, o.observed_status AS status, o.due_at AS dueAt,
      o.observed_at AS observedAt, o.evidence_kind AS evidenceKind, t.title, t.subject
    FROM task_observations o JOIN tasks t ON t.id = o.task_id
    WHERE o.source = ? AND o.observed_at >= ? ORDER BY o.id ASC
  `).all(source, since);
}
