import { z } from 'zod';
import type { FunctionDeclaration } from '@google/genai';
import { config } from '../config/env.js';
import { getRuntimeSetting, listRuntimeSettings, resetRuntimeSetting, setRuntimeSetting,
} from '../config/runtime.js';
import { db } from '../db/client.js';
import { getGroupPolicy, listGroupPolicies, setGroupPause, setGroupPolicy } from '../db/repos/group-policies.js';
import { clearMemoryIds, expiredTemporaryMemories, listMemories } from '../db/repos/memories.js';
import { markDone } from '../db/repos/tasks.js';
import { cancelOwnerReminder, createOwnerReminder, getOwnerReminder, listOwnerReminders,
  updateOwnerReminder } from '../db/repos/owner-reminders.js';
import { activeTimetables } from '../db/repos/timetables.js';
import { formatTimetable } from './memory.js';

export const toolResultSchema = z.object({ message: z.string().min(1).max(2_000), data: z.unknown().optional() });
export type ToolResult = z.output<typeof toolResultSchema>;
export type ToolRisk = 'read' | 'reversible' | 'sensitive' | 'destructive';

export interface OwnerTool {
  name: string;
  description: string;
  scope: 'verified_owner';
  risk: ToolRisk;
  timeoutMs: number;
  inputSchema: z.ZodType;
  outputSchema: typeof toolResultSchema;
  parse(raw: unknown): unknown;
  target(args: unknown): string;
  revision(args: unknown): string;
  needsConfirmation(args: unknown): boolean;
  preview(args: unknown): string;
  execute(args: unknown): ToolResult;
}

function tool<T extends z.ZodType>(name: string, description: string, risk: ToolRisk, schema: T,
  target: (args: z.output<T>) => string, execute: (args: z.output<T>) => ToolResult,
  options: { revision?: (args: z.output<T>) => string; confirm?: (args: z.output<T>) => boolean;
    preview?: (args: z.output<T>) => string } = {}): OwnerTool {
  const parse = (raw: unknown) => schema.parse(raw);
  return {
    name, description, scope: 'verified_owner', risk, timeoutMs: 3_000,
    inputSchema: schema, outputSchema: toolResultSchema, parse,
    target: (raw) => target(parse(raw)),
    revision: (raw) => options.revision?.(parse(raw)) ?? '',
    needsConfirmation: (raw) => options.confirm?.(parse(raw)) ?? risk === 'destructive',
    preview: (raw) => options.preview?.(parse(raw)) ?? `${name.replaceAll('_', ' ')} for ${target(parse(raw))}: ${JSON.stringify(parse(raw))}`,
    execute: (raw) => {
      const started = Date.now();
      const result = toolResultSchema.parse(execute(parse(raw)));
      if (Date.now() - started > 3_000) throw new Error('Owner operation exceeded its time limit');
      return result;
    },
  };
}

const empty = z.object({}).strict();
const settingKey = z.enum(['MEDIA_ENABLED', 'MEDIA_MAX_BYTES', 'MEDIA_BATCH_SIZE', 'EXTRACT_BATCH_SIZE']);
const changeableKey = z.enum(['MEDIA_ENABLED', 'MEDIA_BATCH_SIZE', 'EXTRACT_BATCH_SIZE']);
const groupArg = z.object({ group: z.string().trim().min(1).max(120) }).strict();

function groupId(nameOrId: string): string {
  const candidate = nameOrId.trim().replace(/\s+group$/iu, '');
  const rows = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM groups WHERE active = 1 AND (id = ? OR name = ? COLLATE NOCASE) LIMIT 3',
  ).all(candidate, candidate);
  if (rows.length !== 1) throw new Error(rows.length ? 'More than one group has that name. Use its exact JID.' : 'I could not find a joined group with that exact name. Ask me to list groups.');
  return rows[0]!.id;
}

