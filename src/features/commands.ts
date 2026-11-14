import { sendToOwner } from '../channels/whatsapp/send.js';
import { config } from '../config/env.js';
import { joinedGroups } from '../db/repos/groups.js';
import { completableTask, markDone, openTasks } from '../db/repos/tasks.js';
import { runJob } from '../scheduler/jobs.js';
import { formatTaskDue } from '../utils/time.js';
import { ask } from './ask.js';
import { clearCompletionContext, handleNaturalDone } from './natural-done.js';
import { handleMemoryShortcut } from './memory.js';
import { handleNaturalMemory } from './memory-intent.js';
import { getOwnerChatJid } from '../channels/whatsapp/identity.js';
import { handleOwnerControlConfirmation, runOwnerAgent, type OwnerMessageIdentity } from './owner-agent.js';
import { isOwnerControlRequest } from './owner-tools.js';
import { handleOwnerTaskUpdateConfirmation, stageOwnerTaskUpdate } from './owner-task-updates.js';

export async function handleOwnerText(
  text: string,
  send: typeof sendToOwner = sendToOwner,
  answer: typeof ask = ask,
  runDebug: typeof runJob = runJob,
  sourceRef: string | null = null,
  inputKind: 'owner_text' | 'owner_voice' | 'media_description' = 'owner_text',
  identity: OwnerMessageIdentity = { jid: null },
  replyToRef: string | null = null,
): Promise<void> {
  const input = text.trim();
  if (!input) return;
  const lower = input.toLowerCase();
  if (inputKind === 'media_description') {
    const actor = getOwnerChatJid();
    if (actor && !/^(?:done|complete)\s+[1-9]\d*$/iu.test(input)) {
      const updateReply = await stageOwnerTaskUpdate(input, actor, sourceRef);
      if (updateReply !== null) {
        await send(updateReply);
        return;
      }
    }
    await answer(input, undefined, undefined, undefined, undefined, replyToRef);
    return;
  }

  const memoryReply = handleMemoryShortcut(input);
  if (memoryReply !== null) {
    await send(memoryReply);
    return;
  }

  if (config.BOT_MODE === 'separate') {
    const actor = getOwnerChatJid();
    if (actor) {
      const taskUpdateConfirmation = handleOwnerTaskUpdateConfirmation(input, actor);
      if (taskUpdateConfirmation !== null) {
        await send(taskUpdateConfirmation);
        return;
      }
    }
    const confirmation = identity.jid ? handleOwnerControlConfirmation(input, sourceRef, identity) : null;
    if (confirmation !== null) {
      await send(confirmation);
      return;
    }
    if (identity.jid && isOwnerControlRequest(input) && !/^(?:groups?|tasks?|list|help|\?)$/iu.test(input)) {
      const controlReply = await runOwnerAgent(input, sourceRef, identity);
      if (controlReply !== null) {
        await send(controlReply);
        return;
      }
    }
    const naturalMemoryReply = await handleNaturalMemory(input, getOwnerChatJid(), sourceRef);
    if (naturalMemoryReply !== null) {
      await send(naturalMemoryReply);
      return;
    }
    const naturalReply = handleNaturalDone(input);
    if (naturalReply !== null) {
      await send(naturalReply);
      return;
    }
    if (actor && !/^(?:done|complete)\s+[1-9]\d*$/iu.test(input)) {
      const updateReply = await stageOwnerTaskUpdate(input, actor, sourceRef);
      if (updateReply !== null) {
        await send(updateReply);
        return;
      }
    }
    clearCompletionContext();
  }

  if (lower === 'help' || lower === '?') {
    await send(
      config.BOT_MODE === 'separate'
        ? `I can keep an eye on every group I’m in, track quizzes and deadlines, and remind you what is coming up.${config.CALENDAR_SYNC ? ' I can also check your upcoming Google Calendar events.' : ''} Tell me naturally what to remember, or send me a voice note. Send a timetable image or PDF and ask me to save it. /memory and /timetable give quick summaries. You can still send groups, tasks, or done <number>.`
        : 'Commands: help or ?, task/tasks/list, done/complete <id>, /memory, /timetable. Ask me a question for anything else.',
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
            ? `You have ${tasks[0]!.subject ? `${tasks[0]!.subject} — ` : ''}${tasks[0]!.title}${tasks[0]!.dueAt ? ` due ${formatTaskDue(tasks[0]!)}` : ' on your list'}. To tick it off, send done ${tasks[0]!.id}.`
            : tasks.length === 2
              ? `You have ${tasks.map((task) => `${task.subject ? `${task.subject} — ` : ''}${task.title}${task.dueAt ? ` due ${formatTaskDue(task)}` : ''}`).join(' and ')} coming up. To tick one off, send done ${tasks[0]!.id} or done ${tasks[1]!.id}.`
            : `Here's what you have coming up:\n${tasks.map((task) => `• ${task.subject ? `${task.subject} — ` : ''}${task.title}${task.dueAt ? ` — ${formatTaskDue(task)}` : ''} (done ${task.id})`).join('\n')}`
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
  if (/^(?:done|complete)(?:\s|$)/i.test(input) &&
      (config.BOT_MODE === 'self' || /^(?:done|complete)\s+[1-9]\d*$/i.test(input))) {
    const match = /^(?:done|complete)\s+([1-9]\d*)$/i.exec(input);
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(id)) {
      await send(config.BOT_MODE === 'separate'
        ? 'Tell me the task number, like done 1, and I’ll tick it off for you.'
        : 'Use: done <task ID> or complete <task ID>.');
      return;
    }
    const task = Number.isSafeInteger(id) ? completableTask(id) : undefined;
    const done = task ? markDone(id) : false;
    await send(config.BOT_MODE === 'separate'
      ? done && task
        ? `Done! I've ticked off ${task.subject ? `${task.subject} — ` : ''}${task.title} for you 🌿`
        : `I couldn't find an unfinished task with number ${id}. Send tasks and I'll show you what's open.`
      : done ? `Task #${id} marked done.` : `Open task #${id} was not found.`);
    return;
  }

  if (/^\/debug(?:\s|$)/i.test(input)) {
    const match = /^\/debug\s+(morning|evening|weekly)$/i.exec(input);
    if (!match) {
      await send('Use /debug morning, /debug evening, or /debug weekly.');
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

  if (/^debug(?:\s|$)/i.test(input)) {
    await send('Developer controls start with /. Try /debug morning.');
    return;
  }

  await answer(input, undefined, undefined, undefined, undefined, replyToRef);
}
