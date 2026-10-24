import cron from 'node-cron';
import { config } from '../config/env.js';
import { runDigest } from '../features/digests.js';
import { extractOnce } from '../features/extract.js';
import { runWeeklyPlan } from '../features/weeklyPlan.js';
import { logger } from '../utils/logger.js';

export type JobName = 'morning' | 'evening' | 'weekly';
export type JobResult = 'sent' | 'not-sent' | 'busy' | 'failed';

const runningJobs = new Set<JobName>();

interface JobDependencies {
  extract: typeof extractOnce;
  schedule: typeof cron.schedule;
  every: typeof setInterval;
  clear: typeof clearInterval;
}

export async function runJob(name: JobName): Promise<JobResult> {
  if (runningJobs.has(name)) return 'busy';
  runningJobs.add(name);
  try {
    const sent =
      name === 'weekly' ? await runWeeklyPlan() : await runDigest(name);
    return sent ? 'sent' : 'not-sent';
  } catch (error) {
    logger.error(
      { job: name, errorType: error instanceof Error ? error.name : 'unknown' },
      'Scheduled job failed',
    );
    logger.debug({ err: error }, 'Scheduled job failure details');
    return 'failed';
  } finally {
    runningJobs.delete(name);
  }
}

export function startJobs(
  dependencies: Partial<JobDependencies> = {},
): () => Promise<void> {
  const extract = dependencies.extract ?? extractOnce;
  const schedule = dependencies.schedule ?? cron.schedule;
  const every = dependencies.every ?? setInterval;
  const clear = dependencies.clear ?? clearInterval;
  let extractionRunning = false;
  const runExtraction = async () => {
    if (extractionRunning) return;
    extractionRunning = true;
    try {
      await extract();
    } catch (error) {
      logger.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Extraction run failed',
      );
      logger.debug({ err: error }, 'Extraction run failure details');
    } finally {
      extractionRunning = false;
    }
  };

  const jobs = [
    schedule(config.MORNING_DIGEST_CRON, () => runJob('morning'), {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-morning',
    }),
    schedule(config.EVENING_DIGEST_CRON, () => runJob('evening'), {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-evening',
    }),
    schedule(config.WEEKLY_PLAN_CRON, () => runJob('weekly'), {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-weekly',
    }),
  ];
  const extractionTimer = every(
    () => void runExtraction(),
    config.EXTRACT_INTERVAL_MIN * 60_000,
  );

  return async () => {
    clear(extractionTimer);
    await Promise.all(jobs.map((job) => job.stop()));
  };
}
