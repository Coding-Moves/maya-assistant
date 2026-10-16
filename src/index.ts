import { config } from './config/env.js';
import { logger } from './utils/logger.js';

logger.info({ botName: config.BOT_NAME }, 'Maya starting');
