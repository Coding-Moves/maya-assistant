import { config } from '../config/env.js';
import { db } from '../db/client.js';
import { universityCheckingPaused } from '../db/repos/source-controls.js';
import { readOciVaultSecret } from '../security/oci-vault.js';
import { upsertNfcAssignments } from '../sources/nfc/assignments.js';
import { fetchNfcAssignments, type NfcCredentials } from '../sources/nfc/lms.js';

export async function syncNfcAssignments(
  readSecret: typeof readOciVaultSecret = readOciVaultSecret,
  fetchAssignments: typeof fetchNfcAssignments = fetchNfcAssignments,
  apply: typeof upsertNfcAssignments = upsertNfcAssignments,
): Promise<{ created: number; updated: number; unchanged: number; skipped: boolean }> {
  if (universityCheckingPaused('nfc-cms')) return { created: 0, updated: 0, unchanged: 0, skipped: true };
  try {
    const credentials: NfcCredentials = {
      studentId: await readSecret(config.NFC_STUDENT_ID_SECRET_OCID),
      password: await readSecret(config.NFC_PASSWORD_SECRET_OCID),
    };
    const result = apply(await fetchAssignments(credentials));
    db.prepare(`INSERT INTO source_sync_state (source, last_success_at, last_failure_at) VALUES ('nfc-cms', ?, NULL)
      ON CONFLICT(source) DO UPDATE SET last_success_at = excluded.last_success_at, last_failure_at = NULL`).run(new Date().toISOString());
    return { ...result, skipped: false };
  } catch (error) {
    db.prepare(`INSERT INTO source_sync_state (source, last_failure_at) VALUES ('nfc-cms', ?)
      ON CONFLICT(source) DO UPDATE SET last_failure_at = excluded.last_failure_at`).run(new Date().toISOString());
    throw error;
  }
}
