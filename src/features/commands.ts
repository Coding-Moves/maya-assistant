import { sendToOwner } from '../channels/whatsapp/send.js';
import { markDone, openTasks } from '../db/repos/tasks.js';
import { formatInTimezone } from '../utils/time.js';
import { ask } from './ask.js';

export async function handleOwnerText(text: string): Promise<void> {
  const input = text.trim();
  if (!input) return;
  const lower = input.toLowerCase();

  if (lower === 'help') {
    await sendToOwner(
      'Commands: help, tasks, done <id>. Ask me a question for anything else.',
    );
    return;
  }
  if (lower === 'tasks') {
    const tasks = openTasks();
    await sendToOwner(
      tasks.length === 0
        ? 'No open tasks.'
        : tasks
            .map(
              (task) =>
                `#${task.id} ${task.subject ? `${task.subject} — ` : ''}${task.title} — ${task.dueAt ? formatInTimezone(new Date(task.dueAt)) : 'no due date'}`,
            )
            .join('\n'),
    );
    return;
  }
  if (/^done(?:\s|$)/i.test(input)) {
    const match = /^done\s+([1-9]\d*)$/i.exec(input);
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(id)) {
      await sendToOwner('Use: done <task ID>.');
      return;
    }
    await sendToOwner(
      markDone(id)
        ? `Task #${id} marked done.`
        : `Open task #${id} was not found.`,
    );
    return;
  }

  await ask(input);
}
