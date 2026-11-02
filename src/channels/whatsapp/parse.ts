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
