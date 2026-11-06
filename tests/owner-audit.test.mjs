import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { setOwnerIdentity } = await import('../src/channels/whatsapp/identity.ts');
const { runOwnerAgent } = await import('../src/features/owner-agent.ts');
const { applyAuditedOwnerAction } = await import('../src/db/repos/owner-actions.ts');
migrate();
setOwnerIdentity({ chatJid: '123@s.whatsapp.net', knownJids: new Set(['123@s.whatsapp.net']) });
after(() => db.close());

test('action audit records metadata without storing a private reminder title', async () => {
  const title = 'private family medical appointment';
  const dueAt = new Date(Date.now() + 180_000).toISOString();
  const response = { candidates: [{ content: { role: 'model', parts: [{ functionCall: {
    id: 'create', name: 'create_reminder', args: { title, dueAt },
  } }] } }] };
  assert.match(await runOwnerAgent('Remind me about a private appointment', 'request-private',
    { jid: '123@s.whatsapp.net' }, async () => response), /private family medical appointment/);
  const auditRows = db.prepare("SELECT target FROM owner_action_audit WHERE tool_name = 'create_reminder'").all();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].target, 'new-reminder');
  assert.ok(db.prepare('PRAGMA table_info(owner_action_audit)').all()
    .every((column) => column.name !== 'result_json'));
});

test('a repeated operation is acknowledged without executing it or exposing its original result', () => {
  const actor = '123@s.whatsapp.net';
  const first = applyAuditedOwnerAction(actor, 'request-2', 'operation-2', 'create_reminder',
    'new-reminder', () => ({ message: 'Private reminder details' }));
  const repeated = applyAuditedOwnerAction(actor, 'request-2', 'operation-2', 'create_reminder',
    'new-reminder', () => { throw new Error('Duplicate operation executed'); });
  assert.equal(first.message, 'Private reminder details');
  assert.equal(repeated.message, 'I already handled that action.');
});
