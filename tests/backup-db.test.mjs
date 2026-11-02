import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const tsx = import.meta.resolve('tsx');
const script = fileURLToPath(new URL('../scripts/backup-db.ts', import.meta.url));

test('online backup includes WAL data and keeps seven completed snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'maya-backup-test-'));
  const sourcePath = join(root, 'maya.db');
  const source = new Database(sourcePath);
  try {
    source.pragma('journal_mode = WAL');
    source.exec('CREATE TABLE notes (text TEXT NOT NULL)');
    const runBackup = (databasePath = sourcePath) =>
      spawnSync(process.execPath, ['--import', tsx, script], {
        cwd: root,
        env: {
          ...process.env,
          GEMINI_API_KEY: 'test',
          DATABASE_PATH: databasePath,
        },
        encoding: 'utf8',
      });

    for (let count = 1; count <= 8; count += 1) {
      source.prepare('INSERT INTO notes (text) VALUES (?)').run(`note ${count}`);
      const result = runBackup();
      assert.equal(result.status, 0, result.stderr);
    }

    const backupDir = join(root, 'data', 'backups');
    const backups = readdirSync(backupDir)
      .filter((name) => name.endsWith('.db'))
      .sort();
    assert.equal(backups.length, 7);
    const newest = new Database(join(backupDir, backups.at(-1)), {
      readonly: true,
    });
    try {
      assert.equal(newest.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 8);
    } finally {
      newest.close();
    }

    writeFileSync(join(backupDir, 'maya-incomplete.db.tmp'), 'partial');
    const missing = join(root, 'missing.db');
    const failed = runBackup(missing);
    assert.equal(failed.status, 1);
    assert.equal(existsSync(missing), false);
    assert.equal(readdirSync(backupDir).filter((name) => name.endsWith('.db')).length, 7);
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});
