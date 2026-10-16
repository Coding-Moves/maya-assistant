import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';

const { ownerInput } = await import('../src/channels/whatsapp/trigger.ts');

test('separate mode accepts inbound owner text without a trigger', () => {
  assert.equal(ownerInput('buy milk', false), 'buy milk');
  assert.equal(ownerInput('buy milk', true), null);
});
