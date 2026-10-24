import { config } from './config/env.js';
import { connectToWhatsApp } from './channels/whatsapp/connection.js';
import { migrate } from './db/migrate.js';
import { logger } from './utils/logger.js';
import { startJobs } from './scheduler/jobs.js';
import { suppressSignalSessionLogs } from './utils/signal-console.js';

suppressSignalSessionLogs();
migrate();
logger.info({ botName: config.BOT_NAME }, 'Maya starting');
void connectToWhatsApp();
startJobs();
