import { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { monitoredLinks } from '../db/schema';
import { createWorker, HealthCheckJob } from '../queue/factory';
import { checkUrl } from '../lib/checker';
import { getConvexClient } from '../lib/convex';
import { createWorkerLogger, logger } from '../lib/logger';
import * as Sentry from '@sentry/bun';
import { recordHealthCheck } from '../types/convexApiTypes';
import { redactUrlForLogs } from '../lib/url-safety';
import {
  shouldDisableMissingMonitor,
  shouldRunMonitoringJob,
} from '../lib/monitor-policy';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1, // Sample 10% of transactions
});

async function processJob(job: Job<HealthCheckJob>): Promise<void> {
  const {
    linkId,
    convexUrlId,
    longUrl,
    shortUrl,
    environment,
    source = 'scheduled',
  } = job.data;
  const log = createWorkerLogger(job.id!, linkId);
  const redactedUrl = redactUrlForLogs(longUrl);

  if (!shouldRunMonitoringJob(environment, source)) {
    await db
      .update(monitoredLinks)
      .set({
        isActive: false,
        schedulerLockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(monitoredLinks.id, linkId));
    log.info(
      { environment },
      'Skipped continuous development monitoring and disabled the monitor'
    );
    return;
  }

  log.info({ url: redactedUrl }, 'Processing health check');

  // Step 1: Perform the health check
  const result = await checkUrl(longUrl, log);

  // Step 2: Update PostgreSQL (scheduler state)
  const now = new Date();

  try {
    await db
      .update(monitoredLinks)
      .set({
        lastCheckedAt: now,
        currentStatus: result.healthStatus,
        lastStatusCode: result.statusCode,
        lastLatencyMs: result.latencyMs,
        schedulerLockedUntil: null, // Clear lock
        consecutiveFailures: result.isHealthy
          ? 0
          : sql`${monitoredLinks.consecutiveFailures} + 1`,
        updatedAt: now,
      })
      .where(eq(monitoredLinks.id, linkId));

    log.debug('PostgreSQL updated');
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : 'Unknown' },
      'PostgreSQL update failed'
    );
    Sentry.captureException(error, { extra: { jobId: job.id, linkId } });
    // Don't throw - we still want to try writing to Convex
  }

  // Step 3: Write result to Convex (permanent history)
  try {
    const sharedSecret = process.env.MONITORING_SHARED_SECRET;
    const convexClient = getConvexClient(environment);

    if (!sharedSecret) {
      throw new Error('MONITORING_SHARED_SECRET is not configured');
    }

    // Make HTTP call to Convex mutation for the correct environment
    log.debug(
      { environment },
      '[Link Monitoring] | Recording health check to Convex'
    );
    const recordResult = await convexClient.mutation(
      recordHealthCheck,
      {
        sharedSecret,
        urlId: convexUrlId,
        shortUrl,
        longUrl,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        isHealthy: result.isHealthy,
        healthStatus: result.healthStatus,
        errorMessage: result.errorMessage,
        checkedAt: now.getTime(),
      }
    );

    if (shouldDisableMissingMonitor(recordResult)) {
      await db
        .update(monitoredLinks)
        .set({
          isActive: false,
          schedulerLockedUntil: null,
          updatedAt: now,
        })
        .where(eq(monitoredLinks.id, linkId));
      log.warn(
        { convexUrlId, environment },
        'Convex URL no longer exists; monitoring disabled'
      );
      return;
    }

    log.debug('Convex health check recorded');
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : 'Unknown' },
      'Convex write failed'
    );
    Sentry.captureException(error, {
      extra: { jobId: job.id, linkId, convexUrlId },
    });
    throw error;
  }

  log.info(
    {
      status: result.healthStatus,
      latencyMs: result.latencyMs,
    },
    'Health check completed'
  );
}

// Worker instance (created on startWorker)
let worker: ReturnType<typeof createWorker> | null = null;

// Start worker - call this explicitly instead of auto-starting on import
export function startWorker(): ReturnType<typeof createWorker> {
  if (worker) {
    logger.warn('Worker already started');
    return worker;
  }

  worker = createWorker(processJob);
  logger.info(
    {
      concurrency: process.env.WORKER_CONCURRENCY || 10,
    },
    'Worker started'
  );
  return worker;
}

// Graceful shutdown
export async function shutdownWorker(): Promise<void> {
  if (!worker) {
    logger.warn('Worker not started, nothing to shut down');
    return;
  }
  logger.info('Shutting down worker...');
  await worker.close();
  worker = null;
  logger.info('Worker shut down');
}
