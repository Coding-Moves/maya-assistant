import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';

const { ownerInput } = await import('../src/channels/whatsapp/trigger.ts');

test('separate mode accepts inbound owner text without a trigger', () => {
  assert.equal(ownerInput('maya help', false), 'help');
  assert.equal(ownerInput('Hy @maya', false), 'Hy');
  assert.equal(ownerInput('done 1', false), 'done 1');
  assert.equal(ownerInput('hi', false), 'hi');
  assert.equal(ownerInput('any quiz?', false), 'any quiz?');
  assert.equal(ownerInput('Maya', false), 'Maya');
  assert.equal(ownerInput('buy milk', false), 'buy milk');
  assert.equal(ownerInput('maya help', true), null);
  assert.equal(ownerInput('done 1', undefined), null);
});
