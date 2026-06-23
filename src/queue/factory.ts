import { Queue, Worker, Job, QueueEvents, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import * as Sentry from '@sentry/bun';
import { connectionUrl, redisConfig } from './config';
import { logger } from '../lib/logger';
import {
  WORKER_CONCURRENCY,
  QUEUE_RATE_LIMIT_MAX,
  QUEUE_RATE_LIMIT_DURATION,
} from '../lib/constants';

const QUEUE_NAME = 'link-health-checks';

export interface HealthCheckJob {
  linkId: string; // PostgreSQL UUID
  convexUrlId: string;
  convexUserId: string;
  longUrl: string;
  shortUrl: string;
  environment: 'dev' | 'prod'; // Which Convex instance to write results to
}
type HealthCheckQueue = Queue<HealthCheckJob, void, string>;
type HealthCheckQueueJob = Job<HealthCheckJob, void, string>;

// Singleton Redis connections to prevent connection leaks
let sharedQueueConnection: IORedis | null = null;
let sharedWorkerConnection: IORedis | null = null;
let sharedEventsConnection: IORedis | null = null;

// Singleton queue instance
let sharedQueue: HealthCheckQueue | null = null;

function asBullConnection(connection: IORedis): ConnectionOptions {
  return connection as unknown as ConnectionOptions;
}

function getQueueConnection(): IORedis {
  if (!sharedQueueConnection) {
    sharedQueueConnection = new IORedis(connectionUrl, {
      ...redisConfig,
      lazyConnect: true,
    });
    sharedQueueConnection.on('error', err => {
      logger.error({ error: err.message }, 'Queue Redis connection error');
      Sentry.captureException(err, {
        tags: { component: 'redis', connection: 'queue' },
      });
    });
    sharedQueueConnection.on('connect', () => {
      logger.info('Queue Redis connection established');
    });
  }
  return sharedQueueConnection;
}

function getWorkerConnection(): IORedis {
  if (!sharedWorkerConnection) {
    sharedWorkerConnection = new IORedis(connectionUrl, {
      ...redisConfig,
      lazyConnect: true,
    });
    sharedWorkerConnection.on('error', err => {
      logger.error({ error: err.message }, 'Worker Redis connection error');
      Sentry.captureException(err, {
        tags: { component: 'redis', connection: 'worker' },
      });
    });
    sharedWorkerConnection.on('connect', () => {
      logger.info('Worker Redis connection established');
    });
  }
  return sharedWorkerConnection;
}

function getEventsConnection(): IORedis {
  if (!sharedEventsConnection) {
    sharedEventsConnection = new IORedis(connectionUrl, {
      ...redisConfig,
      lazyConnect: true,
    });
    sharedEventsConnection.on('error', err => {
      logger.error({ error: err.message }, 'Events Redis connection error');
      Sentry.captureException(err, {
        tags: { component: 'redis', connection: 'events' },
      });
    });
    sharedEventsConnection.on('connect', () => {
      logger.info('Events Redis connection established');
    });
  }
  return sharedEventsConnection;
}

// Returns a singleton queue instance - DO NOT call .close() on this
export const getQueue = (): HealthCheckQueue => {
  if (!sharedQueue) {
    sharedQueue = new Queue<HealthCheckJob, void, string>(QUEUE_NAME, {
      connection: asBullConnection(getQueueConnection()),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 }, // Keep last 1000 for debugging
        removeOnFail: { count: 5000 }, // Keep last 5000 failures
      },
    });
  }
  return sharedQueue;
};

// @deprecated - Use getQueue() instead. This is kept for backwards compatibility
// but now returns the singleton queue.
export const createQueue = (): HealthCheckQueue => {
  logger.warn('createQueue() is deprecated, use getQueue() instead');
  return getQueue();
};

export const createWorker = (
  processor: (job: HealthCheckQueueJob) => Promise<void>
) => {
  const worker = new Worker<HealthCheckJob, void, string>(QUEUE_NAME, processor, {
    connection: asBullConnection(getWorkerConnection()),
    concurrency: WORKER_CONCURRENCY,
    limiter: {
      max: QUEUE_RATE_LIMIT_MAX,
      duration: QUEUE_RATE_LIMIT_DURATION,
    },
  });

  // Attach event handlers
  worker.on('completed', job => {
    logger.debug({ jobId: job.id, linkId: job.data.linkId }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, linkId: job?.data.linkId, error: err.message },
      'Job failed'
    );
  });

  worker.on('error', err => {
    logger.error({ error: err.message }, 'Worker error');
  });

  return worker;
};

export const createQueueEvents = () => {
  return new QueueEvents(QUEUE_NAME, {
    connection: asBullConnection(getEventsConnection()),
  });
};

// Graceful shutdown helper - call this during app shutdown
export async function closeAllConnections(): Promise<void> {
  logger.info('Closing all Redis connections...');

  if (sharedQueue) {
    await sharedQueue.close();
    sharedQueue = null;
  }

  if (sharedQueueConnection) {
    sharedQueueConnection.disconnect();
    sharedQueueConnection = null;
  }

  if (sharedWorkerConnection) {
    sharedWorkerConnection.disconnect();
    sharedWorkerConnection = null;
  }

  if (sharedEventsConnection) {
    sharedEventsConnection.disconnect();
    sharedEventsConnection = null;
  }

  logger.info('All Redis connections closed');
}
