import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const {
  createMemory, getMemory, searchMemories, updateMemory, cleanupMemories,
  completeMemory, listMemories,
} = await import('../src/db/repos/memories.ts');
const {
  requestMemoryDelete, requestCategoryClear, confirmMemoryChange,
} = await import('../src/db/repos/memory-confirmations.ts');

migrate();
after(() => db.close());

test('permanent memory survives cleanup; FTS follows updates and duplicate saves are rejected', () => {
  const item = createMemory({
    category: 'preference', title: 'Reminder tone', body: 'Keep reminders gentle and short',
    lifecycle: 'permanent', sourceKind: 'owner_text', sourceRef: 'owner-1',
  }, new Date('2026-01-01T00:00:00Z'));
  assert.equal(searchMemories('gentle').map(({ id }) => id).includes(item.id), true);
  assert.throws(() => createMemory({
    category: 'preference', title: 'Reminder tone', body: 'duplicate',
    lifecycle: 'permanent', sourceKind: 'owner_text',
  }), /already exists/);
  updateMemory(item.id, { body: 'Send concise messages' });
  assert.equal(searchMemories('gentle').some(({ id }) => id === item.id), false);
  assert.equal(searchMemories('concise').some(({ id }) => id === item.id), true);
  cleanupMemories(new Date('2030-01-01T00:00:00Z'));
  assert.equal(getMemory(item.id)?.body, 'Send concise messages');
});

test('semi-permanent review is visible and never deletes the record', () => {
  const item = createMemory({
    category: 'semester', title: 'Current term', body: 'Spring 2026',
    lifecycle: 'semi', reviewAt: '2026-04-01T00:00:00Z', sourceKind: 'owner_text',
  });
  assert.deepEqual(cleanupMemories(new Date('2026-04-02T00:00:00Z')).reviewed, 1);
  assert.equal(getMemory(item.id)?.status, 'review');
  assert.deepEqual(cleanupMemories(new Date('2026-04-03T00:00:00Z')).reviewed, 0);
  updateMemory(item.id, { reviewAt: '2026-06-01T00:00:00Z' });
  assert.equal(getMemory(item.id)?.status, 'active');
});

test('temporary memory stays until the due/expiry/completion anchor plus seven days', () => {
  const item = createMemory({
    category: 'note', title: 'Quiz next month', body: 'Review chapters 1–3',
    lifecycle: 'temporary', dueAt: '2026-06-01T10:00:00Z', sourceKind: 'owner_text',
  }, new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(cleanupMemories(new Date('2026-01-09T00:00:00Z')).deleted, 0);
  assert.equal(getMemory(item.id)?.title, 'Quiz next month');
  assert.equal(completeMemory(item.id, new Date('2026-05-30T12:00:00Z')), true);
  assert.deepEqual(cleanupMemories(new Date('2026-06-08T09:59:59Z')).deleted, 0);
  assert.deepEqual(cleanupMemories(new Date('2026-06-08T10:00:00Z')).deleted, 1);
  assert.equal(getMemory(item.id), null);
  assert.deepEqual(cleanupMemories(new Date('2026-06-09T00:00:00Z')).deleted, 0);
});

test('delete and scoped clear require owner-bound single-use confirmation and unchanged targets', () => {
  const actor = 'owner@s.whatsapp.net';
  const sameMillisecond = new Date('2026-01-01T00:00:00Z');
  const item = createMemory({ category: 'private-test', title: 'A', body: 'one', lifecycle: 'permanent', sourceKind: 'owner_text' }, sameMillisecond);
  const token = requestMemoryDelete(item.id, actor, sameMillisecond);
  assert.throws(() => confirmMemoryChange(token, 'other@s.whatsapp.net', new Date('2026-01-01T00:01:00Z')), /expired or already used/);
  updateMemory(item.id, { body: 'changed' }, 'update', sameMillisecond);
  assert.throws(() => confirmMemoryChange(token, actor, new Date('2026-01-01T00:03:00Z')), /changed/);
  const fresh = requestMemoryDelete(item.id, actor, new Date('2026-01-01T00:04:00Z'));
  assert.deepEqual(confirmMemoryChange(fresh, actor, new Date('2026-01-01T00:05:00Z')).count, 1);
  assert.throws(() => confirmMemoryChange(fresh, actor, new Date('2026-01-01T00:06:00Z')), /expired or already used/);
  assert.equal(getMemory(item.id), null);
  const first = createMemory({ category: 'private-test', title: 'B', body: 'two', lifecycle: 'permanent', sourceKind: 'owner_text' });
  const second = createMemory({ category: 'private-test', title: 'C', body: 'three', lifecycle: 'permanent', sourceKind: 'owner_text' });
  const clear = requestCategoryClear('private-test', actor, new Date('2026-01-01T00:00:00Z'));
  assert.equal(clear.count, 2);
  assert.equal(confirmMemoryChange(clear.token, actor, new Date('2026-01-01T00:01:00Z')).count, 2);
  assert.equal(getMemory(first.id), null);
  assert.equal(getMemory(second.id), null);
});

test('full-text search accepts Urdu and Roman Urdu keywords without FTS query syntax injection', () => {
  const urdu = createMemory({ category: 'class', title: 'اردو کلاس', body: 'بدھ کو کلاس ہے', lifecycle: 'permanent', sourceKind: 'owner_text' });
  const roman = createMemory({ category: 'class', title: 'Roman Urdu class', body: 'Kal lecture hai', lifecycle: 'permanent', sourceKind: 'owner_text' });
  assert.equal(searchMemories('کلاس').some(({ id }) => id === urdu.id), true);
  assert.equal(searchMemories('lecture').some(({ id }) => id === roman.id), true);
  assert.doesNotThrow(() => searchMemories('" OR memory_fts MATCH *'));
});

test('online backup contains memory and FTS content and restores cleanly', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'maya-memory-backup-'));
  try {
    const path = join(folder, 'maya.db');
    await db.backup(path);
    const restored = new Database(path, { readonly: true });
    try {
      assert.ok(restored.prepare("SELECT id FROM memory_items WHERE title = 'Reminder tone'").get());
      assert.ok(restored.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'concise'").get());
      assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      restored.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('future schema version fails closed without modifying existing records', () => {
  const before = listMemories({ category: 'preference' }).length;
  db.pragma('user_version = 3');
  assert.throws(() => migrate(), /newer than this Maya build/);
  db.pragma('user_version = 2');
  assert.equal(listMemories({ category: 'preference' }).length, before);
});
