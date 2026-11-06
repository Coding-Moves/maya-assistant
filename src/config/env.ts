import 'dotenv/config';
import cron from 'node-cron';
import { z } from 'zod';

const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const booleanFlag = (defaultValue: 'true' | 'false') =>
  z.enum(['true', 'false']).default(defaultValue).transform((value) => value === 'true');

const cronExpression = (defaultValue: string) =>
  z.string().trim().refine(cron.validate, 'must be a valid cron expression').default(defaultValue);

const envSchema = z
  .object({
    BOT_NAME: z.string().trim().min(1).default('Maya'),
    OWNER_NAME: z.string().trim().default(''),
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
    VU_SYNC_CRON: cronExpression('0 6 * * *'),
    EXTRACT_INTERVAL_MIN: positiveInteger(10),
    GEMINI_API_KEY: z
      .string({ error: 'is required; add it to .env' })
      .trim()
      .min(1, 'is required; add it to .env'),
    GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.5-flash'),
    EXTRACT_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(50),
    ASK_CONTEXT_MESSAGES: positiveInteger(100),
    MEDIA_ENABLED: booleanFlag('false'),
    MEDIA_MAX_BYTES: z.coerce.number().int().min(1).max(10_000_000).default(5_000_000),
    MEDIA_BATCH_SIZE: z.coerce.number().int().min(1).max(3).default(3),
    CALENDAR_SYNC: booleanFlag('false'),
    GOOGLE_CLIENT_ID: z.string().trim().default(''),
    GOOGLE_CLIENT_SECRET: z.string().trim().default(''),
    GOOGLE_REFRESH_TOKEN: z.string().trim().default(''),
    GOOGLE_CALENDAR_ID: z.string().trim().min(1).default('primary'),
    VU_LMS_SYNC: booleanFlag('false'),
    VU_STUDENT_ID: z.string().trim().default(''),
    VU_PASSWORD: z.string().default(''),
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
    if (value.CALENDAR_SYNC && (!value.GOOGLE_CLIENT_ID || !value.GOOGLE_CLIENT_SECRET || !value.GOOGLE_REFRESH_TOKEN)) {
      context.addIssue({ code: 'custom', path: ['CALENDAR_SYNC'], message: 'requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN' });
    }
    if (value.VU_LMS_SYNC && (!value.VU_STUDENT_ID || !value.VU_PASSWORD)) {
      context.addIssue({ code: 'custom', path: ['VU_LMS_SYNC'], message: 'requires VU_STUDENT_ID and VU_PASSWORD' });
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
