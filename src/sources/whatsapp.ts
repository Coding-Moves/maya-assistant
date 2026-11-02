import { connectToWhatsApp, pauseWhatsApp, stopWhatsApp } from '../channels/whatsapp/connection.js';
import { insertMessage, type NewMessage } from '../db/repos/messages.js';
import { normalizeGroupMessage } from '../features/ingest.js';
import type { Source } from './source.js';

/** The router normalizes allowlisted group messages into the messages repository. */
export const whatsAppSource: Source<NewMessage> & { pause(): void } = {
  start: (emit) => connectToWhatsApp((message, text, chatName) => {
    const normalized = normalizeGroupMessage(message, text, chatName);
    if (normalized) emit(normalized);
  }),
  pause: pauseWhatsApp,
  stop: stopWhatsApp,
};

export function startWhatsAppSource(): Promise<void> {
  return whatsAppSource.start((message) => { insertMessage(message); });
}
