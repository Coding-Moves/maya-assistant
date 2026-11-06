import { z } from 'zod';
import { config } from '../../config/env.js';
import { db } from '../client.js';

export const groupPolicyFieldSchema = z.enum(['ingest', 'media', 'extraction', 'retrieval']);
export type GroupPolicyField = z.infer<typeof groupPolicyFieldSchema>;

export interface GroupPolicy {
  groupId: string;
  name: string | null;
  active: boolean;
  ingest: boolean;
  media: boolean;
  extraction: boolean;
  retrieval: boolean;
  pausedUntil: string | null;
  revision: number;
}

interface PolicyRow {
  groupId: string;
  name: string | null;
  active: number;
  ingest: number | null;
  media: number | null;
  extraction: number | null;
  retrieval: number | null;
  pausedUntil: string | null;
  revision: number | null;
}

const columns: Record<GroupPolicyField, string> = {
  ingest: 'ingest_enabled', media: 'media_enabled',
  extraction: 'extraction_enabled', retrieval: 'retrieval_enabled',
};

function fromRow(row: PolicyRow): GroupPolicy {
  return {
    groupId: row.groupId, name: row.name, active: Boolean(row.active),
    ingest: row.ingest !== 0, media: row.media !== 0,
    extraction: row.extraction !== 0, retrieval: row.retrieval !== 0,
    pausedUntil: row.pausedUntil, revision: row.revision ?? 0,
  };
}

export function getGroupPolicy(groupId: string): GroupPolicy | null {
  const row = db.prepare<[string], PolicyRow>(`SELECT g.id AS groupId, g.name, g.active,
    p.ingest_enabled AS ingest, p.media_enabled AS media,
    p.extraction_enabled AS extraction, p.retrieval_enabled AS retrieval,
    p.paused_until AS pausedUntil, p.revision
    FROM groups g LEFT JOIN group_policies p ON p.group_id = g.id WHERE g.id = ?`).get(groupId);
  return row ? fromRow(row) : null;
}

export function listGroupPolicies(limit = 50): GroupPolicy[] {
  const checked = z.number().int().min(1).max(100).parse(limit);
  return db.prepare<[number], PolicyRow>(`SELECT g.id AS groupId, g.name, g.active,
    p.ingest_enabled AS ingest, p.media_enabled AS media,
    p.extraction_enabled AS extraction, p.retrieval_enabled AS retrieval,
    p.paused_until AS pausedUntil, p.revision
    FROM groups g LEFT JOIN group_policies p ON p.group_id = g.id
    WHERE g.active = 1 ORDER BY g.name COLLATE NOCASE, g.id LIMIT ?`).all(checked).map(fromRow);
}

export function isGroupEnabled(groupId: string, field: GroupPolicyField, now = new Date()): boolean {
  if (config.BOT_MODE !== 'separate') return true;
  const policy = getGroupPolicy(groupId);
  if (!policy) return true; // A newly received group may precede the membership refresh.
  return policy.active && policy[field] && (!policy.pausedUntil || policy.pausedUntil <= now.toISOString());
}

export function setGroupPolicy(groupId: string, field: GroupPolicyField, enabled: boolean): GroupPolicy {
  if (config.BOT_MODE !== 'separate') throw new Error('Group controls are available in separate mode only');
  const existing = getGroupPolicy(groupId);
  if (!existing?.active) throw new Error('That group is not currently joined');
  const column = columns[groupPolicyFieldSchema.parse(field)];
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO group_policies (group_id, updated_at) VALUES (?, ?)`)
      .run(groupId, new Date().toISOString());
    db.prepare(`UPDATE group_policies SET ${column} = ?, revision = revision + 1, updated_at = ? WHERE group_id = ?`)
      .run(Number(enabled), new Date().toISOString(), groupId);
  })();
  return getGroupPolicy(groupId)!;
}

export function setGroupPause(groupId: string, until: string | null, now = new Date()): GroupPolicy {
  if (config.BOT_MODE !== 'separate') throw new Error('Group controls are available in separate mode only');
  const existing = getGroupPolicy(groupId);
  if (!existing?.active) throw new Error('That group is not currently joined');
  if (until !== null) {
    const parsed = new Date(until);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime() ||
      parsed.getTime() > now.getTime() + 30 * 24 * 60 * 60_000)
      throw new Error('Pause must end within the next 30 days');
    until = parsed.toISOString();
  }
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO group_policies (group_id, updated_at) VALUES (?, ?)').run(groupId, now.toISOString());
    db.prepare('UPDATE group_policies SET paused_until = ?, revision = revision + 1, updated_at = ? WHERE group_id = ?')
      .run(until, now.toISOString(), groupId);
  })();
  return getGroupPolicy(groupId)!;
}
