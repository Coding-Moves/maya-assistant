import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { rememberGroup } = await import('../src/db/repos/groups.ts');
const { setGroupPolicy } = await import('../src/db/repos/group-policies.ts');
const { insertMessage } = await import('../src/db/repos/messages.ts');
const { separateContext, rememberDialogue, recordOwnerReplyRef } = await import('../src/features/context.ts');
const { createTask } = await import('../src/db/repos/tasks.ts');
migrate();
after(() => db.close());

function add(group, id, text) {
  insertMessage({ externalId: id, chatId: group, text, sentAt: '2026-11-01T10:00:00.000Z' });
}
let retrievalPrecision = 0;
let retrievalRecall = 0;

test('targeted FTS retrieval finds relevant older material without dumping recent chatter', () => {
  rememberGroup('study@g.us', 'Probability and Statistics');
  rememberGroup('family@g.us', 'Family Updates');
  add('study@g.us', 'exam', 'MTH1304 exam room moved to Hall C');
  for (let i = 0; i < 80; i++) add('family@g.us', `chatter-${i}`, `Dinner plan number ${i}`);
  const context = JSON.parse(separateContext('Where is the MTH1304 exam room?'));
  const messages = context.evidence.filter((item) => item.kind === 'group_message');
  const hits = messages.filter((item) => item.text?.includes('Hall C')).length;
  retrievalPrecision = hits / Math.max(1, messages.length);
  retrievalRecall = hits / 1;
  assert.equal(retrievalPrecision, 1);
  assert.equal(retrievalRecall, 1);
  assert.ok(context.evidence.every((item) => !item.text?.includes('Dinner plan')));
  assert.ok(JSON.stringify(context).length < 16_000);
});

test('group policy blocks search and recent fallback before model context is assembled', () => {
  setGroupPolicy('study@g.us', 'retrieval', false);
  const context = JSON.parse(separateContext('What happened in Probability and Statistics group?'));
  assert.ok(context.evidence.every((item) => !item.text?.includes('Hall C')));
  setGroupPolicy('study@g.us', 'retrieval', true);
});

test('credential-like group text is redacted before it can reach Gemini context', () => {
  add('study@g.us', 'credential', 'LMS password: very-private-value');
  const context = separateContext('What did the group say about password?');
  assert.doesNotMatch(context, /very-private-value/);
  assert.match(context, /credential redacted/);
});

test('a follow-up about that group uses recent owner conversation but stays in the named group', () => {
  add('study@g.us', 'image', 'A timetable image was posted today');
  rememberDialogue('What happened in Probability and Statistics?', 'A timetable was posted.');
  const context = JSON.parse(separateContext('Is there an image in that group?'));
  assert.deepEqual(context.selectedGroupNames, ['Probability and Statistics']);
  assert.ok(context.evidence.some((item) => item.text?.includes('timetable image')));
  assert.ok(context.evidence.every((item) => item.source !== 'Family Updates'));
});

test('a WhatsApp reply reference brings the exact earlier turn into the bounded private context', () => {
  recordOwnerReplyRef('The exam room is Hall C.', 'maya-reply-42');
  rememberDialogue('Where is the MTH1304 exam?', 'The exam room is Hall C.');
  const context = JSON.parse(separateContext('What should I take there?', new Date(), 'maya-reply-42'));
  assert.equal(context.recentOwnerConversation[0].question, 'Where is the MTH1304 exam?');
  assert.equal(context.recentOwnerConversation[0].answer, 'The exam room is Hall C.');
});

test('deadline context includes source and course while remaining bounded', () => {
  for (let i = 0; i < 80; i++) createTask({ type: 'quiz', subject: `CS${i}`, title: `Quiz ${i}`,
    dueAt: '2027-02-01T09:00:00.000Z' });
  const context = JSON.parse(separateContext('When is the CS79 quiz?'));
  const tasks = context.evidence.filter((item) => item.kind === 'task');
  assert.ok(tasks.length <= 14);
  assert.ok(tasks.some((item) => item.subject === 'CS79'));
  assert.ok(JSON.stringify(context).length < 16_000);
  process.stdout.write(`Phase 3 fixture metrics: retrievalPrecision=${retrievalPrecision.toFixed(2)}, retrievalRecall=${retrievalRecall.toFixed(2)}, evidence=${context.evidence.length}, bytes=${Buffer.byteLength(JSON.stringify(context))}, rssMB=${Math.round(process.memoryUsage().rss / 1_000_000)}\n`);
});
