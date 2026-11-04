import { getOwnerChatJid } from '../channels/whatsapp/identity.js';
import { db } from '../db/client.js';
import { confirmMemoryChange, requestCategoryClear, requestMemoryDelete } from '../db/repos/memory-confirmations.js';
import {
  archiveMemory, completeMemory, createMemory, getMemory, listMemories,
  searchMemories, updateMemory, type Lifecycle, type Memory,
} from '../db/repos/memories.js';
import {
  activeTimetables, confirmTimetable, correctTimetableEntry, getTimetableDraft,
  type Timetable,
} from '../db/repos/timetables.js';
import { localDateTimeToUtc } from '../utils/time.js';

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const memoryHelp = `To save something for later, send:
memory save permanent <category> | <title> | <text>
memory save semi <YYYY-MM-DD> <category> | <title> | <text>
memory save temporary <YYYY-MM-DD> <category> | <title> | <text>

You can also use memory list, memory search <words>, memory show <id>, memory update <id> <text>, memory replace <id> <title> | <text>, memory date <id> review|expiry|due <YYYY-MM-DD>, memory complete <id>, memory archive <id>, or memory delete <id>. Deleting needs a confirmation. Send an image or PDF with the caption “save timetable” to preview a timetable.`;

function dateAt(date: string, time: string): string {
  return localDateTimeToUtc(date, time);
}

