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

  assert.equal(registrations.length, 4);
  for (const { options } of registrations) {
    assert.equal(options.timezone, 'Asia/Karachi');
    assert.equal(options.noOverlap, true);
  }
  assert.equal(intervalMs, 7 * 60_000);

  intervalCallback();
  intervalCallback();
  await Promise.resolve();
  assert.equal(extractionCount, 1);
  finishExtraction();
  await new Promise((resolve) => setImmediate(resolve));
  intervalCallback();
  await Promise.resolve();
  assert.equal(extractionCount, 2);
  finishExtraction();
  await stop();
  assert.equal(clearCount, 1);
  assert.equal(stopCount, 4);
});

test('shutdown waits for active extraction and rejects new ticks', async () => {
  let intervalCallback;
  let finishExtraction;
  let extractionCount = 0;
  const stop = startJobs({
    extract: async () => {
      extractionCount += 1;
      await new Promise((resolve) => {
        finishExtraction = resolve;
      });
    },
    schedule: () => ({ stop: () => undefined }),
    every: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clear: () => undefined,
  });

  intervalCallback();
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stopped, false);
  intervalCallback();
  assert.equal(extractionCount, 1);
  finishExtraction();
  await stopping;
  assert.equal(stopped, true);
});

test('media text is ready before the extraction run starts', async () => {
  let intervalCallback;
  let finishMedia;
  const order = [];
  const stop = startJobs({
    media: async () => {
      order.push('media start');
      await new Promise((resolve) => { finishMedia = resolve; });
      order.push('media done');
    },
    extract: async () => { order.push('extract'); },
    schedule: () => ({ stop: () => undefined }),
    every: (callback) => { intervalCallback = callback; return 1; },
    clear: () => undefined,
  });
  intervalCallback();
  assert.deepEqual(order, ['media start']);
  finishMedia();
  await stop();
  assert.deepEqual(order, ['media start', 'media done', 'extract']);
});
