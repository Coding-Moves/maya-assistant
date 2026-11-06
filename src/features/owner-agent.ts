import type { Content, GenerateContentResponse, Part } from '@google/genai';
import { z } from 'zod';
import { generateOwnerToolTurn } from '../ai/gemini.js';
import { getOwnerChatJid, isOwnerChat } from '../channels/whatsapp/identity.js';
import { withOwnerTyping } from '../channels/whatsapp/send.js';
import { config } from '../config/env.js';
import { db } from '../db/client.js';
import { getGroupPolicy } from '../db/repos/group-policies.js';
import { getOwnerReminder } from '../db/repos/owner-reminders.js';
import { applyAuditedOwnerAction, claimOwnerRequest, confirmOwnerProposal,
  finishOwnerRequest, pendingOwnerProposals, proposeOwnerAction, rejectOwnerProposal } from '../db/repos/owner-actions.js';
import { logger } from '../utils/logger.js';
import { ownerTool, ownerToolDeclarations, type OwnerTool, type ToolResult } from './owner-tools.js';

const maxTurns = 3;
const maxCalls = 6;
const maxRequestChars = 2_000;
let serial = Promise.resolve();
let waiting = 0;

type Generate = typeof generateOwnerToolTurn;
export interface OwnerMessageIdentity { jid: string | null | undefined; alternateJid?: string | null | undefined }

function requireOwner(identity: OwnerMessageIdentity): string {
  if (config.BOT_MODE !== 'separate') throw new Error('Owner controls are available in separate mode only');
  if (!isOwnerChat(identity.jid, identity.alternateJid)) throw new Error('This action needs your verified private chat.');
  const actor = getOwnerChatJid();
  if (!actor) throw new Error('I cannot verify your private chat right now. Please try again after reconnecting.');
  return actor;
}

function runTool(tool: OwnerTool, rawArgs: unknown, ownerText: string, actor: string, sourceRef: string | null, index: number):
  { pending: boolean; result: ToolResult } {
  const args = tool.parse(rawArgs);
  const target = tool.target(args);
  if (tool.scope !== 'verified_owner') throw new Error('That operation is not authorized');
  if (['set_group_policy', 'pause_group'].includes(tool.name)) {
    const group = getGroupPolicy(target.split(':')[0]!);
    const requested = ownerText.toLocaleLowerCase().normalize('NFKC');
    if (!group || ![group.name, group.groupId].some((value) => value && requested.includes(value.toLocaleLowerCase().normalize('NFKC'))))
      throw new Error('Please name the exact joined group you want to change.');
  }
  if (['update_reminder', 'cancel_reminder'].includes(tool.name)) {
    const id = Number(target.slice('reminder:'.length));
    const item = getOwnerReminder(id);
    if (!item || (!ownerText.includes(String(id)) && !ownerText.toLocaleLowerCase().includes(item.title.toLocaleLowerCase())))
      throw new Error('Please name the reminder or its number before changing it.');
  }
  if (tool.needsConfirmation(args)) {
    proposeOwnerAction(actor, sourceRef, tool.name, target, args, tool.revision(args));
    return { pending: true, result: { message: `I can ${tool.preview(args)}. Please reply “yes” to confirm within 15 minutes, or “no” to cancel.` } };
  }
  if (tool.risk === 'read') return { pending: false, result: tool.execute(args) };
  const key = sourceRef ? `${actor}:${sourceRef}:${index}` : null;
  return { pending: false, result: applyAuditedOwnerAction(actor, sourceRef, key, tool.name, target, () => tool.execute(args)) };
}

function safeToolOutput(result: ToolResult): Record<string, unknown> {
  const json = JSON.stringify(result);
  return json.length <= 4_000 ? { output: result } : { output: { message: result.message, data: 'Result shortened; ask for a narrower view.' } };
}

