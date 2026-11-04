import type { WAMessage, WASocket } from 'baileys';
import { understandOwnerMedia } from '../ai/gemini.js';
import { sendToOwner, withOwnerTyping } from '../channels/whatsapp/send.js';
import { isOwnerChat } from '../channels/whatsapp/identity.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { handleOwnerText } from './commands.js';
import { MediaTooLargeError, download, mediaDetails, readMediaBytes, type DownloadMedia } from './media.js';

export async function handleOwnerMedia(
  message: WAMessage,
  sock: WASocket,
  spokenOrDescribe: typeof understandOwnerMedia = understandOwnerMedia,
  handleText: typeof handleOwnerText = handleOwnerText,
  fetchMedia: DownloadMedia = download,
): Promise<void> {
  if (config.BOT_MODE !== 'separate' || message.key.fromMe !== false ||
      !isOwnerChat(message.key.remoteJid, message.key.remoteJidAlt)) return;
  if (!config.MEDIA_ENABLED) {
    await sendToOwner('I can see you sent a file, but media reading is switched off for me right now.');
    return;
  }
  const details = mediaDetails(message);
  if (!details) {
    await sendToOwner('I can read photos, voice notes, short videos, PDFs, and text files. I couldn’t read this file type yet.');
    return;
  }
  try {
    const description = await withOwnerTyping(async () => {
      const bytes = await readMediaBytes(message, sock, fetchMedia);
      return (await spokenOrDescribe(bytes, details.mimeType)).trim();
    });
    if (!description || description === 'NO_SPEECH' || description === 'NO_TEXT') {
      await sendToOwner('I couldn’t make out anything clear in that. Could you send it again or add a little text?');
      return;
    }
    const input = details.kind === 'audio'
      ? description
      : `${details.caption ? `${details.caption}\n\n` : 'What is in this media?\n\n'}Media content: ${description}`;
    await handleText(input);
  } catch (error) {
    logger.warn({ messageId: message.key.id, errorType: error instanceof Error ? error.name : 'unknown' }, 'Could not read owner media');
    logger.debug({ err: error }, 'Owner media failure details');
    await sendToOwner(error instanceof MediaTooLargeError
      ? `That file is too large for me to read right now. Please send one under ${Math.floor(config.MEDIA_MAX_BYTES / 1_000_000)} MB or tell me what to look for.`
      : 'I had trouble reading that file. Could you try sending it again?');
  }
}
