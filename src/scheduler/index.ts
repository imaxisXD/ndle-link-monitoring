import { and, lte, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db';
import { monitoredLinks } from '../db/schema';
import { getQueue, HealthCheckJob } from '../queue/factory';
import { schedulerLogger as logger } from '../lib/logger';
import {
  SCHEDULER_INTERVAL_MS,
  SCHEDULER_BATCH_SIZE,
  LOCK_DURATION_MS,
} from '../lib/constants';

let isRunning = false;
let intervalHandle: Timer | null = null;

export async function schedulerTick(): Promise<number> {
  if (isRunning) {
    logger.warn('Previous scheduler tick still running, skipping');
    return 0;
  }

  isRunning = true;
  const tickStart = Date.now();

  try {
    const now = new Date();

    // Find links that are due for checking
    // Conditions:
    // 1. next_check_at <= now
    // 2. is_active = true
    // 3. scheduler_locked_until is null OR scheduler_locked_until <= now (lock expired)
    const dueLinks = await db
      .select()
      .from(monitoredLinks)
      .where(
        and(
          lte(monitoredLinks.nextCheckAt, now),
          eq(monitoredLinks.isActive, true),
          or(
            isNull(monitoredLinks.schedulerLockedUntil),
            lte(monitoredLinks.schedulerLockedUntil, now)
          )
        )
      )
      .orderBy(monitoredLinks.nextCheckAt)
      .limit(SCHEDULER_BATCH_SIZE);

    if (dueLinks.length === 0) {
      logger.debug('No links due for checking');
      return 0;
    }

    logger.info({ count: dueLinks.length }, 'Found due links');

    const queue = getQueue();
    let queued = 0;

    for (const link of dueLinks) {
      const job: HealthCheckJob = {
        linkId: link.id,
        convexUrlId: link.convexUrlId,
        convexUserId: link.convexUserId,
        longUrl: link.longUrl,
        shortUrl: link.shortUrl,
        environment: link.environment as 'dev' | 'prod',
      };

      // Add to queue
      await queue.add(`check-${link.id}`, job, {
        jobId: `${link.id}-${Date.now()}`, // Unique job ID
      });

      // Update next_check_at and set lock to prevent double-scheduling
      const nextCheckAt = new Date(now.getTime() + link.intervalMs);
      const lockUntil = new Date(now.getTime() + LOCK_DURATION_MS);

      await db
        .update(monitoredLinks)
        .set({
          nextCheckAt,
          schedulerLockedUntil: lockUntil,
          updatedAt: now,
        })
        .where(eq(monitoredLinks.id, link.id));

      queued++;
    }

    // Note: Don't call queue.close() - it's a singleton

    const tickDuration = Date.now() - tickStart;
    logger.info(
      { queued, durationMs: tickDuration },
      'Scheduler tick completed'
    );

    return queued;
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown' },
      'Scheduler tick failed'
    );
    return 0;
  } finally {
    isRunning = false;
  }
}

export function startScheduler(): void {
  logger.info({ intervalMs: SCHEDULER_INTERVAL_MS }, 'Starting scheduler');

  // Run immediately on start
  schedulerTick();

  // Then run on interval
  intervalHandle = setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Scheduler stopped');
  }
}
