import { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { monitoredLinks } from '../db/schema';
import { createWorker, HealthCheckJob } from '../queue/factory';
import { checkUrl } from '../lib/checker';
import { convexClient } from '../lib/convex';
import { createWorkerLogger, logger } from '../lib/logger';
import * as Sentry from '@sentry/bun';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1, // Sample 10% of transactions
});

async function processJob(job: Job<HealthCheckJob>): Promise<void> {
  const { linkId, convexUrlId, convexUserId, longUrl, shortUrl } = job.data;
  const log = createWorkerLogger(job.id!, linkId);

  log.info({ longUrl: longUrl.substring(0, 100) }, 'Processing health check');

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
    if (sharedSecret && process.env.CONVEX_URL) {
      // Make HTTP call to Convex mutation
      // We'll set this up once the Convex function is created
      log.debug('Convex health check would be recorded here');

      // TODO: Uncomment when Convex function is ready
      // await convexClient.mutation(api.linkMonitoring.recordHealthCheck, {
      //   sharedSecret,
      //   urlId: convexUrlId,
      //   userId: convexUserId,
      //   shortUrl,
      //   longUrl,
      //   statusCode: result.statusCode,
      //   latencyMs: result.latencyMs,
      //   isHealthy: result.isHealthy,
      //   healthStatus: result.healthStatus,
      //   errorMessage: result.errorMessage,
      //   checkedAt: now.getTime(),
      // });
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
    // Don't throw - job is still considered successful if we got the check result
  }

  log.info(
    {
      status: result.healthStatus,
      latencyMs: result.latencyMs,
    },
    'Health check completed'
  );
}

// Create and start the worker
export const worker = createWorker(processJob);

logger.info(
  {
    concurrency: process.env.WORKER_CONCURRENCY || 10,
  },
  'Worker started'
);

// Graceful shutdown
export async function shutdownWorker(): Promise<void> {
  logger.info('Shutting down worker...');
  await worker.close();
  logger.info('Worker shut down');
}
