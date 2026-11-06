import { randomBytes } from 'node:crypto';
import { db } from '../client.js';

export interface OwnerProposal {
  token: string;
  actorJid: string;
  toolName: string;
  target: string;
  args: unknown;
  stateRevision: string;
  expiresAt: string;
}

interface ProposalRow {
  token: string;
  actorJid: string;
  toolName: string;
  target: string;
  argumentsJson: string;
  stateRevision: string;
  expiresAt: string;
}

function nowIso(): string { return new Date().toISOString(); }

function audit(actorJid: string, sourceRef: string | null, operationKey: string | null,
  toolName: string, target: string, outcome: 'applied' | 'proposed' | 'rejected' | 'failed', result?: unknown): void {
  db.prepare(`INSERT INTO owner_action_audit
    (actor_jid, source_ref, operation_key, tool_name, target, outcome, result_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    actorJid, sourceRef, operationKey, toolName, target, outcome,
    result === undefined ? null : JSON.stringify(result), nowIso(),
  );
}

export type OwnerRequestClaim = { state: 'new' | 'claimed' | 'completed'; reply?: string };

export function claimOwnerRequest(actorJid: string, sourceRef: string | null): OwnerRequestClaim {
  if (!sourceRef) return { state: 'new' };
  return db.transaction(() => {
    const previous = db.prepare<[string, string], { state: string; reply: string | null }>(
      'SELECT state, reply FROM owner_agent_requests WHERE actor_jid = ? AND source_ref = ?',
    ).get(actorJid, sourceRef);
    if (previous) return previous.state === 'completed'
      ? { state: 'completed', reply: previous.reply ?? 'I handled that request already.' } as const
      : { state: 'claimed' } as const;
    db.prepare(`INSERT INTO owner_agent_requests (actor_jid, source_ref, state, updated_at)
      VALUES (?, ?, 'claimed', ?)`).run(actorJid, sourceRef, nowIso());
    return { state: 'new' } as const;
  })();
}

export function finishOwnerRequest(actorJid: string, sourceRef: string | null, reply: string): void {
  if (!sourceRef) return;
  db.prepare(`UPDATE owner_agent_requests SET state = 'completed', reply = ?, updated_at = ?
    WHERE actor_jid = ? AND source_ref = ? AND state = 'claimed'`)
    .run(reply.slice(0, 2_000), nowIso(), actorJid, sourceRef);
}

export function pendingOwnerProposals(actorJid: string, now = new Date()): OwnerProposal[] {
  const rows = db.prepare<[string, string], ProposalRow>(`SELECT token, actor_jid AS actorJid,
    tool_name AS toolName, target, arguments_json AS argumentsJson,
    state_revision AS stateRevision, expires_at AS expiresAt
    FROM owner_action_confirmations WHERE actor_jid = ? AND consumed_at IS NULL AND expires_at > ?
    ORDER BY rowid DESC LIMIT 2`).all(actorJid, now.toISOString());
  return rows.map((row) => ({
    token: row.token, actorJid: row.actorJid, toolName: row.toolName, target: row.target,
    args: JSON.parse(row.argumentsJson), stateRevision: row.stateRevision, expiresAt: row.expiresAt,
  }));
}

export function proposeOwnerAction(actorJid: string, sourceRef: string | null, toolName: string,
  target: string, args: unknown, stateRevision: string): OwnerProposal {
  if (!actorJid) throw new Error('Verified owner identity is required');
  const argumentsJson = JSON.stringify(args);
  if (argumentsJson.length > 2_000) throw new Error('Action proposal is too large');
  const token = randomBytes(12).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE owner_action_confirmations SET consumed_at = ?
      WHERE actor_jid = ? AND consumed_at IS NULL`).run(nowIso(), actorJid);
    db.prepare(`INSERT INTO owner_action_confirmations
      (token, actor_jid, tool_name, target, arguments_json, state_revision, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(token, actorJid, toolName, target, argumentsJson, stateRevision, expiresAt);
    audit(actorJid, sourceRef, null, toolName, target, 'proposed');
  })();
  return { token, actorJid, toolName, target, args, stateRevision, expiresAt };
}

export function applyAuditedOwnerAction<T>(actorJid: string, sourceRef: string | null,
  operationKey: string | null, toolName: string, target: string, execute: () => T): T {
  return db.transaction(() => {
    if (operationKey) {
      const prior = db.prepare<[string], { result_json: string | null }>(
        "SELECT result_json FROM owner_action_audit WHERE operation_key = ? AND outcome = 'applied'",
      ).get(operationKey);
      if (prior) return JSON.parse(prior.result_json ?? 'null') as T;
    }
    const result = execute();
    audit(actorJid, sourceRef, operationKey, toolName, target, 'applied', result);
    return result;
  })();
}

export function confirmOwnerProposal<T>(actorJid: string, sourceRef: string | null,
  currentRevision: (proposal: OwnerProposal) => string,
  execute: (proposal: OwnerProposal) => T): T {
  return db.transaction(() => {
    const pending = pendingOwnerProposals(actorJid);
    if (pending.length !== 1) throw new Error(pending.length ? 'Please name the action you want to confirm.' : 'That confirmation expired or was already used.');
    const proposal = pending[0]!;
    if (currentRevision(proposal) !== proposal.stateRevision) throw new Error('That setting changed. Please ask again so I can show a fresh preview.');
    const result = execute(proposal);
    const consumed = db.prepare(`UPDATE owner_action_confirmations SET consumed_at = ?
      WHERE token = ? AND actor_jid = ? AND consumed_at IS NULL AND expires_at > ?`)
      .run(nowIso(), proposal.token, actorJid, nowIso()).changes;
    if (consumed !== 1) throw new Error('That confirmation expired or was already used.');
    audit(actorJid, sourceRef, proposal.token, proposal.toolName, proposal.target, 'applied', result);
    return result;
  })();
}

export function rejectOwnerProposal(actorJid: string, sourceRef: string | null): boolean {
  return db.transaction(() => {
    const pending = pendingOwnerProposals(actorJid);
    if (pending.length !== 1) return false;
    const proposal = pending[0]!;
    db.prepare('UPDATE owner_action_confirmations SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL')
      .run(nowIso(), proposal.token);
    audit(actorJid, sourceRef, null, proposal.toolName, proposal.target, 'rejected');
    return true;
  })();
}
