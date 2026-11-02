import { config } from './config/env.js';
import { startWhatsAppSource, whatsAppSource } from './sources/whatsapp.js';
import { db } from './db/client.js';
import { migrate } from './db/migrate.js';
import { logger } from './utils/logger.js';
import { startJobs } from './scheduler/jobs.js';
import { suppressSignalSessionLogs } from './utils/signal-console.js';

let stopJobs: (() => Promise<void>) | null = null;
let shutdownWork: Promise<void> | null = null;

async function closeStep(name: string, close: () => void | Promise<void>): Promise<void> {
  try {
    await close();
  } catch (error) {
    process.exitCode = 1;
    logger.error(
      { step: name, errorType: error instanceof Error ? error.name : 'unknown' },
      'Maya shutdown step failed',
    );
    logger.debug({ err: error }, 'Shutdown failure details');
  }
}

async function shutDown(): Promise<void> {
  const timeout = setTimeout(() => {
    logger.error('Maya shutdown timed out');
    process.exit(1);
  }, 60_000);
  try {
    await closeStep('scheduler', async () => {
      await stopJobs?.();
    });
    await closeStep('whatsapp', whatsAppSource.stop);
    await closeStep('database', () => {
      if (db.open) db.close();
    });
    if (Number(process.exitCode ?? 0) === 0) logger.info('Maya stopped');
    else logger.error('Maya stopped after a shutdown error');
  } finally {
    clearTimeout(timeout);
    try {
      logger.flush();
    } catch {
      // The process is exiting even if its log destination is unavailable.
    }
    process.exit(Number(process.exitCode ?? 0));
  }
}

function requestShutdown(exitCode: number): void {
  if (exitCode > Number(process.exitCode ?? 0)) process.exitCode = exitCode;
  whatsAppSource.pause();
  shutdownWork ??= shutDown();
}

suppressSignalSessionLogs();
process.on('SIGINT', () => requestShutdown(0));
process.on('SIGTERM', () => requestShutdown(0));
process.on('unhandledRejection', (error: unknown) => {
  logger.error(
    { errorType: error instanceof Error ? error.name : 'unknown' },
    'Unhandled rejection; shutting down',
  );
  logger.debug({ err: error }, 'Unhandled rejection details');
  requestShutdown(1);
});
process.on('uncaughtException', (error: Error) => {
  logger.error({ errorType: error.name }, 'Uncaught exception; shutting down');
  logger.debug({ err: error }, 'Uncaught exception details');
  requestShutdown(1);
});
migrate();
logger.info({ botName: config.BOT_NAME }, 'Maya starting');
void startWhatsAppSource();
stopJobs = startJobs();
