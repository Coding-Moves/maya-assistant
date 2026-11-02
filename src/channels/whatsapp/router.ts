import { isJidBroadcast, isJidStatusBroadcast, type BaileysEventMap, type GroupMetadata, type WAMessage, type WAMessageKey, type WASocket } from 'baileys';
import { config } from '../../config/env.js';
import { ingestGroupMessage } from '../../features/ingest.js';
import { enqueueGroupMedia } from '../../features/media.js';
import { handleOwnerText } from '../../features/commands.js';
import { commentOnOwnerStatus } from '../../features/status.js';
import { logger } from '../../utils/logger.js';
import { isOwnerChat, verifyOwnerLid } from './identity.js';
import { parseMessageText } from './parse.js';
import { markOwnerMessageRead, markOwnerStatusRead } from './send.js';
import { ownerInput } from './trigger.js';

const allowedGroups = new Set(config.GROUP_ALLOWLIST);
const botPrefix = `🤖 ${config.BOT_NAME}:`;
const pendingOwnerReplies = new Set<Promise<void>>();

export async function waitForOwnerReplies(): Promise<void> {
  await Promise.allSettled(pendingOwnerReplies);
}

export type GroupTextHandler = (message: WAMessage, text: string, chatName: string | null) => void;

export function attachWhatsAppRouter(
  sock: WASocket,
  onGroupText: GroupTextHandler = ingestGroupMessage,
  viewOwnerStatus: (key: WAMessageKey) => Promise<void> = markOwnerStatusRead,
  replyToOwnerStatus: (message: WAMessage, sock: WASocket) => Promise<void> = commentOnOwnerStatus,
): () => void {
  let active = true;
  const handledStatusIds = new Set<string>();
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
  const handleOwnerMessage = (message: BaileysEventMap['messages.upsert']['messages'][number], text: string) => {
    const input = ownerInput(text, message.key.fromMe);
    if (!input) return;
    void markOwnerMessageRead(message.key);
    const reply = handleOwnerText(input).catch((error: unknown) => {
      logger.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Could not handle owner message',
      );
      logger.debug({ err: error }, 'Owner command failure details');
    });
    pendingOwnerReplies.add(reply);
    void reply.finally(() => pendingOwnerReplies.delete(reply));
  };
  const handleStatus = (message: WAMessage) => {
    const key = message.key;
    if (!key.id || !key.participant) return;
    const statusId = `${key.participant}:${key.id}`;
    if (handledStatusIds.has(statusId)) return;
    handledStatusIds.add(statusId);
    if (handledStatusIds.size > 1_000) handledStatusIds.delete(handledStatusIds.values().next().value!);
    const reply = (async () => {
      await viewOwnerStatus(key);
      if (active) await replyToOwnerStatus(message, sock);
    })().catch((error: unknown) => {
      logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Could not handle owner Status');
      logger.debug({ err: error }, 'Owner Status failure details');
    });
    pendingOwnerReplies.add(reply);
    void reply.finally(() => pendingOwnerReplies.delete(reply));
  };
  const onMessages = ({
    messages,
    type,
  }: BaileysEventMap['messages.upsert']) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      const chatId = message.key.remoteJid;
      if (!chatId) continue;
      if (isJidStatusBroadcast(chatId)) {
        const author = message.key.participant;
        if (config.BOT_MODE === 'separate' && message.key.fromMe === false && author) {
          if (isOwnerChat(author)) {
            handleStatus(message);
          } else {
            void verifyOwnerLid(sock, author).then((verified) => {
              if (active && verified) handleStatus(message);
            }).catch((error: unknown) => {
              logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Could not verify Status author');
            });
          }
        }
        continue;
      }
      // Other broadcasts and Status-shaped messages are never direct chats.
      if (message.broadcast === true || isJidBroadcast(chatId)) continue;
      const text = parseMessageText(message.message);
      if (config.BOT_MODE === 'separate' && message.key.fromMe === true)
        continue;
      if (config.BOT_MODE === 'self' && text?.startsWith(botPrefix)) continue;

      if (allowedGroups.has(chatId)) {
        try {
          if (enqueueGroupMedia(message, groupNames.get(chatId) ?? null)) continue;
          if (!text) continue;
          onGroupText(
            message,
            text,
            groupNames.get(chatId) ?? null,
          );
          logger.debug({ chatId, messageId: message.key.id }, 'Received group message');
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
      } else if (text && isOwnerChat(chatId, message.key.remoteJidAlt)) {
        handleOwnerMessage(message, text);
      } else if (text && config.BOT_MODE === 'separate' && message.key.fromMe === false) {
        void verifyOwnerLid(sock, chatId).then((verified) => {
          if (active && verified) handleOwnerMessage(message, text);
        }).catch((error: unknown) => {
          logger.warn(
            { errorType: error instanceof Error ? error.name : 'unknown' },
            'Could not verify incoming owner chat',
          );
        });
      }
    }
  };

  sock.ev.on('groups.upsert', onGroupsUpsert);
  sock.ev.on('groups.update', onGroupsUpdate);
  sock.ev.on('connection.update', onConnectionUpdate);
  sock.ev.on('messages.upsert', onMessages);

  return () => {
    active = false;
    sock.ev.off('groups.upsert', onGroupsUpsert);
    sock.ev.off('groups.update', onGroupsUpdate);
    sock.ev.off('connection.update', onConnectionUpdate);
    sock.ev.off('messages.upsert', onMessages);
  };
}