const registry: OwnerTool[] = [
  tool('get_settings', 'Show the current effective non-secret runtime settings and their deployment defaults.', 'read', empty,
    () => 'settings', () => {
      const settings = listRuntimeSettings();
      return { message: `Here are your current settings:\n${settings.map(({ key, value, overridden }) =>
        `• ${key}: ${key === 'MEDIA_MAX_BYTES' ? `${Number(value) / 1_000_000} MB` : String(value)}${overridden ? ' (changed here)' : ' (deployment default)'}`).join('\n')}`,
      data: settings };
    }),
  tool('get_status', 'Show safe health: uptime, memory use and pending queue counts. Never show secrets.', 'read', empty,
    () => 'status', () => { const data = {
      uptimeMinutes: Math.floor(process.uptime() / 60), rssMb: Math.round(process.memoryUsage().rss / 1_000_000),
      pendingMedia: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM media_jobs').get()?.n ?? 0,
      pendingMessages: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM messages WHERE processed = 0').get()?.n ?? 0,
    }; return { message: `Maya is running. Uptime ${data.uptimeMinutes} min, memory ${data.rssMb} MB, ${data.pendingMedia} media files and ${data.pendingMessages} messages waiting.`, data }; }),
  tool('list_groups', 'List joined WhatsApp groups with exact IDs and monitoring policies. Read only.', 'read',
    z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict(),
    () => 'groups', ({ limit }) => { const groups = listGroupPolicies(limit);
      return { message: groups.length ? `I'm in these groups:\n${groups.map(({ name, groupId }) => `• ${name ?? groupId} (${groupId})`).join('\n').slice(0, 1_800)}`
        : "I can't see any joined groups right now.", data: groups }; }),
  tool('get_group_policy', 'Show monitoring, media, extraction and retrieval settings for one joined group.', 'read', groupArg,
    ({ group }) => group, ({ group }) => { const p = getGroupPolicy(groupId(group))!;
      return { message: `${p.name ?? p.groupId}: monitoring ${p.ingest ? 'on' : 'off'}, media ${p.media ? 'on' : 'off'}, task extraction ${p.extraction ? 'on' : 'off'}, answers ${p.retrieval ? 'on' : 'off'}${p.pausedUntil ? `, paused until ${p.pausedUntil}` : ''}.`, data: p }; }),
  tool('set_group_policy', 'Change exactly one group policy: ingest, media, extraction or retrieval. Use an exact joined group name or JID.', 'sensitive',
    groupArg.extend({ field: z.enum(['ingest', 'media', 'extraction', 'retrieval']), enabled: z.boolean() }).strict(),
    ({ group, field }) => `${groupId(group)}:${field}`,
    ({ group, field, enabled }) => ({ message: `${field} is now ${enabled ? 'on' : 'off'} for ${getGroupPolicy(groupId(group))?.name ?? group}.`,
      data: setGroupPolicy(groupId(group), field, enabled) }),
    { revision: ({ group }) => String(getGroupPolicy(groupId(group))?.revision ?? -1),
      confirm: () => true,
      preview: ({ group, field, enabled }) => `turn ${field} ${enabled ? 'on' : 'off'} for ${getGroupPolicy(groupId(group))?.name ?? group}` }),
  tool('pause_group', 'Pause all new monitoring for one joined group until an ISO date-time with timezone, at most 30 days ahead; null resumes.', 'sensitive',
    groupArg.extend({ until: z.string().datetime({ offset: true }).nullable() }).strict(),
    ({ group }) => groupId(group),
    ({ group, until }) => ({ message: until ? `Monitoring is paused until ${until} for ${getGroupPolicy(groupId(group))?.name ?? group}.` : `Monitoring resumed for ${getGroupPolicy(groupId(group))?.name ?? group}.`,
      data: setGroupPause(groupId(group), until) }),
    { revision: ({ group }) => String(getGroupPolicy(groupId(group))?.revision ?? -1),
      confirm: () => true,
      preview: ({ group, until }) => `pause ${getGroupPolicy(groupId(group))?.name ?? group} until ${until}` }),
  tool('set_media_limit', 'Set maximum media size in decimal MB, 1 to 10 inclusive. 10 MB means 10000000 bytes. Larger group files are skipped before download when size is known.', 'sensitive',
    z.object({ megabytes: z.number().int().min(1).max(10) }).strict(),
    () => 'MEDIA_MAX_BYTES', ({ megabytes }) => ({ message: `The media limit is now ${megabytes} MB.`,
      data: { bytes: setRuntimeSetting('MEDIA_MAX_BYTES', megabytes * 1_000_000) } }),
    { revision: () => String(getRuntimeSetting('MEDIA_MAX_BYTES')),
      confirm: ({ megabytes }) => megabytes * 1_000_000 > (getRuntimeSetting('MEDIA_MAX_BYTES') as number),
      preview: ({ megabytes }) => `set the media limit to ${megabytes} MB` }),
  tool('set_runtime_setting', 'Change MEDIA_ENABLED (true or false), MEDIA_BATCH_SIZE (1 to 3) or EXTRACT_BATCH_SIZE (1 to 50). Other settings are deployment-only.', 'reversible',
    z.object({ key: changeableKey, value: z.union([z.boolean(), z.number().int()]) }).strict(),
    ({ key }) => key,
    ({ key, value }) => ({ message: `${key} is now ${String(setRuntimeSetting(key, value))}.` }),
    { revision: ({ key }) => JSON.stringify(getRuntimeSetting(key)),
      confirm: ({ key }) => key === 'MEDIA_ENABLED',
      preview: ({ key, value }) => `set ${key} to ${String(value)}` }),
  tool('reset_runtime_setting', 'Remove a non-secret runtime override and restore the deployment default.', 'reversible',
    z.object({ key: settingKey }).strict(), ({ key }) => key,
    ({ key }) => ({ message: `${key} is back to its deployment default: ${String(resetRuntimeSetting(key))}.` }),
    { revision: ({ key }) => JSON.stringify(getRuntimeSetting(key)),
      confirm: ({ key }) => key === 'MEDIA_ENABLED',
      preview: ({ key }) => `reset ${key} to ${String(config[key])}` }),
  tool('list_tasks', 'List at most 20 open quiz, assignment, exam and other tasks.', 'read', empty,
    () => 'tasks', () => { const tasks = db.prepare<[], { id: number; title: string; dueAt: string | null }>(
      "SELECT id, title, due_at AS dueAt FROM tasks WHERE status = 'open' ORDER BY due_at IS NULL, due_at, id LIMIT 20",
    ).all(); return { message: tasks.length ? `Here are your next tasks:\n${tasks.map(({ id, title, dueAt }) =>
      `• ${id}: ${title.slice(0, 60)}${dueAt ? ` — ${dueAt}` : ''}`).join('\n').slice(0, 1_800)}` : 'You have no open tasks right now.', data: tasks }; }),
  tool('mark_task_done', 'Mark exactly one existing open task done by its ID.', 'reversible',
    z.object({ taskId: z.number().int().positive() }).strict(), ({ taskId }) => `task:${taskId}`,
    ({ taskId }) => {
      const task = db.prepare<[number], { title: string }>("SELECT title FROM tasks WHERE id = ? AND status = 'open'").get(taskId);
      if (!task || !markDone(taskId)) throw new Error('That task is no longer open. Ask to see tasks.');
      return { message: `Done! I’ve ticked off ${task.title} for you.` };
    }),
  tool('list_reminders', 'List upcoming private reminders the owner explicitly created.', 'read', empty,
    () => 'reminders', () => { const reminders = listOwnerReminders(20);
      return { message: reminders.length ? `Your upcoming reminders:\n${reminders.map(({ id, title, dueAt }) =>
        `• ${id}: ${title.slice(0, 60)} — ${dueAt}`).join('\n').slice(0, 1_800)}` : 'You have no upcoming personal reminders.',
      data: reminders }; }),
  tool('create_reminder', 'Create one private reminder. dueAt must be an exact future ISO date-time with timezone; ask for clarification if the owner gives no date or time.', 'reversible',
    z.object({ title: z.string().trim().min(1).max(160), dueAt: z.string().datetime({ offset: true }) }).strict(),
    () => 'new-reminder',
    ({ title, dueAt }) => { const item = createOwnerReminder(title, dueAt, null);
      return { message: `I’ll remind you about ${item.title} at ${item.dueAt}.`, data: { id: item.id, dueAt: item.dueAt } }; }),
  tool('update_reminder', 'Change one upcoming personal reminder by exact ID, with a new title and future ISO date-time with timezone.', 'reversible',
    z.object({ reminderId: z.number().int().positive(), title: z.string().trim().min(1).max(160),
      dueAt: z.string().datetime({ offset: true }) }).strict(),
    ({ reminderId }) => `reminder:${reminderId}`,
    ({ reminderId, title, dueAt }) => { const item = updateOwnerReminder(reminderId, title, dueAt);
      return { message: `I changed your reminder to ${item.title} at ${item.dueAt}.` }; },
    { revision: ({ reminderId }) => String(getOwnerReminder(reminderId)?.revision ?? -1) }),
  tool('cancel_reminder', 'Cancel exactly one upcoming personal reminder by ID. This requires confirmation.', 'sensitive',
    z.object({ reminderId: z.number().int().positive() }).strict(),
    ({ reminderId }) => `reminder:${reminderId}`,
    ({ reminderId }) => { const item = cancelOwnerReminder(reminderId);
      return { message: `Okay, I cancelled the reminder for ${item.title}.` }; },
    { revision: ({ reminderId }) => String(getOwnerReminder(reminderId)?.revision ?? -1), confirm: () => true,
      preview: ({ reminderId }) => `cancel reminder ${reminderId}: ${getOwnerReminder(reminderId)?.title ?? 'unknown'}` }),
  tool('list_memories', 'List at most 10 owner-saved memories. Do not create or delete anything.', 'read', empty,
    () => 'memories', () => { const items = listMemories({ limit: 10 })
      .map(({ id, title, category, lifecycle, status }) => ({ id, title, category, lifecycle, status }));
      return { message: items.length ? `Here are your saved memories:\n${items.map(({ id, title }) => `• ${id}: ${title.slice(0, 80)}`).join('\n')}` : 'I have no saved memories yet.', data: items }; }),
  tool('show_timetable', 'Show the first page of the active class timetable, if one exists.', 'read', empty,
    () => 'timetable', () => ({ message: activeTimetables().slice(0, 1).map((table) => formatTimetable(table)).join('\n') || 'I do not have an active timetable yet.' })),
  tool('cleanup_expired_memories', 'Delete only temporary memories whose expiry grace period has passed; preview exact targets before confirmation.', 'destructive', empty,
    () => { const items = expiredTemporaryMemories();
      if (items.length > 20) throw new Error('Too many expired memories for one safe cleanup');
      return `expired-memories:${items.map(({ id }) => id).join(',')}`; },
    () => { const items = expiredTemporaryMemories();
      if (items.length > 20) throw new Error('Too many expired memories for one safe cleanup');
      const count = clearMemoryIds(items.map(({ id }) => id));
      return { message: `I removed ${count} expired temporary memor${count === 1 ? 'y' : 'ies'}.` }; },
    { revision: () => expiredTemporaryMemories().map(({ id, revision }) => `${id}:${revision}`).join(','),
      confirm: () => expiredTemporaryMemories().length > 0,
      preview: () => `delete these expired temporary memories: ${expiredTemporaryMemories().slice(0, 20)
        .map(({ id, title }) => `${title.slice(0, 50)} (#${id})`).join(', ')}` }),
];

export function ownerTool(name: string): OwnerTool | null { return registry.find((item) => item.name === name) ?? null; }

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== 'object') return value;
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'enum',
    'items', 'anyOf', 'minimum', 'maximum', 'format', 'default']);
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key))
    .map(([key, item]) => [key, compactSchema(item)]));
}

