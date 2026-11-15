import { db } from '../client.js';

export type UniversitySource = 'nfc-cms' | 'vu-classic-todo';

export function universityCheckingPaused(source: UniversitySource): boolean {
  return Boolean(db.prepare<[UniversitySource], { checkingPaused: number }>(
    'SELECT checking_paused AS checkingPaused FROM source_controls WHERE source = ?',
  ).get(source)?.checkingPaused);
}

export function setUniversityCheckingPaused(source: UniversitySource, paused: boolean): void {
  db.prepare(`INSERT INTO source_controls (source, checking_paused, reminders_paused, updated_at)
    VALUES (?, ?, 0, ?) ON CONFLICT(source) DO UPDATE SET
    checking_paused = excluded.checking_paused, updated_at = excluded.updated_at`)
    .run(source, paused ? 1 : 0, new Date().toISOString());
}
