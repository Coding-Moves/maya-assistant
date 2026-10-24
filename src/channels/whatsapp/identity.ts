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

export function configuredOwnerIdentity(): OwnerIdentity | null {
  if (config.BOT_MODE !== 'separate') return null;
  const chatJid = normalizedUserJid(config.OWNER_JID);
  return chatJid && isPnUser(chatJid)
    ? { chatJid, knownJids: new Set([chatJid]) }
    : null;
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

  const identity = configuredOwnerIdentity();
  if (!identity) return null;
  try {
    const lid = normalizedUserJid(await sock.signalRepository.lidMapping.getLIDForPN(identity.chatJid));
    if (lid && isLidUser(lid)) identity.knownJids.add(lid);
  } catch (error) {
    logger.warn({ err: error }, 'Could not resolve owner LID; only the configured phone JID will match');
  }
  return identity;
}

export function setOwnerIdentity(identity: OwnerIdentity | null): void {
  if (identity && ownerIdentity?.chatJid === identity.chatJid) {
    for (const jid of ownerIdentity.knownJids) identity.knownJids.add(jid);
  }
  ownerIdentity = identity;
}

export async function verifyOwnerLid(sock: WASocket, jid: string): Promise<boolean> {
  if (isOwnerChat(jid)) return true;
  if (config.BOT_MODE !== 'separate' || !ownerIdentity) return false;
  const lid = normalizedUserJid(jid);
  if (!lid || !isLidUser(lid)) return false;
  try {
    const pn = normalizedUserJid(await sock.signalRepository.lidMapping.getPNForLID(lid));
    if (pn !== ownerIdentity.chatJid) return false;
    ownerIdentity.knownJids.add(lid);
    return true;
  } catch (error) {
    logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Could not verify incoming owner LID');
    return false;
  }
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
