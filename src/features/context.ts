import { config } from '../config/env.js';
import { db } from '../db/client.js';
import { joinedGroups } from '../db/repos/groups.js';
import { listMemories, searchMemories } from '../db/repos/memories.js';
import { recentJoinedGroupMessages, searchJoinedGroupMessages } from '../db/repos/messages.js';
import { listOwnerReminders } from '../db/repos/owner-reminders.js';
import { activeTimetables, timetableForDay } from '../db/repos/timetables.js';
import { lastCalendarReadAt, upcomingCalendarEvents } from './calendar-read.js';
import { formatInTimezone, localDateInTimezone } from '../utils/time.js';

interface Dialogue { question: string; answer: string; answerRef: string | null; createdAt: string }
type Evidence = Record<string, unknown>;
const maxContextChars = 14_000;
const dialogueMs = 48 * 60 * 60_000;
const credentialWords = /\b(?:password|passcode|api[ -]?key|secret|token|private key|client secret)\b/iu;

function safeText(value: string): string {
  return value.split(/\r?\n/u).map((line) => credentialWords.test(line) ||
    /(?:AIza[\w-]{25,}|gh[pousr]_[\w]{20,})/u.test(line) ? '[credential redacted]' : line)
    .join('\n');
}

const outgoingReplyRefs = new Map<string, { id: string; at: number }>();
const outboundRefTtlMs = 10 * 60 * 1000;

export function recordOwnerReplyRef(text: string, messageId: string | null | undefined): void {
  if (!messageId || !text || config.BOT_MODE !== 'separate') return;
  outgoingReplyRefs.set(text, { id: messageId, at: Date.now() });
  for (const [key, value] of outgoingReplyRefs) {
    if (value.at < Date.now() - outboundRefTtlMs) outgoingReplyRefs.delete(key);
  }
}

function recentDialogue(now: Date, replyToRef: string | null = null): Dialogue[] {
  if (!config.OWNER_JID) return [];
  const since = new Date(now.getTime() - dialogueMs).toISOString();
  const direct = replyToRef ? db.prepare<[string, string, string], Dialogue>(
    `SELECT question, answer, answer_ref AS answerRef, created_at AS createdAt FROM owner_dialogue
     WHERE actor_jid = ? AND answer_ref = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`,
  ).get(config.OWNER_JID, replyToRef, since) : undefined;
  const recent = db.prepare<[string, string], Dialogue>(
    `SELECT question, answer, answer_ref AS answerRef, created_at AS createdAt FROM owner_dialogue
     WHERE actor_jid = ? AND created_at >= ? ORDER BY id DESC LIMIT 3`,
  ).all(config.OWNER_JID, since).reverse();
  return direct ? [direct, ...recent.filter(({ answerRef }) => answerRef !== direct.answerRef)].slice(0, 3) : recent;
}

