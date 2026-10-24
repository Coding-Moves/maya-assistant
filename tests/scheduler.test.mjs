import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.EXTRACT_INTERVAL_MIN = '7';
process.env.TIMEZONE = 'Asia/Karachi';

const { startJobs } = await import('../src/scheduler/jobs.ts');

test('scheduler applies timezone to every cron job and prevents overlapping extraction', async () => {
  const registrations = [];
  let intervalCallback;
  let intervalMs;
  let clearCount = 0;
  let stopCount = 0;
  let extractionCount = 0;
  let finishExtraction;

  const stop = startJobs({
    extract: async () => {
      extractionCount += 1;
      await new Promise((resolve) => {
        finishExtraction = resolve;
      });
    },
    schedule: (expression, callback, options) => {
      registrations.push({ expression, callback, options });
      return {
        stop: () => {
          stopCount += 1;
        },
      };
    },
    every: (callback, ms) => {
      intervalCallback = callback;
      intervalMs = ms;
      return 1;
    },
    clear: () => {
      clearCount += 1;
    },
  });

  assert.equal(registrations.length, 3);
  for (const { options } of registrations) {
    assert.equal(options.timezone, 'Asia/Karachi');
    assert.equal(options.noOverlap, true);
  }
  assert.equal(intervalMs, 7 * 60_000);

  intervalCallback();
  intervalCallback();
  assert.equal(extractionCount, 1);
  finishExtraction();
  await new Promise((resolve) => setImmediate(resolve));
  intervalCallback();
  assert.equal(extractionCount, 2);
  finishExtraction();
  await stop();
  assert.equal(clearCount, 1);
  assert.equal(stopCount, 3);
});
