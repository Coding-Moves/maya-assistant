import { config } from '../../config/env.js';

const escapedName = config.BOT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trigger = new RegExp(`^@?${escapedName}(?=[ ,:])`, 'i');

export function ownerInput(
  text: string,
  fromMe: boolean | null | undefined,
): string | null {
  if (config.BOT_MODE === 'separate') return fromMe ? null : text.trim();
  if (fromMe !== true) return null;
  const match = trigger.exec(text.trimStart());
  return match
    ? text
        .trimStart()
        .slice(match[0].length)
        .replace(/^[ ,:]+/, '')
        .trim()
    : null;
}
