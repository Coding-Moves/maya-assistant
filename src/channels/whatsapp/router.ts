import { isJidBroadcast, isJidGroup, isJidStatusBroadcast, jidNormalizedUser, type BaileysEventMap, type GroupMetadata, type WAMessage, type WAMessageKey, type WASocket } from 'baileys';
import { config } from '../../config/env.js';
import { deactivateGroup, rememberGroup as storeGroup, replaceJoinedGroups } from '../../db/repos/groups.js';
import { ingestGroupMessage } from '../../features/ingest.js';
import { enqueueGroupMedia } from '../../features/media.js';
import { handleOwnerMedia } from '../../features/owner-media.js';
import { handleOwnerText } from '../../features/commands.js';
import { commentOnOwnerStatus } from '../../features/status.js';
import { logger } from '../../utils/logger.js';
import { isOwnerChat, verifyOwnerLid } from './identity.js';
import { parseMessageText, unwrapMessageContent } from './parse.js';
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
    if (group.id && (config.BOT_MODE === 'separate' || allowedGroups.has(group.id))) {
      if (group.subject) groupNames.set(group.id, group.subject);
      if (config.BOT_MODE === 'separate') storeGroup(group.id, group.subject ?? null);
    }
  };

  const onGroupsUpsert = (groups: GroupMetadata[]) =>
    groups.forEach(rememberGroup);
  const onGroupsUpdate = (groups: Partial<GroupMetadata>[]) =>
    groups.forEach(rememberGroup);
  const onParticipantsUpdate = ({ id, action, participants }: BaileysEventMap['group-participants.update']) => {
    if (config.BOT_MODE !== 'separate' || (action !== 'add' && action !== 'remove')) return;
    const ownJids = new Set([sock.user?.id, sock.user?.lid, sock.user?.phoneNumber]
      .filter((jid): jid is string => Boolean(jid)).map(jidNormalizedUser));
    if (!participants.some((participant) => [participant.id, participant.lid, participant.phoneNumber]
      .some((jid) => jid && ownJids.has(jidNormalizedUser(jid))))) return;
    if (action === 'remove') {
      groupNames.delete(id);
      deactivateGroup(id);
    } else {
      void sock.groupMetadata(id).then((group) => {
        if (active) rememberGroup(group);
      }).catch((error: unknown) => {
        logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Could not refresh newly joined group');
      });
    }
  };
  const onConnectionUpdate = ({
    connection,
  }: BaileysEventMap['connection.update']) => {
    if (connection !== 'open') return;
    void sock
      .groupFetchAllParticipating()
      .then((groups) => {
        if (!active) return;
        Object.values(groups).forEach(rememberGroup);
        if (config.BOT_MODE === 'separate') replaceJoinedGroups(Object.values(groups).map((group) => ({ id: group.id, name: group.subject ?? null })));
      })
      .catch((error: unknown) => {
        logger.warn(
          { errorType: error instanceof Error ? error.name : 'unknown' },
          'Could not load group names',
        );
      });
  };
  const handleOwnerMessage = (message: BaileysEventMap['messages.upsert']['messages'][number], text: string | null) => {
    const content = unwrapMessageContent(message.message);
    const hasMedia = config.BOT_MODE === 'separate' && Boolean(
      content?.imageMessage || content?.audioMessage || content?.videoMessage || content?.documentMessage || content?.stickerMessage,
    );
    const input = text ? ownerInput(text, message.key.fromMe) : null;
    if (!input && !hasMedia) return;
    void markOwnerMessageRead(message.key);
    const reply = (hasMedia
      ? handleOwnerMedia(message, sock)
      : input
        ? handleOwnerText(input, undefined, undefined, undefined, message.key.id ?? null,
          'owner_text', { jid: message.key.remoteJid, alternateJid: message.key.remoteJidAlt })
        : Promise.resolve()
    ).catch((error: unknown) => {
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

      if (isJidGroup(chatId) && (config.BOT_MODE === 'separate' || allowedGroups.has(chatId))) {
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
      } else if (isOwnerChat(chatId, message.key.remoteJidAlt)) {
        handleOwnerMessage(message, text);
      } else if (config.BOT_MODE === 'separate' && message.key.fromMe === false) {
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
  sock.ev.on('group-participants.update', onParticipantsUpdate);
  sock.ev.on('connection.update', onConnectionUpdate);
  sock.ev.on('messages.upsert', onMessages);

  return () => {
    active = false;
    sock.ev.off('groups.upsert', onGroupsUpsert);
    sock.ev.off('groups.update', onGroupsUpdate);
    sock.ev.off('group-participants.update', onParticipantsUpdate);
    sock.ev.off('connection.update', onConnectionUpdate);
    sock.ev.off('messages.upsert', onMessages);
  };
}
