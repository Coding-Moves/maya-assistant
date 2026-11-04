import cron from 'node-cron';
import { config } from '../config/env.js';
import { runDigest } from '../features/digests.js';
import { syncCalendarOnce } from '../features/calendar.js';
import { syncUpcomingCalendarEvents } from '../features/calendar-read.js';
import { remindImportantCalendarEvents } from '../features/calendar-reminders.js';
import { extractOnce } from '../features/extract.js';
import { processPendingMedia } from '../features/media.js';
import { runWeeklyPlan } from '../features/weeklyPlan.js';
import { syncVuClassicTodo } from '../features/vu.js';
import { sendToOwner } from '../channels/whatsapp/send.js';
import { logger } from '../utils/logger.js';

export type JobName = 'morning' | 'evening' | 'weekly';
export type JobResult = 'sent' | 'not-sent' | 'busy' | 'failed';

const runningJobs = new Set<JobName>();

interface JobDependencies {
  extract: typeof extractOnce;
  media: typeof processPendingMedia;
  calendar: typeof syncCalendarOnce;
  calendarRead: typeof syncUpcomingCalendarEvents;
  vu: typeof syncVuClassicTodo;
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
    const calendarSent = name === 'morning' ? await remindImportantCalendarEvents() : false;
    return sent || calendarSent ? 'sent' : 'not-sent';
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
  const media = dependencies.media ?? processPendingMedia;
  const calendar = dependencies.calendar ?? syncCalendarOnce;
  const calendarRead = dependencies.calendarRead ?? syncUpcomingCalendarEvents;
  const vu = dependencies.vu ?? syncVuClassicTodo;
  const schedule = dependencies.schedule ?? cron.schedule;
  const every = dependencies.every ?? setInterval;
  const clear = dependencies.clear ?? clearInterval;
  let extractionRunning = false;
  let vuRunning = false;
  let stopping = false;
  let stopWork: Promise<void> | null = null;
  const pending = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
  };
  const runExtraction = async () => {
    if (stopping || extractionRunning) return;
    extractionRunning = true;
    try {
      await media();
    } catch (error) {
      logger.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Media run failed',
      );
      logger.debug({ err: error }, 'Media run failure details');
    }
    try {
      await extract();
    } catch (error) {
      logger.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Extraction run failed',
      );
      logger.debug({ err: error }, 'Extraction run failure details');
    } finally {
      try {
        await calendar();
      } catch (error) {
        logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Calendar run failed');
        logger.debug({ err: error }, 'Calendar run failure details');
      }
      try {
        await calendarRead();
        await remindImportantCalendarEvents();
      } catch (error) {
        logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Calendar read run failed');
        logger.debug({ err: error }, 'Calendar read failure details');
      }
      extractionRunning = false;
    }
  };
  const runScheduledJob = (name: JobName) => {
    if (!stopping) track(runJob(name));
  };
  const runVu = async () => {
    if (stopping || vuRunning) return;
    vuRunning = true;
    try {
      const counts = await vu();
      logger.info({ ...counts }, 'VU Classic To Do sync completed');
    } catch (error) {
      logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'VU Classic To Do sync failed');
      await sendToOwner('I couldn’t update your VU quiz and assignment deadlines today. Please check Classic To Do directly; I’ll try again at the next scheduled check.');
    } finally {
      vuRunning = false;
    }
  };

  const jobs = [
    schedule(config.MORNING_DIGEST_CRON, () => runScheduledJob('morning'), {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-morning',
    }),
    schedule(config.EVENING_DIGEST_CRON, () => runScheduledJob('evening'), {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-evening',
    }),
    schedule(config.WEEKLY_PLAN_CRON, () => runScheduledJob('weekly'), {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-weekly',
    }),
  ];
  if (config.VU_LMS_SYNC) {
    jobs.push(schedule(config.VU_SYNC_CRON, () => {
      if (!stopping) track(runVu());
    }, {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-vu-classic-todo',
    }));
  }
  const extractionTimer = every(
    () => {
      if (!stopping) track(runExtraction());
    },
    config.EXTRACT_INTERVAL_MIN * 60_000,
  );

  return () => {
    if (stopWork) return stopWork;
    stopping = true;
    stopWork = (async () => {
      clear(extractionTimer);
      await Promise.all(jobs.map((job) => job.stop()));
      await Promise.allSettled(pending);
    })();
    return stopWork;
  };
}
