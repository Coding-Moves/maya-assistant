import { markDone, openTasks, type Task } from '../db/repos/tasks.js';

const discussionMs = 10 * 60 * 1000;
type Language = 'english' | 'roman-urdu' | 'urdu';
let discussed: { id: number; at: number } | null = null;
let awaitingChoice: { ids: number[]; at: number; language: Language } | null = null;

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function namedMatches(name: string, tasks: Task[]): Task[] {
  const needle = normalize(name);
  if (!needle || ['it', 'this', 'that', 'one', 'ye', 'wo', 'یہ', 'وہ'].includes(needle)) return [];
  return tasks.filter((task) => {
    const title = normalize(task.title);
    return title === needle || (` ${title} `).includes(` ${needle} `) || (` ${needle} `).includes(` ${title} `);
  });
}

function completionSubject(text: string): { subject: string; language: Language } | null {
  const input = text.trim().replace(/[.!؟]+$/u, '').trim();
  if (/^(?:done|complete)\s+[1-9]\d*$/iu.test(input)) return null;
  const english = /^(?:(?:i(?:'|’)?ve|i have)\s+(?:done|finished|completed)|i\s+(?:did|finished|completed)|(?:done|finished|completed))(?:\s+(.+))?$/iu.exec(input);
  if (english) return { subject: english[1] ?? '', language: 'english' };
  const roman = /^(?:ho\s*gay[ai]|kar\s+li(?:ya)?|mukammal)(?:\s+(.+))?$/iu.exec(input);
  if (roman) return { subject: roman[1] ?? '', language: 'roman-urdu' };
  const romanTrailing = /^(.+?)\s+(?:ho\s*gay[ai]|kar\s+li(?:ya)?)$/iu.exec(input);
  if (romanTrailing) return { subject: romanTrailing[1]!, language: 'roman-urdu' };
  const urdu = /^(?:ہو\s*(?:گیا|گئی)|کر\s*لیا|مکمل)(?:\s+(.+))?$/u.exec(input);
  if (urdu) return { subject: urdu[1] ?? '', language: 'urdu' };
  const urduTrailing = /^(.+?)\s+(?:ہو\s*(?:گیا|گئی)|کر\s*لیا)$/u.exec(input);
  return urduTrailing ? { subject: urduTrailing[1]!, language: 'urdu' } : null;
}

function completionReply(language: Language, kind: 'none' | 'unknown' | 'ambiguous' | 'done' | 'missing', taskTitle = ''): string {
  if (language === 'roman-urdu') {
    if (kind === 'none') return 'Abhi koi open task nahi hai 🌿';
    if (kind === 'unknown') return 'Kaunsa task complete hua? Naam bata do, ya tasks bhej do.';
    if (kind === 'ambiguous') return `Kaunsa task complete hua — ${taskTitle}?`;
    if (kind === 'done') return `Theek hai, ${taskTitle} complete kar diya 🌿`;
    return `${taskTitle} open tasks mein nahi mila. Tasks bhej kar check kar lo.`;
  }
  if (language === 'urdu') {
    if (kind === 'none') return 'ابھی کوئی کھلا ہوا کام نہیں ہے 🌿';
    if (kind === 'unknown') return 'کون سا کام مکمل ہوا؟ نام بتا دیں یا tasks لکھیں۔';
    if (kind === 'ambiguous') return `کون سا کام مکمل ہوا — ${taskTitle}؟`;
    if (kind === 'done') return `ٹھیک ہے، ${taskTitle} مکمل کر دیا 🌿`;
    return `${taskTitle} کھلے ہوئے کاموں میں نہیں ملا۔ tasks لکھ کر دیکھ لیں۔`;
  }
  if (kind === 'none') return "You're all caught up. I don't see an open task to tick off 🌿";
  if (kind === 'unknown') return "I couldn't tell which task you mean. Tell me its name, or send tasks to see what's open.";
  if (kind === 'ambiguous') return `Which one did you finish — ${taskTitle}?`;
  if (kind === 'done') return `Done! I've ticked off ${taskTitle} for you 🌿`;
  return `I couldn't find ${taskTitle} among your open tasks. Send tasks and I'll check.`;
}

export function noteDiscussedTask(answer: string): void {
  const tasks = openTasks();
  const normalizedAnswer = ` ${normalize(answer)} `;
  const matches = tasks.filter((task) => normalizedAnswer.includes(` ${normalize(task.title)} `));
  discussed = matches.length === 1 ? { id: matches[0]!.id, at: Date.now() } : null;
  awaitingChoice = null;
}

export function clearCompletionContext(): void {
  discussed = null;
  awaitingChoice = null;
}

export function handleNaturalDone(text: string): string | null {
  if (/^(?:help|\?|task|tasks|list)$/iu.test(text.trim()) || /^debug(?:\s|$)/iu.test(text.trim())) return null;
  const tasks = openTasks();
  const now = Date.now();
  const completion = completionSubject(text);
  const pending = awaitingChoice && now - awaitingChoice.at < discussionMs
    ? awaitingChoice
    : null;

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
    // A follow-up question must never be mistaken for confirmation.
    if (/[?؟]/u.test(text)) return null;
    const choice = normalize(text);
    matches = tasks.filter((task) => pending!.ids.includes(task.id) && normalize(task.title) === choice);
    if (matches.length === 0) {
      awaitingChoice = null;
      return null;
    }
  }

  if (matches.length === 0) {
    awaitingChoice = null;
    return tasks.length === 0
      ? completionReply(language, 'none')
      : completionReply(language, 'unknown');
  }
  if (matches.length > 1) {
    awaitingChoice = { ids: matches.map((task) => task.id), at: now, language };
    return completionReply(language, 'ambiguous', matches.map((task) => task.title).join(', '));
  }

  const task = matches[0]!;
  clearCompletionContext();
  return markDone(task.id)
    ? completionReply(language, 'done', task.title)
    : completionReply(language, 'missing', task.title);
}
