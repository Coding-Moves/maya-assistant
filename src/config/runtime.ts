import { z } from 'zod';
import { db } from '../db/client.js';
import { config } from './env.js';

const settingSchemas = {
  MEDIA_ENABLED: z.boolean(),
  MEDIA_MAX_BYTES: z.number().int().min(1_000_000).max(10_000_000),
  MEDIA_BATCH_SIZE: z.number().int().min(1).max(3),
  EXTRACT_BATCH_SIZE: z.number().int().min(1).max(50),
} as const;

export type RuntimeSettingKey = keyof typeof settingSchemas;
export type RuntimeSettingValue = boolean | number;
export const runtimeSettingKeys = Object.keys(settingSchemas) as RuntimeSettingKey[];

function schemaFor(key: RuntimeSettingKey): z.ZodType<RuntimeSettingValue> {
  return settingSchemas[key];
}

export function getRuntimeSetting(key: RuntimeSettingKey): RuntimeSettingValue {
  if (config.BOT_MODE !== 'separate') return config[key];
  const row = db.prepare<[string], { value_json: string }>(
    'SELECT value_json FROM runtime_settings WHERE key = ?',
  ).get(key);
  return row ? schemaFor(key).parse(JSON.parse(row.value_json)) : config[key];
}

export function listRuntimeSettings(): { key: RuntimeSettingKey; value: RuntimeSettingValue; defaultValue: RuntimeSettingValue; overridden: boolean }[] {
  const overrides = new Map(db.prepare<[], { key: RuntimeSettingKey; value_json: string }>(
    'SELECT key, value_json FROM runtime_settings',
  ).all().map((row) => [row.key, row.value_json]));
  return runtimeSettingKeys.map((key) => ({
    key,
    value: config.BOT_MODE === 'separate' && overrides.has(key)
      ? schemaFor(key).parse(JSON.parse(overrides.get(key)!)) : config[key],
    defaultValue: config[key],
    overridden: config.BOT_MODE === 'separate' && overrides.has(key),
  }));
}

export function setRuntimeSetting(key: RuntimeSettingKey, value: unknown): RuntimeSettingValue {
  if (config.BOT_MODE !== 'separate') throw new Error('Runtime controls are available in separate mode only');
  const parsed = schemaFor(key).parse(value);
  db.prepare(`INSERT INTO runtime_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(parsed), new Date().toISOString());
  return parsed;
}

export function resetRuntimeSetting(key: RuntimeSettingKey): RuntimeSettingValue {
  if (config.BOT_MODE !== 'separate') throw new Error('Runtime controls are available in separate mode only');
  db.prepare('DELETE FROM runtime_settings WHERE key = ?').run(key);
  return config[key];
}
