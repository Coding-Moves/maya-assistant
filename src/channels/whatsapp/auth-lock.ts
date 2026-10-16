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
const recoveryPath = `${lockPath}.recover`;

export class AuthSessionInUseError extends Error {
  constructor() {
    super(
      `WhatsApp session is already in use (${lockPath}). Stop npm run dev and retry. If Maya is not running, remove the stale lock file and its .recover file if present.`,
    );
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors and unknown failures must not allow concurrent auth use.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function clearStaleLock(): void {
  let recoveryDescriptor: number;
  try {
    recoveryDescriptor = openSync(recoveryPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AuthSessionInUseError();
    throw error;
  }

  try {
    let previous: string;
    try {
      previous = readFileSync(lockPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    let record: unknown;
    try {
      record = JSON.parse(previous);
    } catch {
      throw new AuthSessionInUseError();
    }
    if (
      typeof record !== 'object' ||
      record === null ||
      !('pid' in record) ||
      typeof record.pid !== 'number' ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      !('token' in record) ||
      typeof record.token !== 'string' ||
      processIsRunning(record.pid)
    ) {
      throw new AuthSessionInUseError();
    }

    // Only remove the same dead owner's lock; another process may have replaced it.
    if (readFileSync(lockPath, 'utf8') !== previous)
      throw new AuthSessionInUseError();
    unlinkSync(lockPath);
  } finally {
    closeSync(recoveryDescriptor);
    unlinkSync(recoveryPath);
  }
}

export function acquireAuthSessionLock(): () => void {
  mkdirSync(config.AUTH_DIR, { recursive: true, mode: 0o700 });
  const contents = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    clearStaleLock();
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AuthSessionInUseError();
      throw retryError;
    }
  }

  try {
    writeFileSync(descriptor, contents);
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
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === contents)
        unlinkSync(lockPath);
    } catch {
      // The process is exiting; a missing or inaccessible lock needs no further cleanup.
    }
  };
  process.once('exit', release);
  return release;
}
