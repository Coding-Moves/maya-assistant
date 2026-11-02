import { readFileSync, statSync } from 'node:fs';
import { db } from '../../db/client.js';
import { createTask } from '../../db/repos/tasks.js';
import { localDateTimeToUtc } from '../../utils/time.js';
import type { Source } from '../source.js';

export interface VuItem {
  externalId: string;
  kind: 'quiz' | 'assignment';
  course: string;
  title: string;
  dueAt: string;
  duePrecision: 'date' | 'time';
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || cell === '') quoted = !quoted;
      else throw new Error('Invalid CSV quote');
    } else if (char === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function normalizedItems(input: string): VuItem[] {
  const rows = parseCsv(input.replace(/^\uFEFF/, ''));
  const header = ['source_id', 'kind', 'course', 'title', 'due_date', 'due_time'];
  if (rows[0]?.map((part) => part.trim()).join(',') !== header.join(','))
    throw new Error(`Expected CSV header: ${header.join(',')}`);
  if (rows.length > 501) throw new Error('Import is limited to 500 rows');
  const seen = new Set<string>();
  return rows.slice(1).map((row, index) => {
    if (row.length !== 6) throw new Error(`Row ${index + 2}: expected 6 columns`);
    const [rawId, rawKind, rawCourse, rawTitle, rawDate, rawTime] = row.map((value) => value.trim());
    const kind = rawKind?.toLowerCase();
    if (kind !== 'quiz' && kind !== 'assignment') throw new Error(`Row ${index + 2}: kind must be quiz or assignment`);
    if (!rawCourse || !rawTitle || !rawDate) throw new Error(`Row ${index + 2}: course, title and due_date are required`);
    if (rawCourse.length > 100 || rawTitle.length > 300) throw new Error(`Row ${index + 2}: course or title is too long`);
    if (kind === 'quiz' && !rawTime) throw new Error(`Row ${index + 2}: quiz due_time is required`);
    const externalId = rawId || `${kind}:${rawCourse.toLowerCase()}:${rawTitle.toLowerCase()}`;
    if (externalId.length > 500 || seen.has(externalId)) throw new Error(`Row ${index + 2}: duplicate or overlong source_id`);
    seen.add(externalId);
    return {
      externalId,
      kind,
      course: rawCourse,
      title: rawTitle,
      dueAt: localDateTimeToUtc(rawDate!, rawTime || '23:59'),
      duePrecision: rawTime ? 'time' : 'date',
    };
  });
}

function upsert(item: VuItem): 'created' | 'updated' | 'unchanged' {
  const existing = db.prepare<[string], { id: number; status: string; subject: string | null; type: string; title: string; dueAt: string | null; duePrecision: string }>(`
    SELECT t.id, t.status, t.subject, t.type, t.title, t.due_at AS dueAt, t.due_precision AS duePrecision
    FROM source_tasks s JOIN tasks t ON t.id = s.task_id
    WHERE s.source = 'vu-classic-todo' AND s.external_id = ?
  `).get(item.externalId);
  if (!existing) {
    const id = createTask({ type: item.kind, subject: item.course, title: item.title, dueAt: item.dueAt, duePrecision: item.duePrecision });
    db.prepare("INSERT INTO source_tasks (source, external_id, task_id) VALUES ('vu-classic-todo', ?, ?)").run(item.externalId, id);
    return 'created';
  }
  if (existing.status !== 'open') return 'unchanged';
  if (existing.subject === item.course && existing.type === item.kind && existing.title === item.title && existing.dueAt === item.dueAt && existing.duePrecision === item.duePrecision)
    return 'unchanged';
  db.prepare(`
    UPDATE tasks SET subject = ?, type = ?, title = ?, due_at = ?, due_precision = ?,
      reminded_evening = CASE WHEN due_at IS NOT ? THEN 0 ELSE reminded_evening END,
      reminded_morning = CASE WHEN due_at IS NOT ? THEN 0 ELSE reminded_morning END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND status = 'open'
  `).run(item.course, item.kind, item.title, item.dueAt, item.duePrecision, item.dueAt, item.dueAt, existing.id);
  return 'updated';
}

export class VuClassicTodoSource implements Source<VuItem> {
  counts = { created: 0, updated: 0, unchanged: 0 };
  constructor(private readonly path: string) {}

  async start(emit: (item: VuItem) => void = () => {}): Promise<void> {
    if (statSync(this.path).size > 1_000_000) throw new Error('VU CSV must be under 1 MB');
    const items = normalizedItems(readFileSync(this.path, 'utf8'));
    this.counts = db.transaction(() => {
      const counts = { created: 0, updated: 0, unchanged: 0 };
      for (const item of items) {
        emit(item);
        counts[upsert(item)]++;
      }
      return counts;
    })();
  }

  async stop(): Promise<void> {}
}
