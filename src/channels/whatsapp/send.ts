import type { WAMessageKey } from 'baileys';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getConnectedSocket } from './connection.js';
import { getOwnerChatJid, isOwnerChat } from './identity.js';

const sentAt: { at: number }[] = [];
const oneHourMs = 60 * 60 * 1000;
let activeAiReplies = 0;
let typingTimer: NodeJS.Timeout | null = null;
let presenceQueue = Promise.resolve();

function ownerPresence(type: 'composing' | 'paused'): Promise<void> {
  presenceQueue = presenceQueue.then(async () => {
    const sock = getConnectedSocket();
    const ownerJid = getOwnerChatJid();
    if (!sock || !ownerJid) return;
    try {
      await sock.sendPresenceUpdate(type, ownerJid);
    } catch (error) {
      logger.warn(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Could not update owner typing presence',
      );
    }
  }).catch((error: unknown) => {
    logger.warn(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Could not update owner typing presence',
    );
  });
  return presenceQueue;
}

export async function withOwnerTyping<T>(work: () => Promise<T>): Promise<T> {
  if (config.BOT_MODE !== 'separate') return work();

  activeAiReplies += 1;
  try {
    if (activeAiReplies === 1) {
      await ownerPresence('composing');
      typingTimer = setInterval(() => void ownerPresence('composing'), 8_000);
    }
    return await work();
  } finally {
    activeAiReplies -= 1;
    if (activeAiReplies === 0) {
      if (typingTimer) clearInterval(typingTimer);
      typingTimer = null;
      await ownerPresence('paused');
    }
  }
}

export async function markOwnerMessageRead(key: WAMessageKey): Promise<void> {
  if (
    config.BOT_MODE !== 'separate' ||
    key.fromMe !== false ||
    !key.id ||
    !key.remoteJid ||
    !isOwnerChat(key.remoteJid, key.remoteJidAlt)
  ) return;

  const sock = getConnectedSocket();
  if (!sock) return;
  try {
    await sock.readMessages([key]);
  } catch (error) {
    logger.warn(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Could not mark owner message as read',
    );
  }
}

export async function sendToOwner(text: string): Promise<boolean> {
  const sock = getConnectedSocket();
  const ownerJid = getOwnerChatJid();
  if (!sock || !ownerJid) {
    logger.warn(
      'Owner message skipped: connection or owner identity unavailable',
    );
    return false;
  }

  const now = Date.now();
  while (sentAt.length > 0 && sentAt[0]!.at <= now - oneHourMs) sentAt.shift();
  if (sentAt.length >= config.MAX_REPLIES_PER_HOUR) {
    logger.warn('Owner message dropped: hourly rate limit reached');
    return false;
  }

  const reservation = { at: now };
  sentAt.push(reservation);
  try {
    await sock.sendMessage(ownerJid, {
      text:
        config.BOT_MODE === 'self'
          ? `🤖 ${config.BOT_NAME}: ${text}`
          : text,
    });
    return true;
  } catch (error) {
    const index = sentAt.indexOf(reservation);
    if (index >= 0) sentAt.splice(index, 1);
    logger.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Could not send owner message',
    );
    logger.debug({ err: error }, 'Owner send failure details');
    return false;
  }
}
