import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const authDir = mkdtempSync(join(tmpdir(), 'maya-auth-lock-test-'));
const lockPath = join(authDir, '.maya-session.lock');
process.env.AUTH_DIR = authDir;
process.env.GEMINI_API_KEY = 'test';

const { acquireAuthSessionLock, AuthSessionInUseError } =
  await import('../src/channels/whatsapp/auth-lock.ts');

after(() => rmSync(authDir, { recursive: true, force: true }));

test('a live lock prevents another user of the auth folder', () => {
  const release = acquireAuthSessionLock();
  try {
    assert.throws(acquireAuthSessionLock, AuthSessionInUseError);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
  } finally {
    release();
  }
  assert.equal(existsSync(lockPath), false);
});

test('a dead process lock is recovered without leaving recovery files', () => {
  writeFileSync(lockPath, JSON.stringify({ pid: 999999999, token: 'old' }));
  const release = acquireAuthSessionLock();
  try {
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
    assert.equal(existsSync(`${lockPath}.recover`), false);
  } finally {
    release();
  }
  assert.equal(existsSync(lockPath), false);
});

test('an unrecognized lock is left untouched for manual inspection', () => {
  writeFileSync(lockPath, 'legacy-lock');
  assert.throws(acquireAuthSessionLock, AuthSessionInUseError);
  assert.equal(readFileSync(lockPath, 'utf8'), 'legacy-lock');
  assert.equal(existsSync(`${lockPath}.recover`), false);
});
