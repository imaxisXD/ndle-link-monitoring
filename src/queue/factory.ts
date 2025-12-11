import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
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
}

export const createQueue = () => {
  const connection = new IORedis(connectionUrl, redisConfig);
  return new Queue<HealthCheckJob>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 1000 }, // Keep last 1000 for debugging
      removeOnFail: { count: 5000 }, // Keep last 5000 failures
    },
  });
};

export const createWorker = (
  processor: (job: Job<HealthCheckJob>) => Promise<void>
) => {
  const connection = new IORedis(connectionUrl, redisConfig);

  const worker = new Worker<HealthCheckJob>(QUEUE_NAME, processor, {
    connection,
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
  const connection = new IORedis(connectionUrl, redisConfig);
  return new QueueEvents(QUEUE_NAME, { connection });
};
