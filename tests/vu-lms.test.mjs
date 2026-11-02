import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.TIMEZONE = 'Asia/Karachi';

const { parseClassicTodoTables } = await import('../src/sources/vu/lms.ts');

const tables = () => ({
  assignments: {
    headers: ['Course', 'Assignment', 'Open Date', 'Due Date', 'Action'],
    rows: [['CS301', 'Assignment # 1', 'Oct 29, 2026', 'Nov 03, 2026', 'Submit Now']],
  },
  quizzes: {
    headers: ['Course', 'Title', 'Open Date', 'Due Date', 'Action'],
    rows: [['MTH304', 'Quiz 1', 'Nov 01, 2026 12:00 AM', 'Nov 02, 2026 11:59 PM', 'Take Quiz']],
  },
});

test('reads only assignment and quiz deadlines in the configured timezone', () => {
  const items = parseClassicTodoTables(tables());
  assert.deepEqual(items.map(({ kind, duePrecision, dueAt }) => ({ kind, duePrecision, dueAt })), [
    { kind: 'assignment', duePrecision: 'date', dueAt: '2026-11-03T18:59:00.000Z' },
    { kind: 'quiz', duePrecision: 'time', dueAt: '2026-11-02T18:59:00.000Z' },
  ]);
  assert.equal(items.length, 2);
});

test('accepts a no-pending assignment row and a midnight quiz deadline', () => {
  const input = tables();
  input.assignments.rows = [['No Assignment is pending for any of your course.']];
  input.quizzes.rows = [['CS101', 'Quiz 2', 'Nov 01, 2026', 'Nov 02, 2026 12:00 AM', 'Take Quiz']];
  assert.equal(parseClassicTodoTables(input)[0].dueAt, '2026-11-01T19:00:00.000Z');
});

test('rejects layout changes and malformed deadlines before importing anything', () => {
  const input = tables();
  input.assignments.headers[3] = 'Close Date';
  assert.throws(() => parseClassicTodoTables(input), /layout changed/);
  input.assignments.headers[3] = 'Due Date';
  input.quizzes.rows[0][3] = 'Nov 02, 2026';
  assert.throws(() => parseClassicTodoTables(input), /no due time/);
  input.quizzes.rows[0][3] = 'Nov 02, 2026 13:59 PM';
  assert.throws(() => parseClassicTodoTables(input), /invalid due time/);
});
