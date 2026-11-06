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
// Group PDFs are capped more tightly than direct owner media to avoid sending books to Gemini.
const separateGroupPdfLimit = 2_000_000;

export class MediaTooLargeError extends Error {}
export class MediaTypeMismatchError extends Error {}

function validateMediaSignature(bytes: Buffer, mimeType: string): void {
  const matches = mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        : mimeType === 'application/pdf' ? bytes.toString('ascii', 0, 4) === '%PDF'
          : mimeType === 'audio/ogg' ? bytes.toString('ascii', 0, 4) === 'OggS'
            : mimeType === 'audio/opus' ? bytes.toString('ascii', 0, 4) === 'OggS' ||
              bytes.toString('ascii', 0, 8) === 'OpusHead'
            : mimeType === 'video/mp4' || mimeType === 'audio/mp4' ? bytes.toString('ascii', 4, 8) === 'ftyp'
              : true;
  if (!matches) throw new MediaTypeMismatchError('Downloaded media does not match its declared type');
}

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
  const mediaContent = unwrapMessageContent(message.message);
  const documentName = mediaContent?.documentMessage?.fileName ?? '';
  const duration = Number(mediaContent?.audioMessage?.seconds ?? mediaContent?.videoMessage?.seconds ?? 0);
  const groupLimit = config.BOT_MODE === 'separate' && details.mimeType === 'application/pdf'
    ? Math.min(getRuntimeSetting('MEDIA_MAX_BYTES') as number, separateGroupPdfLimit)
    : getRuntimeSetting('MEDIA_MAX_BYTES') as number;
  if ((details.fileLength !== null && details.fileLength > groupLimit) ||
    (config.BOT_MODE === 'separate' && Number.isFinite(duration) && duration > 180) ||
    (config.BOT_MODE === 'separate' && details.mimeType === 'application/pdf' &&
      /(?:textbook|course[\s_-]?book|e[\s_-]?book)/iu.test(documentName))) {
    if (details.caption) ingestGroupMessage(message, details.caption, chatName);
    logger.warn({ messageId: message.key.id }, 'Group media skipped: large or book-like document');
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
  maxBytes: number = getRuntimeSetting('MEDIA_MAX_BYTES') as number,
): Promise<Buffer> {
  const details = mediaDetails(message);
  if (!details) throw new Error('Unsupported media type');
  const limit = maxBytes;
  if (details.fileLength !== null && details.fileLength > limit)
    throw new MediaTooLargeError('Media exceeds size limit');
  const stream = await fetchMedia(message, socket);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new MediaTooLargeError('Media exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) throw new Error('Media download was empty');
  const bytes = Buffer.concat(chunks);
  if (config.BOT_MODE === 'separate') validateMediaSignature(bytes, details.mimeType);
  return bytes;
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
      const bytes = await readMediaBytes(message, socket, fetchMedia,
        config.BOT_MODE === 'separate' && job.mimeType === 'application/pdf'
          ? Math.min(getRuntimeSetting('MEDIA_MAX_BYTES') as number, separateGroupPdfLimit)
          : getRuntimeSetting('MEDIA_MAX_BYTES') as number);
      if (config.BOT_MODE === 'separate' && job.mimeType === 'application/pdf' &&
        (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length > 40)
        throw new MediaTooLargeError('Group PDF has too many pages');
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
      if (error instanceof MediaTooLargeError || error instanceof MediaTypeMismatchError) {
        if (job.caption) completeMediaJob(job.messageId, job.caption);
        else skipMediaJob(job.messageId);
        logger.warn({ messageId: job.messageId }, error instanceof MediaTooLargeError
          ? 'Group media skipped: streamed size limit exceeded' : 'Group media skipped: file type mismatch');
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
