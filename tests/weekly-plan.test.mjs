import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.TIMEZONE = 'Asia/Karachi';

const { db } = await import('../src/db/client.ts');
const { migrate } = await import('../src/db/migrate.ts');
const { createTask } = await import('../src/db/repos/tasks.ts');
const { runWeeklyPlan } = await import('../src/features/weeklyPlan.ts');

migrate();
after(() => db.close());

test('weekly plan uses only the next seven days and orders tasks by due time', async () => {
  createTask({
    type: 'quiz',
    title: 'Later quiz',
    dueAt: '2026-10-26T09:00:00Z',
  });
  createTask({
    type: 'assignment',
    title: 'Soon assignment',
    dueAt: '2026-10-22T09:00:00Z',
  });
  createTask({
    type: 'exam',
    title: 'Outside window',
    dueAt: '2026-10-29T09:00:00Z',
  });
  createTask({ type: 'quiz', title: 'No date' });
  let prompt = '';
  const sent = [];
  const result = await runWeeklyPlan(
    new Date('2026-10-21T09:00:00Z'),
    async (value) => {
      prompt = value;
      return 'Study for the assignment, then the quiz.';
    },
    async (value) => {
      sent.push(value);
      return true;
    },
  );

  assert.equal(result, true);
  assert.ok(prompt.indexOf('Soon assignment') < prompt.indexOf('Later quiz'));
  assert.doesNotMatch(prompt, /Outside window|No date/);
  assert.match(prompt, /Asia\/Karachi/);
  assert.deepEqual(sent, ['Study for the assignment, then the quiz.']);
});

test('weekly plan skips Gemini and sending when no tasks are due', async () => {
  assert.equal(
    await runWeeklyPlan(
      new Date('2027-01-01T00:00:00Z'),
      async () => {
        throw new Error('Gemini must not run');
      },
      async () => {
        throw new Error('send must not run');
      },
    ),
    false,
  );
});
