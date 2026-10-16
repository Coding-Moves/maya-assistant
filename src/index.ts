import { config } from './config/env.js';
import { migrate } from './db/migrate.js';
import { logger } from './utils/logger.js';

migrate();
logger.info({ botName: config.BOT_NAME }, 'Maya starting');
