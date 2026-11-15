import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '123@s.whatsapp.net';
process.env.DATABASE_PATH = ':memory:';
process.env.NFC_CMS_SYNC = 'true';
process.env.NFC_STUDENT_ID_SECRET_OCID = 'ocid1.vaultsecret.oc1.ap-singapore-1.teststudent';
process.env.NFC_PASSWORD_SECRET_OCID = 'ocid1.vaultsecret.oc1.ap-singapore-1.testpassword';
process.env.NFC_SYNC_CRON = '0 7 * * *';

const { startJobs } = await import('../src/scheduler/jobs.ts');

test('daily NFC check uses the timezone, does not overlap, and stops cleanly', async () => {
  const registrations = [];
  let runs = 0;
  let finish;
  const stop = startJobs({
    nfc: async () => {
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
  const nfc = registrations.find(({ options }) => options.name === 'maya-nfc-assignments');
  assert.equal(nfc.expression, '0 7 * * *');
  assert.equal(nfc.options.timezone, 'Asia/Karachi');
  assert.equal(nfc.options.noOverlap, true);
  nfc.callback();
  nfc.callback();
  assert.equal(runs, 1);
  finish({ created: 1, updated: 0, unchanged: 0, skipped: false });
  await stop();
});
