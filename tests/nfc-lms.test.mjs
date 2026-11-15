import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GEMINI_API_KEY = 'test-key';
process.env.DATABASE_PATH = ':memory:';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '999999999999@s.whatsapp.net';
process.env.TIMEZONE = 'Asia/Karachi';

const { parseNfcAssignmentRows, parseNfcDueDate } = await import('../src/sources/nfc/lms.ts');

test('parses NFC CMS assignment rows with Pakistan-time deadlines and stable portal IDs', () => {
  const items = parseNfcAssignmentRows([{
    cells: ['Assignment 2', 'AI-312', '10.00', '17 Oct 2026, 02:56 PM', 'Open', 'View'],
    href: 'https://www.cms.nfciet.com/student/assignments/68',
  }]);
  assert.deepEqual(items, [{
    externalId: '68', course: 'AI-312', title: 'Assignment 2', marks: '10.00',
    dueAt: '2026-10-17T09:56:00.000Z', status: 'open',
    portalUrl: 'https://www.cms.nfciet.com/student/assignments/68',
  }]);
});

test('accepts a same-site relative assignment link and stores its canonical URL', () => {
  const [item] = parseNfcAssignmentRows([{
    cells: ['Assignment 3', 'AI-313', '20', '18 Oct 2026, 10:00 AM', 'Open', 'View'],
    href: '/student/assignments/69',
  }]);
  assert.equal(item.portalUrl, 'https://www.cms.nfciet.com/student/assignments/69');
});

test('rejects NFC deadline or table changes instead of guessing', () => {
  assert.throws(() => parseNfcDueDate('tomorrow sometime'), /unrecognized assignment deadline/);
  assert.throws(() => parseNfcAssignmentRows([{
    cells: ['Assignment', 'AI-312'], href: 'https://www.cms.nfciet.com/student/assignments/68',
  }]), /table layout changed/);
});

test('rejects an unfamiliar NFC assignment lifecycle', () => {
  assert.throws(() => parseNfcAssignmentRows([{
    cells: ['Assignment', 'AI-312', '10', '17 Oct 2026, 02:56 PM', 'Waiting for faculty', 'View'],
    href: 'https://www.cms.nfciet.com/student/assignments/68',
  }]), /unrecognized assignment status/);
});