function describeMemory(item: Memory): string {
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

function requireActor(actor: string | null): string {
  if (!actor) throw new Error('I need the verified owner chat to confirm this change');
  return actor;
}

export function handleMemoryCommand(
  input: string,
  actorJid: string | null = getOwnerChatJid(),
  sourceRef: string | null = null,
): string | null {
  const trimmed = input.trim();
  if (!/^(?:memory|timetable)(?:\s|$)/i.test(trimmed)) return null;
  try {
    if (/^memory(?:\s+help)?$/i.test(trimmed)) return memoryHelp;
    if (/^memory\s+status$/i.test(trimmed)) {
      const items = db.prepare<[], { lifecycle: Lifecycle; status: string; n: number }>(
        'SELECT lifecycle, status, COUNT(*) AS n FROM memory_items GROUP BY lifecycle, status',
      ).all();
      const counts = { permanent: 0, semi: 0, temporary: 0, review: 0 };
      for (const item of items) {
        counts[item.lifecycle] += item.n;
        if (item.status === 'review') counts.review += item.n;
      }
      return `I have ${counts.permanent} permanent, ${counts.semi} semester/project, and ${counts.temporary} temporary memories${counts.review ? `; ${counts.review} need review` : ''}.`;
    }
    const save = /^memory\s+save\s+(permanent|semi|temporary)(?:\s+(\d{4}-\d{2}-\d{2}))?\s+(.+)$/is.exec(trimmed);
    if (save) {
      const lifecycle = save[1]!.toLowerCase() as Lifecycle;
      const parts = save[3]!.split('|').map((part) => part.trim());
      if (parts.length !== 3) return 'Please send category | title | text. Send memory help for an example.';
      const date = save[2];
      if (lifecycle !== 'permanent' && !date) return 'Please include a YYYY-MM-DD review or expiry date.';
      if (lifecycle === 'permanent' && date) return 'Permanent memories have no expiry date.';
      const item = createMemory({
        lifecycle, category: parts[0]!, title: parts[1]!, body: parts[2]!,
        sourceKind: 'owner_text', sourceRef,
        ...(lifecycle === 'semi' && { reviewAt: dateAt(date!, '00:00') }),
        ...(lifecycle === 'temporary' && { expiresAt: dateAt(date!, '23:59') }),
      });
      return `I've saved ${item.title} as a ${item.lifecycle} memory (#${item.id}).`;
    }
    const list = /^memory\s+list(?:\s+(permanent|semi|temporary|category\s+.+))?$/i.exec(trimmed);
    if (list) {
      const selected = list[1]?.toLowerCase();
      const items = listMemories({
        ...(selected && ['permanent', 'semi', 'temporary'].includes(selected) && { lifecycle: selected as Lifecycle }),
        ...(selected?.startsWith('category ') && { category: list[1]!.slice(9).trim() }),
      });
      return items.length ? items.map(describeMemory).join('\n') : 'I have no memories in that list yet.';
    }
    const show = /^memory\s+show\s+(\d+)$/i.exec(trimmed);
    if (show) {
      const item = getMemory(Number(show[1]));
      return item ? `${describeMemory(item)}\n${item.body}` : 'I could not find that memory.';
    }
    const search = /^memory\s+search\s+(.+)$/is.exec(trimmed);
    if (search) {
      const found = searchMemories(search[1]!);
      return found.length ? found.map(describeMemory).join('\n') : 'I could not find a matching memory.';
    }
    const update = /^memory\s+update\s+(\d+)\s+([\s\S]+)$/i.exec(trimmed);
    if (update) {
      const item = updateMemory(Number(update[1]), { body: update[2]!.trim() });
      return `Updated ${item.title}.`;
    }
    const replace = /^memory\s+replace\s+(\d+)\s+([^|]+)\|([\s\S]+)$/i.exec(trimmed);
    if (replace) {
      const item = updateMemory(Number(replace[1]), { title: replace[2]!.trim(), body: replace[3]!.trim() }, 'replace');
      return `Replaced memory #${item.id} with ${item.title}.`;
    }
    const setDate = /^memory\s+date\s+(\d+)\s+(review|expiry|due)\s+(\d{4}-\d{2}-\d{2})$/i.exec(trimmed);
    if (setDate) {
      const field = setDate[2]!.toLowerCase();
      const value = dateAt(setDate[3]!, field === 'expiry' ? '23:59' : '00:00');
      const item = updateMemory(Number(setDate[1]), field === 'review' ? { reviewAt: value }
        : field === 'expiry' ? { expiresAt: value } : { dueAt: value });
      return `Updated ${item.title}'s ${field} date.`;
    }
    const complete = /^memory\s+complete\s+(\d+)$/i.exec(trimmed);
    if (complete) return completeMemory(Number(complete[1])) ? 'Done. I marked that temporary memory complete.' : 'That is not an active temporary memory.';
    const archive = /^(?:memory|timetable)\s+archive\s+(\d+)$/i.exec(trimmed);
    if (archive) return archiveMemory(Number(archive[1])) ? 'Archived. I can still show it if you ask by ID.' : 'I could not find an active memory with that ID.';
    const remove = /^(?:memory|timetable)\s+delete\s+(\d+)$/i.exec(trimmed);
    if (remove) {
      const id = Number(remove[1]);
      if (trimmed.toLowerCase().startsWith('timetable') && getMemory(id)?.category !== 'timetable')
        return 'That ID is not a timetable.';
      const token = requestMemoryDelete(id, requireActor(actorJid));
      return `Please confirm deleting memory #${id}. Send memory confirm ${token} within 15 minutes. This cannot be undone here.`;
    }
    const clear = /^memory\s+clear\s+category\s+(.+)$/i.exec(trimmed);
    if (clear) {
      const { token, count } = requestCategoryClear(clear[1]!, requireActor(actorJid));
      return `This will delete ${count} memor${count === 1 ? 'y' : 'ies'} in category ${clear[1]!.trim()}. Send memory confirm ${token} within 15 minutes.`;
    }
    const confirm = /^memory\s+confirm\s+([0-9a-f]{12})$/i.exec(trimmed);
    if (confirm) {
      const result = confirmMemoryChange(confirm[1]!, requireActor(actorJid));
      return `Done. I deleted ${result.count} memor${result.count === 1 ? 'y' : 'ies'}.`;
    }
    const showTable = /^timetable\s+show(?:\s+(\d+))?$/i.exec(trimmed);
    if (showTable) {
      const tables = activeTimetables();
      return tables.length ? tables.map((table) => formatTimetable(table, `Timetable #${table.memory.id}`, Number(showTable[1] ?? '1'))).join('\n\n')
        : 'I do not have an active timetable yet. Send its image or PDF with the caption “save timetable”.';
    }
    const draft = /^timetable\s+draft\s+([0-9a-f]{12})(?:\s+(\d+))?$/i.exec(trimmed);
    if (draft) {
      const table = getTimetableDraft(draft[1]!, requireActor(actorJid));
      return table ? formatTimetable(table, 'Timetable draft', Number(draft[2] ?? '1')) : 'That draft expired or was already confirmed.';
    }
    const correct = /^timetable\s+correct\s+([0-9a-f]{12})\s+(\d+)\s+(day_of_week|start_local|end_local|subject|location|teacher)\s+(.+)$/i.exec(trimmed);
    if (correct) {
      const table = correctTimetableEntry(
        correct[1]!, requireActor(actorJid), Number(correct[2]),
        correct[3]!.toLowerCase() as 'day_of_week' | 'start_local' | 'end_local' | 'subject' | 'location' | 'teacher', correct[4]!,
      );
      return formatTimetable(table, 'Corrected draft');
    }
    const confirmTable = /^timetable\s+confirm\s+([0-9a-f]{12})$/i.exec(trimmed);
    if (confirmTable) {
      const table = confirmTimetable(confirmTable[1]!, requireActor(actorJid));
      return `Saved ${table.memory.title} with ${table.entries.length} classes. I can answer questions about it now.`;
    }
    return `I didn't recognize that memory command. ${memoryHelp}`;
  } catch (error) {
    return error instanceof Error ? error.message : 'I could not change that memory. Please try again.';
  }
}

export function timetablePreview(table: Timetable, token: string, previous: Timetable | null): string {
  const oldRows = new Set(previous?.entries.map((entry) =>
    `${entry.dayOfWeek}|${entry.startLocal}|${entry.endLocal}|${entry.subject}|${entry.location}`) ?? []);
  const newRows = new Set(table.entries.map((entry) =>
    `${entry.dayOfWeek}|${entry.startLocal}|${entry.endLocal}|${entry.subject}|${entry.location}`));
  const added = [...newRows].filter((row) => !oldRows.has(row)).length;
  const removed = [...oldRows].filter((row) => !newRows.has(row)).length;
  const diff = previous ? `\nCompared with your current timetable: ${added} added/changed, ${removed} removed/changed.` : '';
  const uncertain = table.entries.filter((entry) => entry.uncertainty || !entry.dayOfWeek || !entry.startLocal || !entry.endLocal || !entry.subject).length;
  const pages = Math.ceil(table.entries.length / 12);
  return `${formatTimetable(table, 'I found this timetable draft')}${pages > 1 ? `\nRead the rest with timetable draft ${token} 2 before confirming.` : ''}${diff}${uncertain ? `\n${uncertain} entr${uncertain === 1 ? 'y needs' : 'ies need'} a careful check. I left unclear details as ?.` : ''}\nReply timetable confirm ${token} within 30 minutes to save it. To correct a cell: timetable correct ${token} <entry number> <day_of_week|start_local|end_local|subject|location|teacher> <value>.`;
}
