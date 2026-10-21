import { sendToOwner } from '../channels/whatsapp/send.js';
import { markDone, openTasks } from '../db/repos/tasks.js';
import { runJob } from '../scheduler/jobs.js';
import { formatInTimezone } from '../utils/time.js';
import { ask } from './ask.js';

export async function handleOwnerText(
  text: string,
  send: typeof sendToOwner = sendToOwner,
  answer: typeof ask = ask,
  runDebug: typeof runJob = runJob,
): Promise<void> {
  const input = text.trim();
  if (!input) return;
  const lower = input.toLowerCase();

  if (lower === 'help' || lower === '?') {
    await send(
      'Commands: help or ?, task/tasks/list, done/complete <id>. Ask me a question for anything else.',
    );
    return;
  }
  if (lower === 'task' || lower === 'tasks' || lower === 'list') {
    const tasks = openTasks();
    await send(
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
  if (/^(?:done|complete)(?:\s|$)/i.test(input)) {
    const match = /^(?:done|complete)\s+([1-9]\d*)$/i.exec(input);
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(id)) {
      await send('Use: done <task ID> or complete <task ID>.');
      return;
    }
    await send(
      markDone(id)
        ? `Task #${id} marked done.`
        : `Open task #${id} was not found.`,
    );
    return;
  }

  if (/^debug(?:\s|$)/i.test(input)) {
    const match = /^debug\s+run\s+(morning|evening|weekly)$/i.exec(input);
    if (!match) {
      await send('Use: debug run <morning|evening|weekly>.');
      return;
    }
    const name = match[1]!.toLowerCase() as 'morning' | 'evening' | 'weekly';
    const result = await runDebug(name);
    if (result !== 'sent') {
      const detail =
        result === 'busy'
          ? 'already running'
          : result === 'failed'
            ? 'failed; check logs'
            : 'completed with no message sent';
      await send(`Debug ${name} run ${detail}.`);
    }
    return;
  }

  await answer(input);
}
