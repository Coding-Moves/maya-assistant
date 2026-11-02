import { downloadMediaMessage, proto, type WAMessage, type WASocket } from 'baileys';
import { readAcademicMedia } from '../ai/gemini.js';
import { getConnectedSocket } from '../channels/whatsapp/connection.js';
import { unwrapMessageContent } from '../channels/whatsapp/parse.js';
import { config } from '../config/env.js';
import { db } from '../db/client.js';
import { completeMediaJob, enqueueMediaJob, failMediaJob, pendingMediaJobs, skipMediaJob } from '../db/repos/media.js';
import { logger } from '../utils/logger.js';
import { ingestGroupMessage } from './ingest.js';

const mediaLogger = logger.child({ module: 'baileys-media' }, { level: 'silent' });
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface MediaDetails {
  mimeType: string;
  caption: string | null;
  fileLength: number | null;
}

function mediaDetails(message: WAMessage): MediaDetails | null {
  const content = unwrapMessageContent(message.message);
  const image = content?.imageMessage;
  const document = content?.documentMessage;
  const documentType = document?.mimetype?.split(';', 1)[0]?.toLowerCase();
  const media = image ?? (documentType === 'application/pdf' ? document : null);
  if (!media) return null;
  const mimeType = media.mimetype?.split(';', 1)[0]?.toLowerCase() ?? '';
  if (image && !imageTypes.has(mimeType)) return null;
  if (!image && mimeType !== 'application/pdf') return null;
  const length = media.fileLength == null ? null : Number(media.fileLength.toString());
  return {
    mimeType,
    caption: media.caption?.trim() || null,
    fileLength: length !== null && Number.isSafeInteger(length) ? length : null,
  };
}

export function enqueueGroupMedia(message: WAMessage, chatName: string | null): boolean {
  if (!config.MEDIA_ENABLED) return false;
  const details = mediaDetails(message);
  if (!details) return false;
  if (details.fileLength !== null && details.fileLength > config.MEDIA_MAX_BYTES) {
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

type DownloadMedia = (message: WAMessage, socket: WASocket) => Promise<AsyncIterable<Buffer>>;
type RecognizeMedia = (bytes: Buffer, mimeType: string) => Promise<string>;

async function download(message: WAMessage, socket: WASocket): Promise<AsyncIterable<Buffer>> {
  return downloadMediaMessage(message, 'stream', {}, {
    logger: mediaLogger,
    reuploadRequest: socket.updateMediaMessage,
  });
}

export async function processPendingMedia(
  dependencies: {
    socket?: WASocket | null;
    download?: DownloadMedia;
    recognize?: RecognizeMedia;
  } = {},
): Promise<void> {
  if (!config.MEDIA_ENABLED) return;
  const socket = dependencies.socket ?? getConnectedSocket();
  if (!socket) return;
  const fetchMedia = dependencies.download ?? download;
  const recognize = dependencies.recognize ?? readAcademicMedia;

  for (const job of pendingMediaJobs(config.MEDIA_BATCH_SIZE)) {
    try {
      const message = proto.WebMessageInfo.decode(job.payload) as WAMessage;
      const stream = await fetchMedia(message, socket);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > config.MEDIA_MAX_BYTES) throw new Error('Media exceeds size limit');
        chunks.push(bytes);
      }
      if (size === 0) throw new Error('Media download was empty');
      const text = (await recognize(Buffer.concat(chunks), job.mimeType)).trim();
      if (text === 'NO_TEXT') {
        if (job.caption) completeMediaJob(job.messageId, job.caption);
        else skipMediaJob(job.messageId);
      } else {
        completeMediaJob(job.messageId, job.caption ? `${job.caption}\n\n${text}` : text);
      }
      logger.info({ messageId: job.messageId }, 'Group media read');
    } catch (error) {
      const quarantined = failMediaJob(job.messageId);
      logger.error(
        { messageId: job.messageId, quarantined, errorType: error instanceof Error ? error.name : 'unknown' },
        'Could not read group media',
      );
      logger.debug({ err: error }, 'Media reading failure details');
    }
  }
}
