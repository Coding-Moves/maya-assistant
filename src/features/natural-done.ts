import { markDone, openTasks, type Task } from '../db/repos/tasks.js';

const discussionMs = 10 * 60 * 1000;
let discussed: { id: number; at: number } | null = null;
let awaitingChoice: { ids: number[]; at: number } | null = null;

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

function completionSubject(text: string): string | null {
  const input = text.trim().replace(/[.!؟]+$/u, '').trim();
  if (/^(?:done|complete)\s+[1-9]\d*$/iu.test(input)) return null;
  const english = /^(?:(?:i(?:'|’)?ve|i have)\s+(?:done|finished|completed)|i\s+(?:did|finished|completed)|(?:done|finished|completed))(?:\s+(.+))?$/iu.exec(input);
  if (english) return english[1] ?? '';
  const roman = /^(?:ho\s*gay[ai]|kar\s+li(?:ya)?|mukammal)(?:\s+(.+))?$/iu.exec(input);
  if (roman) return roman[1] ?? '';
  const romanTrailing = /^(.+?)\s+(?:ho\s*gay[ai]|kar\s+li(?:ya)?)$/iu.exec(input);
  if (romanTrailing) return romanTrailing[1]!;
  const urdu = /^(?:ہو\s*(?:گیا|گئی)|کر\s*لیا|مکمل)(?:\s+(.+))?$/u.exec(input);
  if (urdu) return urdu[1] ?? '';
  const urduTrailing = /^(.+?)\s+(?:ہو\s*(?:گیا|گئی)|کر\s*لیا)$/u.exec(input);
  return urduTrailing ? urduTrailing[1]! : null;
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
  const tasks = openTasks();
  const now = Date.now();
  const subject = completionSubject(text);
  const pending = awaitingChoice && now - awaitingChoice.at < discussionMs
    ? awaitingChoice.ids
    : null;

  if (subject === null && !pending) return null;
  let matches: Task[];
  if (subject !== null) {
    matches = namedMatches(subject, tasks);
    if (matches.length === 0 && (!subject || ['it', 'this', 'that', 'one', 'ye', 'wo', 'یہ', 'وہ'].includes(normalize(subject)))) {
      if (tasks.length === 1) matches = tasks;
      else if (discussed && now - discussed.at < discussionMs)
        matches = tasks.filter((task) => task.id === discussed!.id);
      else matches = tasks;
    }
  } else {
    matches = namedMatches(text, tasks.filter((task) => pending!.includes(task.id)));
    if (matches.length === 0) {
      awaitingChoice = null;
      return null;
    }
  }

  if (matches.length === 0) {
    awaitingChoice = null;
    return tasks.length === 0
      ? "You're all caught up. I don't see an open task to tick off 🌿"
      : "I couldn't tell which task you mean. Tell me its name, or send tasks to see what's open.";
  }
  if (matches.length > 1) {
    awaitingChoice = { ids: matches.map((task) => task.id), at: now };
    return `Which one did you finish — ${matches.map((task) => task.title).join(', ')}?`;
  }

  const task = matches[0]!;
  clearCompletionContext();
  return markDone(task.id)
    ? `Done! I've ticked off ${task.title} for you 🌿`
    : `I couldn't find ${task.title} among your open tasks. Send tasks and I'll check.`;
}
