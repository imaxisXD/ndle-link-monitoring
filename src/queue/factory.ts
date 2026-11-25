import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq';
import IORedis, { type RedisOptions } from 'ioredis';
import * as Sentry from '@sentry/bun';
import { getConnectionUrl, redisConfig } from './config';
import { logger } from '../lib/logger';
import {
  WORKER_CONCURRENCY,
  QUEUE_RATE_LIMIT_MAX,
  QUEUE_RATE_LIMIT_DURATION,
} from '../lib/constants';
import { withTimeout } from '../lib/timeout';
import type {
  MonitoringEnvironment,
  MonitoringJobSource,
} from '../types/monitoring';

const QUEUE_NAME = 'link-health-checks';
const REDIS_QUIT_TIMEOUT_MS = 3_000;

export interface HealthCheckJob {
  checkId: string;
  linkId: string; // PostgreSQL UUID
  convexUrlId: string;
  longUrl: string;
  shortUrl: string;
  environment: MonitoringEnvironment; // Which Convex instance to write results to
  source: MonitoringJobSource;
}
type HealthCheckQueue = Queue<HealthCheckJob, void, string>;
type HealthCheckQueueJob = Job<HealthCheckJob, void, string>;

// Singleton Redis connections to prevent connection leaks
let sharedQueueConnection: IORedis | null = null;
let sharedWorkerConnection: IORedis | null = null;

// Singleton queue instance
let sharedQueue: HealthCheckQueue | null = null;

function asBullConnection(connection: IORedis): ConnectionOptions {
  return connection as unknown as ConnectionOptions;
}

export function createRedisConnection(
  role: 'queue' | 'worker',
  extraOptions: RedisOptions = {}
): IORedis {
  const label = role === 'queue' ? 'Queue' : 'Worker';
  const connection = new IORedis(getConnectionUrl(), {
    ...redisConfig,
    ...extraOptions,
    lazyConnect: true,
  });
  connection.on('error', err => {
    logger.error({ err }, `${label} Redis connection error`);
    Sentry.captureException(err, {
      tags: { component: 'redis', connection: role },
    });
  });
  connection.on('connect', () => {
    logger.info(`${label} Redis connection established`);
  });
  return connection;
}

function getQueueConnection(): IORedis {
  if (!sharedQueueConnection) {
    sharedQueueConnection = createRedisConnection('queue', {
      maxRetriesPerRequest: 1,
    });
  }
  return sharedQueueConnection;
}

function getWorkerConnection(): IORedis {
  if (!sharedWorkerConnection) {
    sharedWorkerConnection = createRedisConnection('worker');
  }
  return sharedWorkerConnection;
}

// Returns a singleton queue instance - DO NOT call .close() on this
export const getQueue = (): HealthCheckQueue => {
  if (!sharedQueue) {
    sharedQueue = new Queue<HealthCheckJob, void, string>(QUEUE_NAME, {
      connection: asBullConnection(getQueueConnection()),
      defaultJobOptions: {
        attempts: 1, // PostgreSQL schedules durable delivery retries.
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
  }
  return sharedQueue;
};

export const createWorker = (
  processor: (job: HealthCheckQueueJob) => Promise<void>
) => {
  const worker = new Worker<HealthCheckJob, void, string>(
    QUEUE_NAME,
    processor,
    {
      connection: asBullConnection(getWorkerConnection()),
      concurrency: WORKER_CONCURRENCY,
      limiter: {
        max: QUEUE_RATE_LIMIT_MAX,
        duration: QUEUE_RATE_LIMIT_DURATION,
      },
    }
  );

  // Attach event handlers
  worker.on('completed', job => {
    logger.debug({ jobId: job.id, linkId: job.data.linkId }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, linkId: job?.data.linkId, err },
      'Job failed'
    );
  });

  worker.on('error', err => {
    logger.error({ err }, 'Worker error');
  });

  return worker;
};

async function closeRedisConnection(connection: IORedis): Promise<void> {
  if (connection.status === 'end') return;
  try {
    await withTimeout(
      connection.quit(),
      REDIS_QUIT_TIMEOUT_MS,
      'Redis quit timed out'
    );
  } catch {
    connection.disconnect();
  }
}

// Graceful shutdown helper - call this during app shutdown
export async function closeAllConnections(): Promise<void> {
  logger.info('Closing all Redis connections...');

  if (sharedQueue) {
    await sharedQueue.close();
    sharedQueue = null;
  }

  if (sharedQueueConnection) {
    const conn = sharedQueueConnection;
    sharedQueueConnection = null;
    await closeRedisConnection(conn);
  }

  if (sharedWorkerConnection) {
    const conn = sharedWorkerConnection;
    sharedWorkerConnection = null;
    await closeRedisConnection(conn);
  }

  logger.info('All Redis connections closed');
}
