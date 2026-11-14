import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace = mkdtempSync(join(tmpdir(), 'maya-phase3-eval-'));
const databasePath = join(workspace, 'maya.db');
process.env.GEMINI_API_KEY ??= 'evaluation-only';
process.env.BOT_MODE = 'separate';
process.env.OWNER_JID = '999999999999@s.whatsapp.net';
process.env.DATABASE_PATH = databasePath;

function sqliteFootprintBytes(path: string): number {
  return [path, `${path}-wal`, `${path}-shm`]
    .filter(existsSync)
    .reduce((total, file) => total + statSync(file).size, 0);
}

async function main(): Promise<void> {
  let closeDatabase: (() => void) | undefined;
  let peakRss = process.memoryUsage().rss;
  const observeMemory = (): void => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  try {
    const { db } = await import('../src/db/client.js');
    closeDatabase = (): void => {
      db.close();
    };
    const { migrate } = await import('../src/db/migrate.js');
    const { rememberGroup } = await import('../src/db/repos/groups.js');
    const { insertMessage } = await import('../src/db/repos/messages.js');
    const { createTask } = await import('../src/db/repos/tasks.js');
    const { separateContext } = await import('../src/features/context.js');
    migrate();
    observeMemory();
    for (let group = 0; group < 8; group += 1) {
      const id = `eval-${group}@g.us`;
      rememberGroup(id, `Evaluation course ${group}`);
      for (let message = 0; message < 300; message += 1) {
        insertMessage({ externalId: `${group}-${message}`, chatId: id, sentAt: '2026-11-14T10:00:00.000Z',
          text: message % 75 === 0 ? `CS${group} exam deadline moved to Hall ${message}.` : `Routine class discussion ${group}-${message}.` });
      }
      observeMemory();
    }
    for (let task = 0; task < 160; task += 1) {
      createTask({ type: 'quiz', subject: `CS${task % 8}`, title: `Evaluation quiz ${task}`, dueAt: '2027-02-01T09:00:00.000Z' });
      if (task % 20 === 19) observeMemory();
    }

    let largestContextBytes = 0;
    for (let i = 0; i < 100; i += 1) {
      const context = separateContext(`Where is the CS${i % 8} exam deadline?`);
      largestContextBytes = Math.max(largestContextBytes, Buffer.byteLength(context));
      observeMemory();
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    const databaseBytes = sqliteFootprintBytes(databasePath);
    const result = {
      fixture: { groups: 8, messages: 2_400, tasks: 160, queries: 100 },
      peakRssMb: Math.ceil(peakRss / 1_000_000),
      largestContextBytes,
      databaseBytes,
    };
    if (largestContextBytes > 16_000 || peakRss > 550_000_000) throw new Error('Phase 3 resource guard exceeded');
    console.log(JSON.stringify(result));
  } finally {
    closeDatabase?.();
    rmSync(workspace, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 3 resource evaluation failed');
  process.exitCode = 1;
});
