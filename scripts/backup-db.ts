import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config/env.js';

const backupDir = resolve('data/backups');
const backupName = `maya-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
const destination = join(backupDir, backupName);
const temporary = `${destination}.${process.pid}.tmp`;
const completedBackup = /^maya-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

async function main(): Promise<void> {
  const source = new Database(config.DATABASE_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    await source.backup(temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);

    const oldBackups = readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && completedBackup.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(7);
    for (const name of oldBackups) unlinkSync(join(backupDir, name));
    console.log(`Backup saved: ${destination}`);
  } finally {
    try {
      source.close();
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Database backup failed');
  process.exitCode = 1;
});