export async function runOwnerAgent(input: string, sourceRef: string | null, identity: OwnerMessageIdentity,
  generate: Generate = generateOwnerToolTurn): Promise<string | null> {
  if (config.BOT_MODE !== 'separate') return null;
  const actor = requireOwner(identity);
  if (input.length > maxRequestChars) return 'That request is too long for a settings change. Please send the change in a shorter message.';
  if (waiting >= 8) return 'I am handling several requests right now. Please try again in a moment.';
  waiting += 1;
  const prior = serial;
  let release!: () => void;
  serial = new Promise<void>((resolve) => { release = resolve; });
  let waitTimer: NodeJS.Timeout | undefined;
  const acquired = await Promise.race([
    prior.then(() => true),
    new Promise<false>((resolve) => { waitTimer = setTimeout(() => resolve(false), 10_000); }),
  ]);
  if (waitTimer) clearTimeout(waitTimer);
  waiting -= 1;
  if (!acquired) {
    void prior.then(release);
    return 'I am still handling another request. Please try this change again in a moment.';
  }
  const completed: string[] = [];
  try {
    const claim = claimOwnerRequest(actor, sourceRef);
    if (claim.state === 'claimed') return 'I already started handling that message. Please send a fresh request if it did not finish.';
    if (claim.state === 'completed') return claim.reply ?? 'I handled that request already.';
    const reply = await withOwnerTyping(async () => {
      const contents: Content[] = [{ role: 'user', parts: [{ text: JSON.stringify({
        ownerRequest: input, nowUtc: new Date().toISOString(), timezone: config.TIMEZONE,
      }) }] }];
      const declarations = ownerToolDeclarations();
      let calls = 0;
      const repeatedWrites = new Map<string, ToolResult>();
      const deadline = AbortSignal.timeout(45_000);
      for (let turn = 0; turn < maxTurns; turn += 1) {
        if (deadline.aborted) throw new Error('Owner-control request timed out');
        const response: GenerateContentResponse = await generate(contents, declarations, deadline);
        const candidate = response.candidates?.[0]?.content;
        if (!candidate?.parts?.length) throw new Error('Gemini returned no owner-control response');
        const functionCalls = candidate.parts.flatMap((part) => part.functionCall ? [part.functionCall] : []);
        if (functionCalls.length === 0) return completed.length ? completed.join('\n') : null;
        // Echo the entire model content, including opaque thought signatures and call IDs.
        contents.push(candidate);
        const results: Part[] = [];
        for (const call of functionCalls) {
          if (++calls > maxCalls) return completed.length ? `${completed.join('\n')}\nI stopped there to keep this request safe. Ask me about the remaining change separately.`
            : 'That request needs too many steps. Please split it into smaller changes.';
          const selected = call.name ? ownerTool(call.name) : null;
          if (!selected) throw new Error('Gemini requested an unknown operation');
          const signature = `${selected.name}:${JSON.stringify(call.args ?? {})}`;
          const previous = selected.risk === 'read' ? undefined : repeatedWrites.get(signature);
          const outcome = previous
            ? { pending: false, result: previous }
            : runTool(selected, call.args ?? {}, input, actor, sourceRef, calls);
          if (!previous) completed.push(outcome.result.message);
          if (!previous && selected.risk !== 'read') repeatedWrites.set(signature, outcome.result);
          if (outcome.pending) return [...completed.slice(0, -1), outcome.result.message].join('\n');
          results.push({ functionResponse: {
            ...(call.id ? { id: call.id } : {}), name: selected.name,
            response: safeToolOutput(outcome.result),
          } });
        }
        contents.push({ role: 'user', parts: results });
      }
      return completed.length ? completed.join('\n') : 'I could not finish that request in a few safe steps. Please ask one change at a time.';
    });
    if (reply !== null) finishOwnerRequest(actor, sourceRef, reply);
    else finishOwnerRequest(actor, sourceRef, 'I did not change any settings.');
    return reply;
  } catch (error) {
    logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Owner-control request failed');
    logger.debug({ err: error }, 'Owner-control failure details');
    const failure = error instanceof z.ZodError || (error instanceof Error && /unknown operation|Invalid input|Unrecognized key/iu.test(error.message))
      ? 'I could not safely understand that change. Please name the setting or group more clearly.'
      : error instanceof Error && /^(?:Please name the exact joined group|Please name the reminder|I could not find a joined group|More than one group|That group is not currently joined|That reminder is no longer upcoming|Reminder time must be)/u.test(error.message)
        ? error.message.slice(0, 160)
        : 'I could not finish that change. Please try again.';
    const reply = completed.length ? `${completed.join('\n')}\n${failure}` : failure;
    finishOwnerRequest(actor, sourceRef, reply);
    return reply;
  } finally {
    release();
  }
}

