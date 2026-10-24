import { config } from '../../config/env.js';

const escapedName = config.BOT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const leadingTrigger = new RegExp(`^@?${escapedName}(?=$|[\\s,:])`, 'i');
const mentionTrigger = new RegExp(
  `(^|[^\\p{L}\\p{N}_])@${escapedName}(?=$|[^\\p{L}\\p{N}_])`,
  'iu',
);

export function ownerInput(
  text: string,
  fromMe: boolean | null | undefined,
): string | null {
  if (config.BOT_MODE === 'self' && fromMe !== true) return null;
  if (config.BOT_MODE === 'separate' && fromMe !== false) return null;
  const input = text.trim();
  const leading = leadingTrigger.exec(input);
  if (leading) {
    const remainder = input
      .slice(leading[0].length)
      .replace(/^[\s,:]+/, '')
      .trim();
    return remainder || (config.BOT_MODE === 'separate' ? input : '');
  }

  const mention = mentionTrigger.exec(input);
  if (!mention) return config.BOT_MODE === 'separate' ? input : null;
  const start = mention.index + mention[1].length;
  const before = input.slice(0, start).replace(/[\s,:([\]]+$/, '');
  const after = input
    .slice(start + 1 + config.BOT_NAME.length)
    .replace(/^[\s,:)[\]]+/, '')
    .trim();
  if (!before || !after)
    return before || after || (config.BOT_MODE === 'separate' ? input : '');
  return /^[!?.,;:]/.test(after) ? before + after : `${before} ${after}`;
}
