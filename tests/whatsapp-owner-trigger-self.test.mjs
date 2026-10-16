import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_NAME = 'Maya';
process.env.BOT_MODE = 'self';

const { ownerInput } = await import('../src/channels/whatsapp/trigger.ts');

test('self-chat requires an outgoing message with a bot-name trigger', () => {
  assert.equal(ownerInput('maya help', true), 'help');
  assert.equal(ownerInput('@MAYA, tasks', true), 'tasks');
  assert.equal(ownerInput('Maya: done 2', true), 'done 2');
  assert.equal(ownerInput('buy milk', true), null);
  assert.equal(ownerInput('mayonnaise help', true), null);
  assert.equal(ownerInput('maya help', false), null);
});
