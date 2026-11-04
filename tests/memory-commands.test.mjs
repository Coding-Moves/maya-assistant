import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { handleMemoryCommand } = await import('../src/features/memory.ts');
const { getMemory } = await import('../src/db/repos/memories.ts');

migrate();
after(() => db.close());

test('owner memory commands save, inspect, update and search without a model call', () => {
  const actor = 'owner@s.whatsapp.net';
  assert.match(handleMemoryCommand('memory save permanent food | Tea | I like green tea', actor, 'owner-msg-1'), /saved Tea/);
  assert.equal(getMemory(1)?.sourceRef, 'owner-msg-1');
  assert.match(handleMemoryCommand('memory search green tea', actor), /Tea/);
  assert.match(handleMemoryCommand('memory list category food', actor), /Tea/);
  assert.match(handleMemoryCommand('memory update 1 I like mint tea', actor), /Updated Tea/);
  assert.match(handleMemoryCommand('memory show 1', actor), /mint tea/);
  assert.match(handleMemoryCommand('memory status', actor), /permanent/);
  assert.equal(handleMemoryCommand('hi', actor), null);
});
