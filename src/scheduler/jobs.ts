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
import { syncNfcAssignments } from '../features/nfc.js';
import { sendToOwner } from '../channels/whatsapp/send.js';
import { logger } from '../utils/logger.js';
import { cleanupMemories } from '../db/repos/memories.js';
import { cleanupTimetableDrafts } from '../db/repos/timetables.js';
import { sendDueOwnerReminders } from '../features/owner-reminders.js';
import { expirePastDueTasks } from '../db/repos/tasks.js';
import { cleanupDialogue } from '../features/context.js';
import { pruneInactiveMediaJobs } from '../db/repos/media.js';

export type JobName = 'morning' | 'evening' | 'weekly';
export type JobResult = 'sent' | 'not-sent' | 'busy' | 'failed';

const runningJobs = new Set<JobName>();

interface JobDependencies {
  extract: typeof extractOnce;
  media: typeof processPendingMedia;
  calendar: typeof syncCalendarOnce;
  calendarRead: typeof syncUpcomingCalendarEvents;
  vu: typeof syncVuClassicTodo;
  nfc: typeof syncNfcAssignments;
  schedule: typeof cron.schedule;
  every: typeof setInterval;
  clear: typeof clearInterval;
  memoryCleanup: () => void;
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
  const nfc = dependencies.nfc ?? syncNfcAssignments;
  const schedule = dependencies.schedule ?? cron.schedule;
  const every = dependencies.every ?? setInterval;
  const clear = dependencies.clear ?? clearInterval;
  const memoryCleanup = dependencies.memoryCleanup ?? (() => {
    cleanupMemories();
    cleanupTimetableDrafts();
  });
  let extractionRunning = false;
  let vuRunning = false;
  let nfcRunning = false;
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
      if (config.BOT_MODE === 'separate') expirePastDueTasks();
    } catch (error) {
      logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Task expiry run failed');
    }
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
      if (counts.created || counts.updated) {
        const parts = [counts.created ? `${counts.created} new` : '', counts.updated ? `${counts.updated} updated` : ''].filter(Boolean).join(' and ');
        await sendToOwner(`I checked VU Classic To Do and found ${parts} academic item${counts.created + counts.updated === 1 ? '' : 's'}. I’ve updated your reminders.`);
      }
    } catch (error) {
      logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'VU Classic To Do sync failed');
      await sendToOwner('I couldn’t update your VU quiz and assignment deadlines today. Please check Classic To Do directly; I’ll try again at the next scheduled check.');
    } finally {
      vuRunning = false;
    }
  };
  const runNfc = async () => {
    if (stopping || nfcRunning) return;
    nfcRunning = true;
    try {
      const counts = await nfc();
      logger.info({ ...counts }, 'NFC CMS assignment sync completed');
      if (!counts.skipped && (counts.created || counts.statusChanged || counts.deadlineChanged || counts.missing)) {
        const changes = [
          counts.created ? `${counts.created} new assignment${counts.created === 1 ? '' : 's'}` : '',
          counts.statusChanged ? `${counts.statusChanged} status change${counts.statusChanged === 1 ? '' : 's'}` : '',
          counts.deadlineChanged ? `${counts.deadlineChanged} deadline change${counts.deadlineChanged === 1 ? '' : 's'}` : '',
          counts.missing ? `${counts.missing} item${counts.missing === 1 ? '' : 's'} no longer listed` : '',
        ].filter(Boolean).join(', ');
        await sendToOwner(`I checked NFC CMS and found ${changes}. I kept missing items unresolved, so nothing was marked complete without portal evidence.`);
      }
    } catch (error) {
      logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'NFC CMS assignment sync failed');
      await sendToOwner('I couldn’t update your NFC assignment deadlines today. I have not attempted any upload; I’ll try again at the next scheduled check.');
    } finally {
      nfcRunning = false;
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
    schedule('0 3 * * *', () => {
      if (!stopping) track(Promise.resolve().then(() => {
        memoryCleanup();
        cleanupDialogue();
        if (config.BOT_MODE === 'separate') pruneInactiveMediaJobs();
        if (config.BOT_MODE === 'separate') expirePastDueTasks();
      }).catch((error: unknown) => {
        logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Memory cleanup failed');
      }));
    }, {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-memory-cleanup',
    }),
    ...(config.BOT_MODE === 'separate' ? [schedule('* * * * *', () => {
      if (!stopping) track(sendDueOwnerReminders().catch((error: unknown) => {
        logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Owner reminder run failed');
      }));
    }, {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-owner-reminders',
    })] : []),
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
  if (config.NFC_CMS_SYNC) {
    jobs.push(schedule(config.NFC_SYNC_CRON, () => {
      if (!stopping) track(runNfc());
    }, {
      timezone: config.TIMEZONE,
      noOverlap: true,
      name: 'maya-nfc-assignments',
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
