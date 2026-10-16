import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getConnectedSocket } from './connection.js';
import { getOwnerChatJid } from './identity.js';

const sentAt: { at: number }[] = [];
const oneHourMs = 60 * 60 * 1000;

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
      text: `🤖 ${config.BOT_NAME}: ${text}`,
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
