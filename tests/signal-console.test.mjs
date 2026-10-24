import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suppressSignalSessionLogs } from '../src/utils/signal-console.ts';

test('suppresses libsignal session objects while preserving other console messages', () => {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const seen = [];
  console.info = (...args) => seen.push(['info', ...args]);
  console.warn = (...args) => seen.push(['warn', ...args]);

  try {
    suppressSignalSessionLogs();
    const session = { secret: 'private key' };
    console.info('Closing session:', session);
    console.info('Opening session:', session);
    console.info('Removing old closed session:', session);
    console.warn('Session already closed', session);
    console.info('Connected', 'Maya');
    console.warn('Connection retry');
    assert.deepEqual(seen, [
      ['info', 'Connected', 'Maya'],
      ['warn', 'Connection retry'],
    ]);
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});
