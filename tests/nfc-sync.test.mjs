import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GEMINI_API_KEY = 'test-key';
process.env.DATABASE_PATH = ':memory:';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '999999999999@s.whatsapp.net';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { setUniversityCheckingPaused } = await import('../src/db/repos/source-controls.ts');
const { syncNfcAssignments } = await import('../src/features/nfc.ts');
migrate();

const active = [{
  externalId: '68', course: 'AI-312', title: 'Assignment 2', marks: '10.00', dueAt: '2027-01-17T09:56:00.000Z',
  status: 'open', portalUrl: 'https://www.cms.nfciet.com/student/assignments/68',
}];

test('NFC sync imports an assignment and records source state without retaining credentials', async () => {
  const result = await syncNfcAssignments(
    async (id) => id.includes('STUDENT') ? 'student@example.test' : 'private-password',
    async () => active,
  );
  assert.deepEqual(result, { created: 1, updated: 0, unchanged: 0, skipped: false });
  assert.deepEqual(db.prepare('SELECT subject, title, status FROM tasks').get(), {
    subject: 'AI-312', title: 'Assignment 2', status: 'open',
  });
  assert.deepEqual(db.prepare('SELECT assignment_id AS assignmentId, portal_status AS portalStatus FROM nfc_assignments').get(), {
    assignmentId: '68', portalStatus: 'open',
  });
});

test('pausing NFC prevents Vault and portal access while preserving known assignments', async () => {
  setUniversityCheckingPaused('nfc-cms', true);
  const result = await syncNfcAssignments(
    async () => { throw new Error('Vault must not be called while paused'); },
    async () => { throw new Error('Portal must not be called while paused'); },
  );
  assert.deepEqual(result, { created: 0, updated: 0, unchanged: 0, skipped: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nfc_assignments').get().n, 1);
  setUniversityCheckingPaused('nfc-cms', false);
});

test('a portal-reported submission stops future task reminders', async () => {
  await syncNfcAssignments(async () => 'ignored', async () => [{ ...active[0], status: 'submitted' }]);
  assert.equal(db.prepare('SELECT status FROM tasks').get().status, 'done');
});

test('already expired portal assignments are stored without creating a reminder task', async () => {
  await syncNfcAssignments(async () => 'ignored', async () => [{
    ...active[0], externalId: '69', title: 'Expired assignment', status: 'expired',
  }]);
  assert.deepEqual(db.prepare("SELECT status FROM tasks WHERE title = 'Expired assignment'").get(), { status: 'expired' });
});
