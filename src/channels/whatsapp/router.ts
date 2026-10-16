import type { BaileysEventMap, GroupMetadata, WASocket } from 'baileys';
import { config } from '../../config/env.js';
import { ingestGroupMessage } from '../../features/ingest.js';
import { handleOwnerText } from '../../features/commands.js';
import { logger } from '../../utils/logger.js';
import { isOwnerChat } from './identity.js';
import { parseMessageText } from './parse.js';
import { ownerInput } from './trigger.js';

const allowedGroups = new Set(config.GROUP_ALLOWLIST);
const botPrefix = `🤖 ${config.BOT_NAME}:`;

export function attachWhatsAppRouter(sock: WASocket): () => void {
  const groupNames = new Map<string, string>();
  const rememberGroup = (group: Partial<GroupMetadata>) => {
    if (group.id && allowedGroups.has(group.id) && group.subject) {
      groupNames.set(group.id, group.subject);
    }
  };

  const onGroupsUpsert = (groups: GroupMetadata[]) =>
    groups.forEach(rememberGroup);
  const onGroupsUpdate = (groups: Partial<GroupMetadata>[]) =>
    groups.forEach(rememberGroup);
  const onConnectionUpdate = ({
    connection,
  }: BaileysEventMap['connection.update']) => {
    if (connection !== 'open') return;
    void sock
      .groupFetchAllParticipating()
      .then((groups) => {
        Object.values(groups).forEach(rememberGroup);
      })
      .catch((error: unknown) => {
        logger.warn(
          { errorType: error instanceof Error ? error.name : 'unknown' },
          'Could not load group names',
        );
      });
  };
  const onMessages = ({
    messages,
    type,
  }: BaileysEventMap['messages.upsert']) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      const chatId = message.key.remoteJid;
      if (!chatId) continue;
      const text = parseMessageText(message.message);
      if (!text || text.startsWith(botPrefix)) continue;

      if (allowedGroups.has(chatId)) {
        try {
          const id = ingestGroupMessage(
            message,
            text,
            groupNames.get(chatId) ?? null,
          );
          if (id !== null)
            logger.debug(
              { chatId, messageId: message.key.id },
              'Stored group message',
            );
        } catch (error) {
          logger.error(
            {
              chatId,
              messageId: message.key.id,
              errorType: error instanceof Error ? error.name : 'unknown',
            },
            'Could not store group message',
          );
          logger.debug({ err: error }, 'Group message ingest failure details');
        }
      } else if (isOwnerChat(chatId, message.key.remoteJidAlt)) {
        const input = ownerInput(text, message.key.fromMe);
        if (input)
          void handleOwnerText(input).catch((error: unknown) => {
            logger.error(
              { errorType: error instanceof Error ? error.name : 'unknown' },
              'Could not handle owner message',
            );
            logger.debug({ err: error }, 'Owner command failure details');
          });
      }
    }
  };

  sock.ev.on('groups.upsert', onGroupsUpsert);
  sock.ev.on('groups.update', onGroupsUpdate);
  sock.ev.on('connection.update', onConnectionUpdate);
  sock.ev.on('messages.upsert', onMessages);

  return () => {
    sock.ev.off('groups.upsert', onGroupsUpsert);
    sock.ev.off('groups.update', onGroupsUpdate);
    sock.ev.off('connection.update', onConnectionUpdate);
    sock.ev.off('messages.upsert', onMessages);
  };
}