export function rememberDialogue(question: string, answer: string, now = new Date()): void {
  if (config.BOT_MODE !== 'separate' || !config.OWNER_JID ||
    credentialWords.test(question) || credentialWords.test(answer)) return;
  const replyRef = outgoingReplyRefs.get(answer)?.id ?? null;
  db.prepare('INSERT INTO owner_dialogue (actor_jid, question, answer, answer_ref, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(config.OWNER_JID, question.slice(0, 600), answer.slice(0, 600), replyRef, now.toISOString());
  db.prepare('DELETE FROM owner_dialogue WHERE created_at < ?')
    .run(new Date(now.getTime() - dialogueMs).toISOString());
}

export function cleanupDialogue(now = new Date()): void {
  db.prepare('DELETE FROM owner_dialogue WHERE created_at < ?')
    .run(new Date(now.getTime() - dialogueMs).toISOString());
  db.prepare('DELETE FROM owner_task_choices WHERE expires_at < ?').run(now.toISOString());
}

function matchedGroups(question: string, groups: ReturnType<typeof joinedGroups>): string[] {
  const said = question.toLocaleLowerCase().normalize('NFKC');
  const generic = new Set(['group', 'class', 'official', 'updates', 'section']);
  return groups.filter(({ name }) => {
    if (!name) return false;
    const normalized = name.toLocaleLowerCase().normalize('NFKC');
    const meaningful = normalized.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    return said.includes(normalized) || meaningful
      .filter((word) => word.length >= 5 && !generic.has(word))
      .some((word) => said.includes(word));
  }).map(({ id }) => id);
}

function questionAboutHistory(question: string): boolean {
  return /\b(?:group|chat|said|posted|picture|photo|image|img|video|message|happen|going on|latest|recent)\b|گروپ|تصویر|پیغام/iu.test(question);
}

function appendEvidence(items: Evidence[], entry: Evidence): void {
  if (JSON.stringify([...items, entry]).length <= maxContextChars) items.push(entry);
}

export function separateContext(question: string, now = new Date(), replyToRef: string | null = null): string {
  const dialogue = recentDialogue(now, replyToRef);
  const referential = /\b(?:it|that|there|this|those|same|one)\b|یہ|وہ/iu.test(question);
  const searchQuestion = referential && dialogue.length
    ? `${dialogue.at(-1)!.question} ${question}` : question;
  const groups = joinedGroups();
  const groupIds = matchedGroups(searchQuestion, groups);
  const explicitGroup = groupIds.length > 0;
  const ambiguousGroup = groupIds.length > 1;
  const items: Evidence[] = [];
  const add = (entry: Evidence) => appendEvidence(items, entry);
  const terms = new Set((question.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
  const wantsDeadlines = /\b(?:quiz|quizzes|assignment|deadline|due|exam|task|work|submit|missed|next|upcoming|tomorrow|today|week)\b|کوئز|اسائنمنٹ/iu.test(question);
  const wantsCalendar = /\b(?:calendar|meeting|event|appointment)\b|کیلنڈر/iu.test(question);
  const wantsTimetable = /\b(?:timetable|time table|class|classes|schedule|lecture)\b|ٹائم\s*ٹیبل|کلاس/iu.test(question);
  const wantsMemory = /\b(?:remember|memory|memories|saved|prefer|know about me)\b|یاد/iu.test(question);
  const wantsReminder = /\b(?:reminder|remind|alert)\b|یاد\s*دل/iu.test(question);

  if (wantsDeadlines) {
    const rows = db.prepare<[string, number], { id: number; subject: string | null; type: string; title: string;
      details: string | null; dueAt: string | null; duePrecision: string; status: string; updatedAt: string;
      source: string | null }>(`SELECT t.id, t.subject, t.type, t.title, t.details,
      t.due_at AS dueAt, t.due_precision AS duePrecision, t.status, t.updated_at AS updatedAt,
      s.source FROM tasks t LEFT JOIN source_tasks s ON s.task_id = t.id
      WHERE t.status = 'open' OR (t.status = 'expired' AND t.updated_at >= ?)
      ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.due_at IS NULL, t.due_at, t.id LIMIT ?`)
      .all(new Date(now.getTime() - 14 * 24 * 60 * 60_000).toISOString(), 80);
    const scored = rows.map((row) => {
      const haystack = `${row.subject ?? ''} ${row.type} ${row.title}`.toLocaleLowerCase();
      const relevance = [...terms].filter((term) => term.length >= 2 && haystack.includes(term)).length;
      return { row, relevance };
    }).sort((a, b) => b.relevance - a.relevance ||
      (a.row.dueAt ?? '9999').localeCompare(b.row.dueAt ?? '9999'));
    for (const { row } of scored.slice(0, 14)) add({ kind: 'task', source: row.source ?? 'whatsapp',
      id: row.id, subject: row.subject, type: row.type, title: row.title,
      details: row.details ? safeText(row.details.slice(0, 220)) : null,
      dueAt: row.dueAt, duePrecision: row.duePrecision,
      status: row.status, updatedAt: row.updatedAt });
  }

  const memories = wantsMemory && /\b(?:all|list|what.*remember)\b/iu.test(question)
    ? listMemories({ status: 'active', limit: 6 }) : searchMemories(searchQuestion, 6);
  for (const memory of memories.filter(({ category, title, body }) =>
    !credentialWords.test(`${category} ${title} ${body}`))) add({ kind: 'saved_memory', source: memory.sourceKind,
    id: memory.id, category: memory.category, title: memory.title, body: memory.body.slice(0, 500),
    lifecycle: memory.lifecycle, status: memory.status, updatedAt: memory.updatedAt });

  if (wantsTimetable) {
    const day = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
      .findIndex((name) => new RegExp(`\\b${name}\\b`, 'iu').test(question));
    const timetables = day >= 0 ? timetableForDay(day + 1) : activeTimetables();
    for (const table of timetables.slice(0, 1)) add({ kind: 'confirmed_timetable',
      title: table.memory.title, timezone: table.version.timezone,
      validFrom: table.version.validFrom, validUntil: table.version.validUntil,
      stale: Boolean(table.version.validUntil && table.version.validUntil < localDateInTimezone(now)),
      entries: table.entries.slice(0, 20) });
  }

  if (wantsReminder) for (const reminder of listOwnerReminders(6)) add({
    kind: 'owner_reminder', id: reminder.id, title: reminder.title, dueAt: reminder.dueAt,
  });
  if (wantsCalendar && config.CALENDAR_SYNC) for (const event of upcomingCalendarEvents(8, now))
    add({ kind: 'calendar_event', title: event.title, startAt: event.startAt,
      allDay: Boolean(event.allDay), location: event.location, important: Boolean(event.important),
      cacheReadAt: lastCalendarReadAt() });

  const found = ambiguousGroup ? [] : searchJoinedGroupMessages(searchQuestion, groupIds, 12);
  const messages = ambiguousGroup ? [] :
    (found.length || !questionAboutHistory(question) ? found : recentJoinedGroupMessages(groupIds, 8));
  for (const message of messages) add({ kind: 'group_message', source: message.chatName ??
    groups.find(({ id }) => id === message.chatId)?.name ?? message.chatId,
    id: message.id, at: message.sentAt, author: message.senderName,
    text: safeText(message.text.slice(0, 500)) });

  const vu = db.prepare<[string], { last_success_at: string | null; last_failure_at: string | null }>(
    'SELECT last_success_at, last_failure_at FROM source_sync_state WHERE source = ?',
  ).get('vu-classic-todo');
  return JSON.stringify({
    nowUtc: now.toISOString(), nowLocal: formatInTimezone(now), timezone: config.TIMEZONE,
    selectedGroupNames: explicitGroup ? groups.filter(({ id }) => groupIds.includes(id)).map(({ name }) => name) : [],
    groupSelectionAmbiguous: ambiguousGroup,
    vuSync: config.VU_LMS_SYNC ? { schedule: config.VU_SYNC_CRON, lastSuccessAt: vu?.last_success_at ?? null,
      lastFailureAt: vu?.last_failure_at ?? null } : { enabled: false },
    calendarCacheReadAt: config.CALENDAR_SYNC ? lastCalendarReadAt() : null,
    recentOwnerConversation: dialogue.map(({ question: q, answer, createdAt }) => ({
      question: q.slice(0, 300), answer: answer.slice(0, 300), at: createdAt,
    })),
    evidence: items,
  });
}
