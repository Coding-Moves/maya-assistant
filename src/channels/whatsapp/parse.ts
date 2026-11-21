import type { WAMessageContent } from 'baileys';

type ContextInfo = NonNullable<NonNullable<WAMessageContent['extendedTextMessage']>['contextInfo']>;

export interface QuotedMessageReference {
  id: string;
  participant: string | null;
  remoteJid: string | null;
  text: string | null;
  kind: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'unknown';
}

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

function quotedContext(
  message: WAMessageContent | null | undefined,
): ContextInfo | undefined {
  const content = unwrapMessageContent(message);
  return content?.extendedTextMessage?.contextInfo ?? content?.imageMessage?.contextInfo ??
    content?.videoMessage?.contextInfo ?? content?.documentMessage?.contextInfo ?? content?.audioMessage?.contextInfo ?? undefined;
}

function quotedKind(message: WAMessageContent | null | undefined): QuotedMessageReference['kind'] {
  const content = unwrapMessageContent(message);
  if (content?.conversation || content?.extendedTextMessage?.text) return 'text';
  if (content?.imageMessage) return 'image';
  if (content?.videoMessage) return 'video';
  if (content?.audioMessage) return 'audio';
  if (content?.documentMessage) return 'document';
  if (content?.stickerMessage) return 'sticker';
  return 'unknown';
}

/** Exact quoted-message metadata supplied by WhatsApp, if the original is available. */
export function quotedMessageReference(
  message: WAMessageContent | null | undefined,
): QuotedMessageReference | null {
  const context = quotedContext(message);
  if (!context || typeof context.stanzaId !== 'string' || !context.stanzaId) return null;
  const quoted = context.quotedMessage as WAMessageContent | null | undefined;
  return {
    id: context.stanzaId,
    participant: typeof context.participant === 'string' ? context.participant : null,
    remoteJid: typeof context.remoteJid === 'string' ? context.remoteJid : null,
    text: parseMessageText(quoted),
    kind: quotedKind(quoted),
  };
}

/** The WhatsApp message id being quoted by an owner reply, if any. */
export function quotedMessageId(message: WAMessageContent | null | undefined): string | null {
  return quotedMessageReference(message)?.id ?? null;
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
