import { sendToOwner } from '../channels/whatsapp/send.js';
import { config } from '../config/env.js';
import { joinedGroups } from '../db/repos/groups.js';
import { markDone, openTasks } from '../db/repos/tasks.js';
import { runJob } from '../scheduler/jobs.js';
import { formatTaskDue } from '../utils/time.js';
import { ask } from './ask.js';
import { clearCompletionContext, handleNaturalDone } from './natural-done.js';
import { handleMemoryCommand } from './memory.js';

export async function handleOwnerText(
  text: string,
  send: typeof sendToOwner = sendToOwner,
  answer: typeof ask = ask,
  runDebug: typeof runJob = runJob,
): Promise<void> {
  const input = text.trim();
  if (!input) return;
  const lower = input.toLowerCase();

  if (config.BOT_MODE === 'separate') {
    const naturalReply = handleNaturalDone(input);
    if (naturalReply !== null) {
      await send(naturalReply);
      return;
    }
    clearCompletionContext();
  }

  const memoryReply = handleMemoryCommand(input);
  if (memoryReply !== null) {
    await send(memoryReply);
    return;
  }

  if (lower === 'help' || lower === '?') {
    await send(
      config.BOT_MODE === 'separate'
        ? `I can keep an eye on every group I’m in, track quizzes and deadlines, and remind you what is coming up.${config.CALENDAR_SYNC ? ' I can also check your upcoming Google Calendar events.' : ''} I can keep saved memories and a class timetable too. Ask about a group, or send groups, tasks, done <number>, or memory help.`
        : 'Commands: help or ?, task/tasks/list, done/complete <id>, memory help. Ask me a question for anything else.',
    );
    return;
  }
  if (config.BOT_MODE === 'separate' && (lower === 'groups' || lower === 'group')) {
    const groups = joinedGroups();
    await send(groups.length === 0
      ? "I can't see any joined groups yet. I'll refresh the list when WhatsApp reconnects."
      : `I'm in ${groups.length} group${groups.length === 1 ? '' : 's'}:\n${groups.map((group) => `• ${group.name ?? group.id}`).join('\n')}`);
    return;
  }
  if (lower === 'task' || lower === 'tasks' || lower === 'list') {
    const tasks = openTasks();
    await send(
      config.BOT_MODE === 'separate'
        ? tasks.length === 0
          ? "You're all caught up. No open tasks right now 🌿"
          : tasks.length === 1
            ? `You have ${tasks[0]!.title}${tasks[0]!.dueAt ? ` due ${formatTaskDue(tasks[0]!)}` : ' on your list'}. To tick it off, send done ${tasks[0]!.id}.`
            : tasks.length === 2
              ? `You have ${tasks.map((task) => `${task.title}${task.dueAt ? ` due ${formatTaskDue(task)}` : ''}`).join(' and ')} coming up. To tick one off, send done ${tasks[0]!.id} or done ${tasks[1]!.id}.`
            : `Here's what you have coming up:\n${tasks.map((task) => `• ${task.title}${task.dueAt ? ` — ${formatTaskDue(task)}` : ''} (done ${task.id})`).join('\n')}`
        : tasks.length === 0
          ? 'No open tasks.'
          : tasks
            .map(
              (task) =>
                `#${task.id} ${task.subject ? `${task.subject} — ` : ''}${task.title} — ${formatTaskDue(task)}`,
            )
            .join('\n'),
    );
    return;
  }
  if (/^(?:done|complete)(?:\s|$)/i.test(input)) {
    const match = /^(?:done|complete)\s+([1-9]\d*)$/i.exec(input);
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(id)) {
      await send(config.BOT_MODE === 'separate'
        ? 'Tell me the task number, like done 1, and I’ll tick it off for you.'
        : 'Use: done <task ID> or complete <task ID>.');
      return;
    }
    const task = openTasks().find((item) => item.id === id);
    const done = markDone(id);
    await send(config.BOT_MODE === 'separate'
      ? done && task
        ? `Done! I've ticked off ${task.title} for you 🌿`
        : `I couldn't find an open task with number ${id}. Send tasks and I'll show you what's open.`
      : done ? `Task #${id} marked done.` : `Open task #${id} was not found.`);
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
