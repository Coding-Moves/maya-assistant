import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { config } from '../../config/env.js';

const lockPath = join(resolve(config.AUTH_DIR), '.maya-session.lock');

export class AuthSessionInUseError extends Error {
  constructor() {
    super(
      `WhatsApp session is already in use (${lockPath}). Stop npm run dev and retry. If Maya is not running, remove the stale lock file.`,
    );
  }
}

export function acquireAuthSessionLock(): () => void {
  mkdirSync(config.AUTH_DIR, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AuthSessionInUseError();
    throw error;
  }

  try {
    writeFileSync(descriptor, token);
  } catch (error) {
    unlinkSync(lockPath);
    throw error;
  } finally {
    closeSync(descriptor);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === token)
        unlinkSync(lockPath);
    } catch {
      // The process is exiting; a missing or inaccessible lock needs no further cleanup.
    }
  };
  const onSigint = () => {
    release();
    process.exit(130);
  };
  const onSigterm = () => {
    release();
    process.exit(143);
  };
  process.once('exit', release);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return release;
}
