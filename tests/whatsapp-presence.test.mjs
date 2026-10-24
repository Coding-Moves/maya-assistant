import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';

const { withOwnerTyping } = await import('../src/channels/whatsapp/send.ts');

test('a stalled typing update does not delay AI work or its answer', async () => {
  let releaseComposing;
  const stalledComposing = new Promise((resolve) => { releaseComposing = resolve; });
  const events = [];
  const answer = await withOwnerTyping(async () => {
    events.push('work');
    return 'answer';
  }, async (type) => {
    events.push(type);
    if (type === 'composing') await stalledComposing;
  });
  assert.equal(answer, 'answer');
  assert.deepEqual(events, ['composing', 'work', 'paused']);
  releaseComposing();
});
