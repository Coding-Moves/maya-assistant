import { downloadMediaMessage, proto, type WAMessage, type WASocket } from 'baileys';
import { readAcademicMedia } from '../ai/gemini.js';
import { getConnectedSocket } from '../channels/whatsapp/connection.js';
import { unwrapMessageContent } from '../channels/whatsapp/parse.js';
import { config } from '../config/env.js';
import { getRuntimeSetting } from '../config/runtime.js';
import { db } from '../db/client.js';
import { isGroupEnabled } from '../db/repos/group-policies.js';
import { completeMediaJob, enqueueMediaJob, failMediaJob, pendingMediaJobs, skipMediaJob } from '../db/repos/media.js';
import { logger } from '../utils/logger.js';
import { ingestGroupMessage } from './ingest.js';

const mediaLogger = logger.child({ module: 'baileys-media' }, { level: 'silent' });
const supportedTypes = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/mp4', 'audio/webm',
  'video/mp4', 'video/webm', 'video/3gpp', 'video/mpeg', 'video/mov',
  'application/pdf', 'text/plain', 'text/csv',
]);
const selfModeGroupTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export class MediaTooLargeError extends Error {}

export interface MediaDetails {
  mimeType: string;
  caption: string | null;
  fileLength: number | null;
  kind: 'audio' | 'other';
}

export function mediaDetails(message: WAMessage): MediaDetails | null {
  const content = unwrapMessageContent(message.message);
  const image = content?.imageMessage;
  const document = content?.documentMessage;
  const audio = content?.audioMessage;
  const video = content?.videoMessage;
  const sticker = content?.stickerMessage;
  const media = image ?? audio ?? video ?? document ?? sticker;
  if (!media) return null;
  const mimeType = media.mimetype?.split(';', 1)[0]?.toLowerCase() ?? (sticker ? 'image/webp' : '');
  if (!supportedTypes.has(mimeType)) return null;
  const length = media.fileLength == null ? null : Number(media.fileLength.toString());
  return {
    mimeType,
    caption: (image?.caption ?? video?.caption ?? document?.caption)?.trim() || null,
    fileLength: length !== null && Number.isSafeInteger(length) ? length : null,
    kind: audio ? 'audio' : 'other',
  };
}

export function enqueueGroupMedia(message: WAMessage, chatName: string | null): boolean {
  if (!getRuntimeSetting('MEDIA_ENABLED')) return false;
  const chatId = message.key.remoteJid;
  if (!chatId || !isGroupEnabled(chatId, 'ingest') || !isGroupEnabled(chatId, 'media')) return false;
  const details = mediaDetails(message);
  if (!details) return false;
  if (config.BOT_MODE === 'self') {
    const content = unwrapMessageContent(message.message);
    const originalMedia = Boolean(content?.imageMessage && selfModeGroupTypes.has(details.mimeType)) ||
      Boolean(content?.documentMessage && details.mimeType === 'application/pdf');
    if (!originalMedia) return false;
  }
  if (details.fileLength !== null && details.fileLength > getRuntimeSetting('MEDIA_MAX_BYTES')) {
    if (details.caption) ingestGroupMessage(message, details.caption, chatName);
    logger.warn({ messageId: message.key.id }, 'Group media skipped: size limit exceeded');
    return true;
  }

  db.transaction(() => {
    const id = ingestGroupMessage(message, details.caption ?? '[Media awaiting reading]', chatName);
    if (id === null) return;
    const payload = Buffer.from(proto.WebMessageInfo.encode(message).finish());
    enqueueMediaJob(id, payload, details.mimeType, details.caption);
  })();
  return true;
}

export type DownloadMedia = (message: WAMessage, socket: WASocket) => Promise<AsyncIterable<Buffer>>;
type RecognizeMedia = (bytes: Buffer, mimeType: string) => Promise<string>;

export async function download(message: WAMessage, socket: WASocket): Promise<AsyncIterable<Buffer>> {
  return downloadMediaMessage(message, 'stream', {}, {
    logger: mediaLogger,
    reuploadRequest: socket.updateMediaMessage,
  });
}

export async function readMediaBytes(
  message: WAMessage,
  socket: WASocket,
  fetchMedia: DownloadMedia = download,
): Promise<Buffer> {
  const details = mediaDetails(message);
  if (!details) throw new Error('Unsupported media type');
  const limit = getRuntimeSetting('MEDIA_MAX_BYTES') as number;
  if (details.fileLength !== null && details.fileLength > limit)
    throw new MediaTooLargeError('Media exceeds size limit');
  const stream = await fetchMedia(message, socket);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new MediaTooLargeError('Media exceeds size limit');
    chunks.push(bytes);
  }
  if (size === 0) throw new Error('Media download was empty');
  return Buffer.concat(chunks);
}

export async function processPendingMedia(
  dependencies: {
    socket?: WASocket | null;
    download?: DownloadMedia;
    recognize?: RecognizeMedia;
  } = {},
): Promise<void> {
  if (!getRuntimeSetting('MEDIA_ENABLED')) return;
  const socket = dependencies.socket ?? getConnectedSocket();
  if (!socket) return;
  const fetchMedia = dependencies.download ?? download;
  const recognize = dependencies.recognize ?? readAcademicMedia;

  for (const job of pendingMediaJobs(getRuntimeSetting('MEDIA_BATCH_SIZE') as number)) {
    try {
      const message = proto.WebMessageInfo.decode(job.payload) as WAMessage;
      const bytes = await readMediaBytes(message, socket, fetchMedia);
      const text = (job.mimeType.startsWith('text/')
        ? bytes.toString('utf8')
        : await recognize(bytes, job.mimeType)).trim();
      if (text === 'NO_TEXT') {
        if (job.caption) completeMediaJob(job.messageId, job.caption);
        else skipMediaJob(job.messageId);
      } else {
        completeMediaJob(job.messageId, job.caption ? `${job.caption}\n\n${text}` : text);
      }
      logger.info({ messageId: job.messageId }, 'Group media read');
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        if (job.caption) completeMediaJob(job.messageId, job.caption);
        else skipMediaJob(job.messageId);
        logger.warn({ messageId: job.messageId }, 'Group media skipped: streamed size limit exceeded');
        continue;
      }
      const quarantined = failMediaJob(job.messageId);
      logger.error(
        { messageId: job.messageId, quarantined, errorType: error instanceof Error ? error.name : 'unknown' },
        'Could not read group media',
      );
      logger.debug({ err: error }, 'Media reading failure details');
    }
  }
}
