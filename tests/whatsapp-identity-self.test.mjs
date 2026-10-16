import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'self';

const { clearOwnerIdentity, getOwnerChatJid, isOwnerChat, resolveOwnerIdentity, setOwnerIdentity } =
  await import('../src/channels/whatsapp/identity.ts');

test('self mode recognizes only the account PN and LID, including device JIDs', async () => {
  const identity = await resolveOwnerIdentity({
    user: { id: '111:2@s.whatsapp.net', lid: '222:3@lid' },
  });
  setOwnerIdentity(identity);

  assert.equal(getOwnerChatJid(), '111@s.whatsapp.net');
  assert.equal(isOwnerChat('111@s.whatsapp.net'), true);
  assert.equal(isOwnerChat('222@lid'), true);
  assert.equal(isOwnerChat('333@s.whatsapp.net', '222:4@lid'), true);
  assert.equal(isOwnerChat('333@s.whatsapp.net'), false);
  assert.equal(isOwnerChat('123@g.us'), false);

  clearOwnerIdentity();
  assert.equal(isOwnerChat('111@s.whatsapp.net'), false);
});

test('self mode fails closed without an account ID', async () => {
  setOwnerIdentity(await resolveOwnerIdentity({ user: undefined }));
  assert.equal(isOwnerChat('111@s.whatsapp.net'), false);
});