export function handleOwnerControlConfirmation(text: string, sourceRef: string | null,
  identity: OwnerMessageIdentity): string | null {
  if (config.BOT_MODE !== 'separate') return null;
  const actor = requireOwner(identity);
  const pending = pendingOwnerProposals(actor);
  if (pending.length === 0) return null;
  if (/^(?:no|cancel|nah|nahi|نہیں)[\s،,.!]*$/iu.test(text.trim()))
    return rejectOwnerProposal(actor, sourceRef) ? 'Okay, I left it as it was.' : 'That change is no longer pending.';
  if (!/^(?:yes|yeah|yep|confirm|haan|han|ہاں)(?:\b|[\s،,])/iu.test(text.trim())) return null;
  const bareYes = /^(?:yes|yeah|yep|confirm|haan|han|ہاں)[\s،,.!]*(?:please|do it)?[\s،,.!]*$/iu.test(text.trim());
  if (bareYes) {
    const otherPending = db.prepare<[string, string], { n: number }>(`SELECT COUNT(*) AS n FROM memory_confirmations
      WHERE actor_jid = ? AND consumed_at IS NULL AND expires_at > ?`).get(actor, new Date().toISOString())?.n ?? 0;
    if (otherPending) return 'I have more than one change waiting. Please name the one you want to confirm.';
  } else {
    const proposal = pending[0]!;
    const args = proposal.args as Record<string, unknown>;
    const said = text.toLocaleLowerCase().normalize('NFKC');
    const group = typeof args.group === 'string' ? args.group.toLocaleLowerCase().normalize('NFKC') : '';
    const matches = proposal.toolName === 'set_group_policy' || proposal.toolName === 'pause_group'
      ? Boolean(group && said.includes(group))
      : proposal.toolName === 'set_media_limit'
        ? /\b(?:media|limit)\b/iu.test(said) && said.includes(String(args.megabytes))
        : proposal.toolName === 'set_runtime_setting' || proposal.toolName === 'reset_runtime_setting'
          ? said.includes(String(args.key).toLocaleLowerCase().replaceAll('_', ' ')) ||
            (args.key === 'MEDIA_ENABLED' && /\bmedia\b/iu.test(said))
          : proposal.toolName === 'cancel_reminder'
            ? /\breminder\b/iu.test(said) && said.includes(String(args.reminderId))
            : proposal.toolName === 'cleanup_expired_memories'
              ? /\b(?:expired|temporary)\b/iu.test(said) && /\b(?:memor|clean|clear|delet)/iu.test(said)
              : false;
    if (!matches) return null;
  }
  try {
    const result = confirmOwnerProposal(actor, sourceRef,
      (proposal) => {
        const tool = ownerTool(proposal.toolName);
        if (!tool) throw new Error('That operation is no longer available');
        const args = tool.parse(proposal.args);
        if (tool.target(args) !== proposal.target) throw new Error('The target changed. Please ask again.');
        return tool.revision(args);
      },
      (proposal) => {
        const tool = ownerTool(proposal.toolName);
        if (!tool) throw new Error('That operation is no longer available');
        return tool.execute(proposal.args);
      });
    return result.message;
  } catch (error) {
    logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Owner confirmation failed');
    return error instanceof Error && /^(?:That setting changed|That confirmation expired|A memory changed|The target changed)/u.test(error.message)
      ? error.message : 'That confirmation could not be applied. Please ask again.';
  }
}
