import type { WAMessageContent } from 'baileys';

export function unwrapMessageContent(
  message: WAMessageContent | null | undefined,
): WAMessageContent | null {
  let content = message;
  for (let depth = 0; content && depth < 8; depth += 1) {
    const wrapped =
      content.ephemeralMessage?.message ??
      content.viewOnceMessage?.message ??
      content.viewOnceMessageV2?.message ??
      content.viewOnceMessageV2Extension?.message ??
      content.documentWithCaptionMessage?.message;
    if (!wrapped) break;
    content = wrapped;
  }

  return content ?? null;
}

/** The WhatsApp message id being quoted by an owner reply, if any. */
export function quotedMessageId(
  message: WAMessageContent | null | undefined,
): string | null {
  const content = unwrapMessageContent(message);
  const context = content?.extendedTextMessage?.contextInfo ?? content?.imageMessage?.contextInfo ??
    content?.videoMessage?.contextInfo ?? content?.documentMessage?.contextInfo ?? content?.audioMessage?.contextInfo;
  return typeof context?.stanzaId === 'string' && context.stanzaId ? context.stanzaId : null;
}

export function parseMessageText(
  message: WAMessageContent | null | undefined,
): string | null {
  const content = unwrapMessageContent(message);
  if (!content) return null;
  const candidates = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.imageMessage?.caption,
    content.documentMessage?.caption,
    content.videoMessage?.caption,
  ];
  return (
    candidates.find(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    ) ?? null
  );
}
