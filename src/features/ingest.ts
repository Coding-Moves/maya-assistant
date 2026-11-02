import type { WAMessage } from 'baileys';
import { config } from '../config/env.js';
import { insertMessage, type NewMessage } from '../db/repos/messages.js';

const allowedGroups = new Set(config.GROUP_ALLOWLIST);

export function normalizeGroupMessage(
  message: WAMessage,
  text: string,
  chatName: string | null,
): NewMessage | null {
  const chatId = message.key.remoteJid;
  const externalId = message.key.id;
  const timestamp = message.messageTimestamp;
  if (!chatId || !allowedGroups.has(chatId) || !externalId || timestamp == null)
    return null;

  const seconds =
    typeof timestamp === 'number' ? timestamp : Number(timestamp.toString());
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const sentAt = new Date(seconds * 1000);
  if (Number.isNaN(sentAt.getTime())) return null;

  return {
    source: 'whatsapp',
    externalId,
    chatId,
    chatName,
    senderName: message.pushName?.trim() || null,
    text,
    sentAt: sentAt.toISOString(),
  };
}

export function ingestGroupMessage(message: WAMessage, text: string, chatName: string | null): number | null {
  const normalized = normalizeGroupMessage(message, text, chatName);
  return normalized ? insertMessage(normalized) : null;
}
