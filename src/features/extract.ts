import { extractionPrompt } from '../ai/prompts.js';
import { generateJson } from '../ai/gemini.js';
import { extractionSchema, type ExtractionResult } from '../ai/schemas.js';
import { sendToOwner } from '../channels/whatsapp/send.js';
import { config } from '../config/env.js';
import { db } from '../db/client.js';
import {
  getUnprocessed,
  incrementExtractAttempts,
  markFailureBatchNotified,
  markProcessed,
  pendingFailureBatches,
  quarantineFailedBatch,
  type Message,
} from '../db/repos/messages.js';
import {
  cancelTask,
  createTask,
  openTasks,
  updateTask,
  type Task,
} from '../db/repos/tasks.js';
import { normalizeUtcIso } from '../utils/time.js';
import { logger } from '../utils/logger.js';

type GenerateExtraction = (prompt: string) => Promise<ExtractionResult>;
type NotifyOwner = (text: string) => Promise<boolean>;

function applyActions(
  result: ExtractionResult,
  messages: readonly Message[],
  tasks: readonly Task[],
): void {
  const messageIds = new Set(messages.map(({ id }) => id));
  const taskIds = new Set(tasks.map(({ id }) => id));

  db.transaction(() => {
    for (const action of result.actions) {
      if (!messageIds.has(action.source_msg_ref))
        throw new Error('Action referenced a message outside the batch');
      if (action.op === 'create') {
        createTask({
          sourceMsgId: action.source_msg_ref,
          subject: action.subject,
          type: action.type,
          title: action.title,
          details: action.details,
          dueAt: action.due_at === null ? null : normalizeUtcIso(action.due_at),
        });
      } else {
        if (!taskIds.has(action.task_id))
          throw new Error(
            'Action referenced a task outside the open task list',
          );
        if (action.op === 'update') {
          if (
            !['subject', 'type', 'title', 'details', 'due_at'].some(
              (field) => field in action,
            )
          ) {
            throw new Error('Update action has no changes');
          }
          const changed = updateTask(action.task_id, {
            lastMsgId: action.source_msg_ref,
            ...(action.subject !== undefined && { subject: action.subject }),
            ...(action.type !== undefined && { type: action.type }),
            ...(action.title !== undefined && { title: action.title }),
            ...(action.details !== undefined && { details: action.details }),
            ...(action.due_at !== undefined && {
              dueAt:
                action.due_at === null ? null : normalizeUtcIso(action.due_at),
            }),
          });
          if (!changed) throw new Error('Task could not be updated');
        } else if (
          !cancelTask(action.task_id, action.source_msg_ref, action.reason)
        ) {
          throw new Error('Task could not be cancelled');
        }
      }
    }
    if (markProcessed(messages.map(({ id }) => id)) !== messages.length) {
      throw new Error('Message batch changed before processing');
    }
  })();
}

async function notifyFailures(send: NotifyOwner): Promise<void> {
  for (const batch of pendingFailureBatches()) {
    const sent = await send(
      `Extraction failed for batch #${batch.id}; message IDs: ${batch.messageIds.join(', ')}. Please check the logs.`,
    );
    if (!sent) break;
    markFailureBatchNotified(batch.id);
  }
}

export async function extractOnce(
  generate: GenerateExtraction = (prompt) =>
    generateJson(prompt, extractionSchema),
  send: NotifyOwner = sendToOwner,
): Promise<void> {
  const messages = getUnprocessed(config.EXTRACT_BATCH_SIZE);
  if (messages.length > 0) {
    try {
      const tasks = openTasks();
      const result = extractionSchema.parse(
        await generate(extractionPrompt(messages, tasks)),
      );
      applyActions(result, messages, tasks);
      logger.info(
        { messageCount: messages.length, actionCount: result.actions.length },
        'Message batch extracted',
      );
    } catch (error) {
      logger.error(
        {
          errorType: error instanceof Error ? error.name : 'unknown',
          messageIds: messages.map(({ id }) => id),
        },
        'Message extraction failed',
      );
      logger.debug({ err: error }, 'Extraction failure details');
      const ids = messages.map(({ id }) => id);
      db.transaction(() => {
        incrementExtractAttempts(ids);
        quarantineFailedBatch(ids);
      })();
    }
  }
  await notifyFailures(send);
}

export function startExtractionInterval(): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await extractOnce();
    } catch (error) {
      logger.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Extraction run failed',
      );
      logger.debug({ err: error }, 'Extraction run failure details');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(
    () => void run(),
    config.EXTRACT_INTERVAL_MIN * 60_000,
  );
  return () => clearInterval(timer);
}
