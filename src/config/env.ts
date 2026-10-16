import 'dotenv/config';
import cron from 'node-cron';
import { z } from 'zod';

const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const cronExpression = (defaultValue: string) =>
  z.string().trim().refine(cron.validate, 'must be a valid cron expression').default(defaultValue);

const envSchema = z
  .object({
    BOT_NAME: z.string().trim().min(1).default('Maya'),
    BOT_MODE: z.enum(['self', 'separate']).default('self'),
    OWNER_JID: z
      .string()
      .trim()
      .default('')
      .transform((value) => value || undefined)
      .pipe(z.string().regex(/^\d+@s\.whatsapp\.net$/).optional()),
    GROUP_ALLOWLIST: z
      .string()
      .default('')
      .transform((value) => value.split(',').map((jid) => jid.trim()).filter(Boolean))
      .pipe(z.array(z.string().regex(/^[^@\s]+@g\.us$/))),
    TIMEZONE: z
      .string()
      .trim()
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'must be a valid IANA time zone')
      .default('Asia/Karachi'),
    MORNING_DIGEST_CRON: cronExpression('0 8 * * *'),
    EVENING_DIGEST_CRON: cronExpression('0 20 * * *'),
    WEEKLY_PLAN_CRON: cronExpression('0 20 * * 5'),
    EXTRACT_INTERVAL_MIN: positiveInteger(10),
    GEMINI_API_KEY: z
      .string({ error: 'is required; add it to .env' })
      .trim()
      .min(1, 'is required; add it to .env'),
    GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.5-flash'),
    EXTRACT_BATCH_SIZE: positiveInteger(50),
    ASK_CONTEXT_MESSAGES: positiveInteger(100),
    MAX_REPLIES_PER_HOUR: positiveInteger(20),
    DATABASE_PATH: z.string().trim().min(1).default('./data/maya.db'),
    AUTH_DIR: z.string().trim().min(1).default('./auth_info'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((value, context) => {
    if (value.BOT_MODE === 'separate' && !value.OWNER_JID) {
      context.addIssue({
        code: 'custom',
        path: ['OWNER_JID'],
        message: 'is required when BOT_MODE=separate',
      });
    }
  });

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid configuration: ${details}`);
}

export const config = result.data;
export type Config = typeof config;
