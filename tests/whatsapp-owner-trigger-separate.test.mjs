import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';

const { ownerInput } = await import('../src/channels/whatsapp/trigger.ts');

test('separate mode requires a trigger in an inbound owner message', () => {
  assert.equal(ownerInput('maya help', false), 'help');
  assert.equal(ownerInput('Hy @maya', false), 'Hy');
  assert.equal(ownerInput('buy milk', false), null);
  assert.equal(ownerInput('maya help', true), null);
});
