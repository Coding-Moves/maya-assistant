import { config } from '../config/env.js';
import { db } from '../db/client.js';
import { markDone, openTasks, type Task } from '../db/repos/tasks.js';
import { formatTaskDue } from '../utils/time.js';

const discussionMs = 10 * 60 * 1000;
type Language = 'english' | 'roman-urdu' | 'urdu';
let discussed: { id: number; at: number } | null = null;

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function label(task: Task): string {
  return `${task.subject ? `${task.subject} — ` : ''}${task.title}${task.dueAt ? `, ${formatTaskDue(task)}` : ''}`;
}

function namedMatches(name: string, tasks: Task[]): Task[] {
  const needle = normalize(name);
  if (!needle || ['it', 'this', 'that', 'one', 'ye', 'wo', 'یہ', 'وہ'].includes(needle)) return [];
  const words = needle.split(' ');
  return tasks.filter((task) => {
    const title = normalize(task.title);
    const full = normalize(`${task.subject ?? ''} ${task.type} ${task.title}`).split(' ');
    return title === needle || words.every((word) =>
      full.some((part) => part === word || (/^\d{3,}$/u.test(word) && part.endsWith(word))));
  });
}

function completionSubject(text: string): { subject: string; language: Language } | null {
  const input = text.trim().replace(/[.!؟]+$/u, '').trim();
  if (/^(?:done|complete)\s+[1-9]\d*$/iu.test(input)) return null;
  const english = /^(?:(?:i(?:'|’)?ve|i have)\s+(?:done|finished|completed)|i\s+(?:did|finished|completed)|(?:done|finished|completed))(?:\s+(.+))?$/iu.exec(input);
  if (english) return { subject: english[1] ?? '', language: 'english' };
  const trailing = /^(.+?)\s+(?:is\s+)?(?:done|finished|completed)$/iu.exec(input);
  if (trailing) return { subject: trailing[1]!, language: 'english' };
  const roman = /^(?:ho\s*gay[ai]|kar\s+li(?:ya)?|mukammal)(?:\s+(.+))?$/iu.exec(input);
  if (roman) return { subject: roman[1] ?? '', language: 'roman-urdu' };
  const romanTrailing = /^(.+?)\s+(?:ho\s*gay[ai]|kar\s+li(?:ya)?)$/iu.exec(input);
  if (romanTrailing) return { subject: romanTrailing[1]!, language: 'roman-urdu' };
  const urdu = /^(?:ہو\s*(?:گیا|گئی)|کر\s*لیا|مکمل)(?:\s+(.+))?$/u.exec(input);
  if (urdu) return { subject: urdu[1] ?? '', language: 'urdu' };
  const urduTrailing = /^(.+?)\s+(?:ہو\s*(?:گیا|گئی)|کر\s*لیا)$/u.exec(input);
  return urduTrailing ? { subject: urduTrailing[1]!, language: 'urdu' } : null;
}

function reply(language: Language, kind: 'none' | 'unknown' | 'ambiguous' | 'done' | 'missing', title = ''): string {
  if (language === 'roman-urdu') {
    if (kind === 'none') return 'Abhi koi open task nahi hai 🌿';
    if (kind === 'unknown') return 'Kaunsa task complete hua? Naam bata do, ya tasks bhej do.';
    if (kind === 'ambiguous') return `Kaunsa task complete hua?\n${title}`;
    if (kind === 'done') return `Theek hai, ${title} complete kar diya 🌿`;
    return `${title} open tasks mein nahi mila. Tasks bhej kar check kar lo.`;
  }
  if (language === 'urdu') {
    if (kind === 'none') return 'ابھی کوئی کھلا ہوا کام نہیں ہے 🌿';
    if (kind === 'unknown') return 'کون سا کام مکمل ہوا؟ نام بتا دیں یا tasks لکھیں۔';
    if (kind === 'ambiguous') return `کون سا کام مکمل ہوا؟\n${title}`;
    if (kind === 'done') return `ٹھیک ہے، ${title} مکمل کر دیا 🌿`;
    return `${title} کھلے ہوئے کاموں میں نہیں ملا۔ tasks لکھ کر دیکھ لیں۔`;
  }
  if (kind === 'none') return "You're all caught up. I don't see an open task to tick off 🌿";
  if (kind === 'unknown') return "I couldn't tell which task you mean. Tell me its name, or send tasks to see what's open.";
  if (kind === 'ambiguous') return `Which one did you finish?\n${title}`;
  if (kind === 'done') return `Done! I've ticked off ${title} for you 🌿`;
  return `I couldn't find ${title} among your open tasks. Send tasks and I'll check.`;
}

function pendingChoice(now: number): { ids: number[]; language: Language } | null {
  const row = db.prepare<[string, string], { candidate_ids_json: string; language: Language }>(
    'SELECT candidate_ids_json, language FROM owner_task_choices WHERE actor_jid = ? AND expires_at > ?',
  ).get(config.OWNER_JID!, new Date(now).toISOString());
  return row ? { ids: JSON.parse(row.candidate_ids_json) as number[], language: row.language } : null;
}

function saveChoice(tasks: Task[], language: Language, now: number): void {
  db.prepare(`INSERT INTO owner_task_choices (actor_jid, candidate_ids_json, language, expires_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(actor_jid) DO UPDATE SET
    candidate_ids_json = excluded.candidate_ids_json, language = excluded.language,
    expires_at = excluded.expires_at`).run(config.OWNER_JID!, JSON.stringify(tasks.map(({ id }) => id)),
    language, new Date(now + discussionMs).toISOString());
}

export function noteDiscussedTask(answer: string): void {
  const tasks = openTasks();
  const said = ` ${normalize(answer)} `;
  const matches = tasks.filter((task) => said.includes(` ${normalize(task.title)} `) &&
    (!task.subject || said.includes(` ${normalize(task.subject)} `)));
  discussed = matches.length === 1 ? { id: matches[0]!.id, at: Date.now() } : null;
}

export function clearCompletionContext(): void {
  discussed = null;
  if (config.OWNER_JID) db.prepare('DELETE FROM owner_task_choices WHERE actor_jid = ?').run(config.OWNER_JID);
}

export function handleNaturalDone(text: string): string | null {
  if (/^(?:help|\?|task|tasks|list)$/iu.test(text.trim()) || /^debug(?:\s|$)/iu.test(text.trim())) return null;
  const tasks = openTasks();
  const now = Date.now();
  const completion = completionSubject(text);
  const pending = config.OWNER_JID ? pendingChoice(now) : null;
  if (completion === null && !pending) return null;
  const language = completion?.language ?? pending!.language;
  let matches: Task[];
  if (completion !== null) {
    const subject = completion.subject;
    matches = namedMatches(subject, tasks);
    if (matches.length === 0 && (!subject || ['it', 'this', 'that', 'one', 'ye', 'wo', 'یہ', 'وہ'].includes(normalize(subject)))) {
      if (tasks.length === 1) matches = tasks;
      else if (discussed && now - discussed.at < discussionMs)
        matches = tasks.filter((task) => task.id === discussed!.id);
      else matches = tasks;
    }
  } else {
    if (/[?؟]/u.test(text)) return null;
    const choice = normalize(text);
    const candidates = pending!.ids.flatMap((id) => tasks.find((task) => task.id === id) ?? []);
    const ordinal = /^(?:option\s*)?([1-9]\d*)$/iu.exec(choice);
    matches = ordinal ? candidates.slice(Number(ordinal[1]) - 1, Number(ordinal[1]))
      : candidates.filter((task) => namedMatches(choice, [task]).length > 0);
    if (matches.length === 0) return reply(language, 'ambiguous',
      candidates.map((task, i) => `${i + 1}. ${label(task)}`).join('\n'));
  }
  if (matches.length === 0) return tasks.length === 0
    ? reply(language, 'none') : reply(language, 'unknown');
  if (matches.length > 1) {
    if (config.OWNER_JID) saveChoice(matches, language, now);
    return reply(language, 'ambiguous', matches.map((task, i) => `${i + 1}. ${label(task)}`).join('\n'));
  }
  const task = matches[0]!;
  clearCompletionContext();
  return markDone(task.id) ? reply(language, 'done', label(task)) : reply(language, 'missing', label(task));
}