export function ownerToolDeclarations(): FunctionDeclaration[] {
  return registry.map(({ name, description, inputSchema }) => ({
    name, description, parametersJsonSchema: compactSchema(z.toJSONSchema(inputSchema)),
  }));
}

export function isOwnerControlRequest(text: string): boolean {
  const input = text.toLocaleLowerCase();
  if (/\b(?:whatsapp|my|your)\s+status\b/iu.test(input) &&
    !/\b(?:system|service|settings?|monitoring)\b/iu.test(input)) return false;
  return /\b(?:settings?|media\s+(?:reading|limit|size|batch|on|off|band)|(?:enable|disable|turn\s+(?:on|off))\s+media|\d+\s*mb|monitor(?:ing)?|pause|resume|health|queue|cleanup|expired|remind(?:er|ers)?|alert|system\s+status|maya\s+status)\b/iu.test(input) ||
    (/\bgroups?\b/iu.test(input) && /\b(?:list|show|set|change|pause|resume|stop|start|enable|disable|turn|policy|monitor|reading|off|on)\b/iu.test(input)) ||
    /سیٹنگ|نگرانی|یاد\s*دلاؤ|\b(?:group|media)\s+(?:ko|ki)\s+(?:band|on|off|chalu)\b/iu.test(input);
}
