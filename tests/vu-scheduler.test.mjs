import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.VU_LMS_SYNC = 'true';
process.env.VU_STUDENT_ID = 'test-student';
process.env.VU_PASSWORD = 'test-password';
process.env.VU_SYNC_CRON = '0 6 * * *';

const { startJobs } = await import('../src/scheduler/jobs.ts');

test('daily VU check uses the timezone, does not overlap, and stops cleanly', async () => {
  const registrations = [];
  let runs = 0;
  let finish;
  const stop = startJobs({
    vu: async () => {
      runs++;
      return new Promise((resolve) => { finish = resolve; });
    },
    schedule: (expression, callback, options) => {
      registrations.push({ expression, callback, options });
      return { stop: () => undefined };
    },
    every: () => 1,
    clear: () => undefined,
  });
  const vu = registrations.find(({ options }) => options.name === 'maya-vu-classic-todo');
  assert.equal(registrations.length, 5);
  assert.equal(vu.expression, '0 6 * * *');
  assert.equal(vu.options.timezone, 'Asia/Karachi');
  assert.equal(vu.options.noOverlap, true);
  vu.callback();
  vu.callback();
  assert.equal(runs, 1);
  finish({ created: 1, updated: 0, unchanged: 0 });
  await stop();
});
