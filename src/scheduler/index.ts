import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { db } from '../db';
import { monitorChecks, monitoredLinks } from '../db/schema';
import { getQueue } from '../queue/factory';
import { schedulerLogger as logger } from '../lib/logger';
import { SCHEDULER_INTERVAL_MS, SCHEDULER_BATCH_SIZE } from '../lib/constants';
import { getEffectiveMonitoringIntervalMs } from '../lib/monitor-policy';
import { enabledEnvironments } from '../lib/config';
import { serviceState } from '../lib/service-state';

let running: Promise<number> | null = null;
let interval: Timer | null = null;

export async function claimDueChecks(now = new Date()): Promise<number> {
  if (!enabledEnvironments().includes('prod')) return 0;
  return db.transaction(async transaction => {
    const links = await transaction.select().from(monitoredLinks).where(and(
      lte(monitoredLinks.nextCheckAt, now), eq(monitoredLinks.isActive, true),
      eq(monitoredLinks.isDeleted, false), eq(monitoredLinks.environment, 'prod'),
    )).orderBy(monitoredLinks.nextCheckAt).limit(SCHEDULER_BATCH_SIZE).for('update', { skipLocked: true });
    for (const link of links) {
      const intervalMs = getEffectiveMonitoringIntervalMs(link.intervalMs);
      // The occurrence ID is based on stored due time, never the enqueue attempt.
      await transaction.insert(monitorChecks).values({
        id: `${link.id}-${link.monitoringVersion}-${link.nextCheckAt.getTime()}`,
        linkId: link.id, monitoringVersion: link.monitoringVersion,
        scheduledAt: link.nextCheckAt, source: 'scheduled', nextAttemptAt: now,
      }).onConflictDoNothing();
      await transaction.update(monitoredLinks).set({
        intervalMs, nextCheckAt: new Date(now.getTime() + intervalMs), updatedAt: now,
        schedulerLockedUntil: null,
      }).where(eq(monitoredLinks.id, link.id));
    }
    return links.length;
  });
}

export async function dispatchChecks(now = new Date()): Promise<number> {
  const dueChecks = await db.transaction(async transaction => {
    const rows = await transaction.select({ check: monitorChecks, link: monitoredLinks })
      .from(monitorChecks).innerJoin(monitoredLinks, eq(monitorChecks.linkId, monitoredLinks.id))
      .where(and(isNull(monitorChecks.finishedAt), lte(monitorChecks.nextAttemptAt, now),
        inArray(monitoredLinks.environment, enabledEnvironments()),
        or(isNull(monitorChecks.queueLeaseUntil), lte(monitorChecks.queueLeaseUntil, now))))
      .orderBy(monitorChecks.nextAttemptAt).limit(SCHEDULER_BATCH_SIZE)
      .for('update', { of: monitorChecks, skipLocked: true });
    if (rows.length) await transaction.update(monitorChecks).set({
      queueLeaseUntil: new Date(now.getTime() + 60_000),
    }).where(inArray(monitorChecks.id, rows.map(row => row.check.id)));
    return rows;
  });
  const queue = getQueue();
  for (const { check, link } of dueChecks) {
    const existing = await queue.getJob(check.id);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') await existing.retry(state);
    } else {
      await queue.add('check', {
        checkId: check.id, linkId: link.id, convexUrlId: link.convexUrlId,
        longUrl: link.longUrl, shortUrl: link.shortUrl, environment: link.environment,
        source: check.source,
      }, { jobId: check.id, priority: check.source === 'manual' ? 1 : undefined });
    }
  }
  return dueChecks.length;
}

export async function schedulerTick(): Promise<number> {
  if (running) return running;
  running = (async () => {
    await claimDueChecks();
    const queued = await dispatchChecks();
    // Keep the durable recovery window aligned with Convex receipt retention.
    const old = await db.select({ id: monitorChecks.id }).from(monitorChecks)
      .where(lte(monitorChecks.finishedAt, new Date(Date.now() - 35 * 86400_000))).limit(500);
    if (old.length) await db.delete(monitorChecks).where(inArray(monitorChecks.id, old.map(row => row.id)));
    serviceState.lastSchedulerSuccess = Date.now();
    logger.debug({ queued }, 'Monitor scheduler completed');
    return queued;
  })();
  try { return await running; } finally { running = null; }
}

export async function startScheduler(): Promise<void> {
  if (interval) return;
  await schedulerTick();
  interval = setInterval(() => { schedulerTick().catch(error => logger.error({ error }, 'Monitor scheduler failed')); }, SCHEDULER_INTERVAL_MS);
}

export async function stopScheduler(): Promise<void> {
  if (interval) clearInterval(interval);
  interval = null;
  await running?.catch(() => {});
}
