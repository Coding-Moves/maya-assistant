import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = '';
process.env.GEMINI_API_KEY_SECRET_OCID = 'ocid1.vaultsecret.oc1.ap-singapore-1.testgemini';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '999999999999@s.whatsapp.net';
process.env.CALENDAR_SYNC = 'true';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.GOOGLE_CLIENT_SECRET_SECRET_OCID = 'ocid1.vaultsecret.oc1.ap-singapore-1.testgoogleclient';
process.env.GOOGLE_REFRESH_TOKEN = '';
process.env.GOOGLE_REFRESH_TOKEN_SECRET_OCID = 'ocid1.vaultsecret.oc1.ap-singapore-1.testgooglerefresh';
process.env.VU_LMS_SYNC = 'true';
process.env.VU_STUDENT_ID = '';
process.env.VU_STUDENT_ID_SECRET_OCID = 'ocid1.vaultsecret.oc1.ap-singapore-1.testvuid';
process.env.VU_PASSWORD = '';
process.env.VU_PASSWORD_SECRET_OCID = 'ocid1.vaultsecret.oc1.ap-singapore-1.testvupassword';

const { configuredVaultSecrets, geminiApiKey, googleCalendarCredentials, resolveConfiguredSecret, vuCredentials } = await import('../src/security/runtime-secrets.ts');

const values = new Map([
  ['ocid1.vaultsecret.oc1.ap-singapore-1.testgemini', 'gemini-from-vault'],
  ['ocid1.vaultsecret.oc1.ap-singapore-1.testgoogleclient', 'google-client-secret'],
  ['ocid1.vaultsecret.oc1.ap-singapore-1.testgooglerefresh', 'google-refresh-token'],
  ['ocid1.vaultsecret.oc1.ap-singapore-1.testvuid', 'vu-student-id'],
  ['ocid1.vaultsecret.oc1.ap-singapore-1.testvupassword', 'vu-password'],
]);
const readSecret = async (id) => values.get(id) ?? Promise.reject(new Error(`unexpected secret ${id}`));

test('loads Gemini, VU and Calendar values from Vault references without inline values', async () => {
  assert.equal(await geminiApiKey(readSecret), 'gemini-from-vault');
  assert.deepEqual(await vuCredentials(readSecret), { studentId: 'vu-student-id', password: 'vu-password' });
  assert.deepEqual(await googleCalendarCredentials(readSecret), {
    clientSecret: 'google-client-secret', refreshToken: 'google-refresh-token',
  });
  assert.equal(configuredVaultSecrets().length, 5);
});

test('uses an inline development value only when no Vault reference is supplied', async () => {
  assert.equal(await resolveConfiguredSecret('TEST', 'local-only', '', readSecret), 'local-only');
  await assert.rejects(resolveConfiguredSecret('TEST', '', '', readSecret), /TEST is not configured/);
});
