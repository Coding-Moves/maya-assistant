import { db } from '../db/client.js';
import { activeTimetables, type Timetable } from '../db/repos/timetables.js';
import type { Memory } from '../db/repos/memories.js';

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function describeMemory(item: Memory): string {
  const when = item.dueAt ? `due ${item.dueAt.slice(0, 10)}`
    : item.expiresAt ? `expires ${item.expiresAt.slice(0, 10)}`
      : item.reviewAt ? `review ${item.reviewAt.slice(0, 10)}` : 'no expiry';
  return `#${item.id} ${item.title} (${item.category}, ${item.lifecycle}, ${item.status}; ${when})`;
}

export function formatTimetable(timetable: Timetable, heading = 'Your timetable', page = 1): string {
  const pageSize = 12;
  const pages = Math.max(1, Math.ceil(timetable.entries.length / pageSize));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new RangeError(`Page must be 1–${pages}`);
  const brief = (value: string, max = 80) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const rows = timetable.entries.slice((page - 1) * pageSize, page * pageSize).map((entry) => {
    const day = entry.dayOfWeek ? weekdays[entry.dayOfWeek - 1] : '? day';
    const time = entry.startLocal && entry.endLocal ? `${entry.startLocal}–${entry.endLocal}` : '? time';
    return `${entry.position}. ${day} ${time}: ${brief(entry.subject ?? '? subject')}${entry.location ? `, ${brief(entry.location, 50)}` : ''}${entry.teacher ? ` (${brief(entry.teacher, 50)})` : ''}${entry.uncertainty ? ` [? ${brief(entry.uncertainty, 70)}]` : ''}`;
  });
  return `${heading} (version ${timetable.version.version}, ${timetable.version.timezone}${pages > 1 ? `, page ${page}/${pages}` : ''})${
    timetable.version.validFrom || timetable.version.validUntil
      ? `\nValid ${timetable.version.validFrom ?? '?'} to ${timetable.version.validUntil ?? '?'}` : ''
  }\n${rows.join('\n')}`;
}

export function handleMemoryShortcut(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '/memory') {
    const rows = db.prepare<[], { lifecycle: 'permanent' | 'semi' | 'temporary'; status: string; n: number }>(
      'SELECT lifecycle, status, COUNT(*) AS n FROM memory_items GROUP BY lifecycle, status',
    ).all();
    const count = { permanent: 0, semi: 0, temporary: 0, review: 0 };
    for (const row of rows) {
      count[row.lifecycle] += row.n;
      if (row.status === 'review') count.review += row.n;
    }
    return `I have ${count.permanent} permanent, ${count.semi} semester/project, and ${count.temporary} temporary memories${count.review ? `; ${count.review} need review` : ''}. Tell me what to remember or ask what I've saved.`;
  }
  const show = /^\/timetable(?:\s+(\d+))?$/i.exec(trimmed);
  if (show) {
    const tables = activeTimetables();
    if (!tables.length) return 'I do not have an active timetable yet. Send its image or PDF and tell me you want to save it.';
    try {
      return tables.map((table) => formatTimetable(table, `Timetable #${table.memory.id}`, Number(show[1] ?? '1'))).join('\n\n');
    } catch (error) {
      if (error instanceof RangeError) return 'That page is not available. Send /timetable to see the first page.';
      throw error;
    }
  }
  if (/^\/(?:memory|timetable)\b/i.test(trimmed)) return 'Use /memory for a quick memory summary or /timetable to see your current classes.';
  return null;
}

export function timetablePreview(table: Timetable, previous: Timetable | null): string {
  const oldRows = new Set(previous?.entries.map((entry) =>
    `${entry.dayOfWeek}|${entry.startLocal}|${entry.endLocal}|${entry.subject}|${entry.location}`) ?? []);
  const newRows = new Set(table.entries.map((entry) =>
    `${entry.dayOfWeek}|${entry.startLocal}|${entry.endLocal}|${entry.subject}|${entry.location}`));
  const added = [...newRows].filter((row) => !oldRows.has(row)).length;
  const removed = [...oldRows].filter((row) => !newRows.has(row)).length;
  const diff = previous ? `\nCompared with your current timetable: ${added} added/changed, ${removed} removed/changed.` : '';
  const uncertain = table.entries.filter((entry) => entry.uncertainty || !entry.dayOfWeek || !entry.startLocal || !entry.endLocal || !entry.subject).length;
  const pages = Math.ceil(table.entries.length / 12);
  return `${formatTimetable(table, 'I found this timetable draft')}${pages > 1 ? '\nAsk me to show the next page before confirming.' : ''}${diff}${uncertain ? `\n${uncertain} entr${uncertain === 1 ? 'y needs' : 'ies need'} a careful check. I left unclear details as ?.` : ''}\nIf this looks right, reply “Yes, save the timetable.” To fix a row, tell me naturally, such as “The second class ends at 11 AM.” The draft expires in 30 minutes.`;
}
