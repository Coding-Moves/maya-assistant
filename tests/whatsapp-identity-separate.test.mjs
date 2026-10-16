import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY = 'test';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '111@s.whatsapp.net';

const { clearOwnerIdentity, getOwnerChatJid, isOwnerChat, resolveOwnerIdentity, setOwnerIdentity } =
  await import('../src/channels/whatsapp/identity.ts');

test('separate mode recognizes the configured PN and resolved LID only', async () => {
  const identity = await resolveOwnerIdentity({
    signalRepository: {
      lidMapping: { getLIDForPN: async () => '222@lid' },
    },
  });
  setOwnerIdentity(identity);

  assert.equal(getOwnerChatJid(), '111@s.whatsapp.net');
  assert.equal(isOwnerChat('111:2@s.whatsapp.net'), true);
  assert.equal(isOwnerChat('222@lid'), true);
  assert.equal(isOwnerChat('333@lid', '111@s.whatsapp.net'), true);
  assert.equal(isOwnerChat('333@lid'), false);

  clearOwnerIdentity();
});

test('separate mode fails closed for an unmapped LID', async () => {
  const identity = await resolveOwnerIdentity({
    signalRepository: {
      lidMapping: { getLIDForPN: async () => null },
    },
  });
  setOwnerIdentity(identity);

  assert.equal(isOwnerChat('111@s.whatsapp.net'), true);
  assert.equal(isOwnerChat('222@lid'), false);
  clearOwnerIdentity();
});
