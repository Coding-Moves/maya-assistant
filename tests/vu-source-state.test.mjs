import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { syncVuClassicTodo } = await import('../src/features/vu.ts');
migrate();
after(() => db.close());

test('manual and scheduled VU sync share success/failure state', async () => {
  await assert.rejects(syncVuClassicTodo(async () => { throw new Error('LMS unavailable'); }));
  let state = db.prepare("SELECT last_success_at, last_failure_at FROM source_sync_state WHERE source = 'vu-classic-todo'").get();
  assert.equal(state.last_success_at, null);
  assert.ok(state.last_failure_at);
  assert.deepEqual(await syncVuClassicTodo(async () => [], () => ({ created: 0, updated: 0, unchanged: 0 })),
    { created: 0, updated: 0, unchanged: 0 });
  state = db.prepare("SELECT last_success_at, last_failure_at FROM source_sync_state WHERE source = 'vu-classic-todo'").get();
  assert.ok(state.last_success_at);
  assert.equal(state.last_failure_at, null);
});
