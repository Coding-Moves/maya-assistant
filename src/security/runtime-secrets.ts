import { config } from '../config/env.js';
import { readOciVaultSecret } from './oci-vault.js';

export type SecretReader = (secretId: string) => Promise<string>;

export interface VuCredentials {
  studentId: string;
  password: string;
}

export interface GoogleCalendarCredentials {
  clientSecret: string;
  refreshToken: string;
}

/**
 * Resolves an inline development value or a production OCI Vault reference.
 * Values are returned to the caller only and never logged or persisted.
 */
export async function resolveConfiguredSecret(
  name: string,
  inlineValue: string,
  secretId: string,
  readSecret: SecretReader = readOciVaultSecret,
): Promise<string> {
  if (secretId) return readSecret(secretId);
  if (inlineValue) return inlineValue;
  throw new Error(`${name} is not configured`);
}

export async function geminiApiKey(readSecret?: SecretReader): Promise<string> {
  return resolveConfiguredSecret(
    'GEMINI_API_KEY', config.GEMINI_API_KEY, config.GEMINI_API_KEY_SECRET_OCID, readSecret,
  );
}

export async function vuCredentials(readSecret?: SecretReader): Promise<VuCredentials> {
  const [studentId, password] = await Promise.all([
    resolveConfiguredSecret('VU_STUDENT_ID', config.VU_STUDENT_ID, config.VU_STUDENT_ID_SECRET_OCID, readSecret),
    resolveConfiguredSecret('VU_PASSWORD', config.VU_PASSWORD, config.VU_PASSWORD_SECRET_OCID, readSecret),
  ]);
  return { studentId, password };
}

export async function googleCalendarCredentials(readSecret?: SecretReader): Promise<GoogleCalendarCredentials> {
  const [clientSecret, refreshToken] = await Promise.all([
    resolveConfiguredSecret(
      'GOOGLE_CLIENT_SECRET', config.GOOGLE_CLIENT_SECRET, config.GOOGLE_CLIENT_SECRET_SECRET_OCID, readSecret,
    ),
    resolveConfiguredSecret(
      'GOOGLE_REFRESH_TOKEN', config.GOOGLE_REFRESH_TOKEN, config.GOOGLE_REFRESH_TOKEN_SECRET_OCID, readSecret,
    ),
  ]);
  return { clientSecret, refreshToken };
}

export function configuredVaultSecrets(): { name: string; secretId: string }[] {
  const references: readonly [string, string][] = [
    ['GEMINI_API_KEY', config.GEMINI_API_KEY_SECRET_OCID],
    ['GOOGLE_CLIENT_SECRET', config.GOOGLE_CLIENT_SECRET_SECRET_OCID],
    ['GOOGLE_REFRESH_TOKEN', config.GOOGLE_REFRESH_TOKEN_SECRET_OCID],
    ['VU_STUDENT_ID', config.VU_STUDENT_ID_SECRET_OCID],
    ['VU_PASSWORD', config.VU_PASSWORD_SECRET_OCID],
    ['NFC_STUDENT_ID', config.NFC_STUDENT_ID_SECRET_OCID],
    ['NFC_PASSWORD', config.NFC_PASSWORD_SECRET_OCID],
  ];
  return references.flatMap(([name, secretId]) => secretId ? [{ name, secretId }] : []);
}
