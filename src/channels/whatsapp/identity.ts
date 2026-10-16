import { isLidUser, isPnUser, jidNormalizedUser, type WASocket } from 'baileys';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

interface OwnerIdentity {
  chatJid: string;
  knownJids: Set<string>;
}

let ownerIdentity: OwnerIdentity | null = null;

function normalizedUserJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const normalized = jidNormalizedUser(jid);
  return isPnUser(normalized) || isLidUser(normalized) ? normalized : null;
}

export function clearOwnerIdentity(): void {
  ownerIdentity = null;
}

export async function resolveOwnerIdentity(sock: WASocket): Promise<OwnerIdentity | null> {
  if (config.BOT_MODE === 'self') {
    const knownJids = new Set(
      [sock.user?.id, sock.user?.lid, sock.user?.phoneNumber]
        .map(normalizedUserJid)
        .filter((jid): jid is string => jid !== null),
    );
    const chatJid = normalizedUserJid(sock.user?.id);
    return chatJid ? { chatJid, knownJids } : null;
  }

  const chatJid = normalizedUserJid(config.OWNER_JID);
  if (!chatJid || !isPnUser(chatJid)) return null;

  const knownJids = new Set([chatJid]);
  try {
    const lid = normalizedUserJid(await sock.signalRepository.lidMapping.getLIDForPN(chatJid));
    if (lid && isLidUser(lid)) knownJids.add(lid);
  } catch (error) {
    logger.warn({ err: error }, 'Could not resolve owner LID; only the configured phone JID will match');
  }
  return { chatJid, knownJids };
}

export function setOwnerIdentity(identity: OwnerIdentity | null): void {
  ownerIdentity = identity;
}

export function isOwnerChat(jid: string | null | undefined, alternateJid?: string | null): boolean {
  if (!ownerIdentity) return false;
  return [jid, alternateJid].some((candidate) => {
    const normalized = normalizedUserJid(candidate);
    return normalized !== null && ownerIdentity?.knownJids.has(normalized) === true;
  });
}

export function getOwnerChatJid(): string | null {
  return ownerIdentity?.chatJid ?? null;
}
