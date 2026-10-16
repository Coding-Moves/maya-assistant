import pino from 'pino';
import { config } from '../config/env.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(process.env.npm_lifecycle_event === 'dev'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
