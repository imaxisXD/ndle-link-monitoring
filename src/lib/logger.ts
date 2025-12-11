import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  base: { service: 'link-monitoring' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Child logger factory for request context
export const createRequestLogger = (
  requestId: string,
  extra?: Record<string, unknown>
) => {
  return logger.child({ requestId, ...extra });
};

// Child logger factory for worker context
export const createWorkerLogger = (jobId: string, linkId: string) => {
  return logger.child({ component: 'worker', jobId, linkId });
};

// Child logger for scheduler
export const schedulerLogger = logger.child({ component: 'scheduler' });
