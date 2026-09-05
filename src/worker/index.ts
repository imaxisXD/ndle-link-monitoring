import type { Job } from 'bullmq';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { monitoredLinks, monitorChecks } from '../db/schema';
import { createWorker, type HealthCheckJob } from '../queue/factory';
import { checkUrl } from '../lib/checker';
import { getConvexClient } from '../lib/convex';
import { createWorkerLogger, logger } from '../lib/logger';
import { recordHealthCheck } from '../types/convexApiTypes';
import { shouldDisableMissingMonitor, shouldRunMonitoringJob } from '../lib/monitor-policy';
import { serviceState } from '../lib/service-state';
import { CHECK_TIMEOUT_MS } from '../lib/constants';
import { enabledEnvironments } from '../lib/config';

export async function processJob(job: Pick<Job<HealthCheckJob>, 'id' | 'data'>): Promise<void> {
  const checkId = job.data.checkId ?? `legacy-${job.id}`;
  let check = await db.query.monitorChecks.findFirst({ where: eq(monitorChecks.id, checkId) });
  const link = await db.query.monitoredLinks.findFirst({ where: eq(monitoredLinks.id, job.data.linkId) });
  if (!link) return;
  // Adopt jobs queued by the previous release without giving them a new identity.
  if (!check && !job.data.checkId) {
    await db.insert(monitorChecks).values({
      id: checkId, linkId: link.id, monitoringVersion: 0,
      source: job.data.source ?? 'scheduled', scheduledAt: new Date(),
    }).onConflictDoNothing();
    check = await db.query.monitorChecks.findFirst({ where: eq(monitorChecks.id, checkId) });
  }
  if (!check || check.finishedAt) return;
  const log = createWorkerLogger(checkId, link.id);
  if (link.isDeleted || !enabledEnvironments().includes(link.environment) || link.monitoringVersion !== check.monitoringVersion ||
      !shouldRunMonitoringJob(link.environment, check.source) || (check.source === 'scheduled' && !link.isActive)) {
    await db.update(monitorChecks).set({ finishedAt: new Date(), lastError: 'Monitor was removed or changed' }).where(eq(monitorChecks.id, checkId));
    return;
  }
  try {
    if (!check.result || !check.measuredAt) {
      const now = new Date();
      const [claimed] = await db.update(monitorChecks).set({
        measurementLeaseUntil: new Date(now.getTime() + Math.max(CHECK_TIMEOUT_MS * 2, 60_000)),
      }).where(and(eq(monitorChecks.id, checkId), isNull(monitorChecks.result),
        or(isNull(monitorChecks.measurementLeaseUntil), lte(monitorChecks.measurementLeaseUntil, now))))
        .returning();
      if (!claimed) throw new Error('This check is already being measured');
      const result = await checkUrl(link.longUrl, log);
      const measuredAt = new Date();
      await db.transaction(async transaction => {
        const [saved] = await transaction.update(monitorChecks).set({ result, measuredAt, measurementLeaseUntil: null })
          .where(and(eq(monitorChecks.id, checkId), isNull(monitorChecks.result))).returning();
        if (!saved) return;
        await transaction.update(monitoredLinks).set({
          lastCheckedAt: measuredAt, currentStatus: result.healthStatus,
          lastStatusCode: result.statusCode, lastLatencyMs: result.latencyMs,
          consecutiveFailures: result.healthStatus === 'unknown' ? sql`${monitoredLinks.consecutiveFailures}` :
            result.isHealthy ? 0 : sql`${monitoredLinks.consecutiveFailures} + 1`,
          updatedAt: measuredAt,
        }).where(and(eq(monitoredLinks.id, link.id), eq(monitoredLinks.monitoringVersion, check!.monitoringVersion),
          eq(monitoredLinks.isDeleted, false), or(isNull(monitoredLinks.lastCheckedAt), lte(monitoredLinks.lastCheckedAt, measuredAt))));
      });
      check = await db.query.monitorChecks.findFirst({ where: eq(monitorChecks.id, checkId) });
    }
    if (!check?.result || !check.measuredAt) throw new Error('The check result was not saved');
    // A deletion or newer registration can arrive while the destination responds.
    const current = await db.query.monitoredLinks.findFirst({ where: eq(monitoredLinks.id, link.id) });
    if (!current || current.isDeleted || current.monitoringVersion !== check.monitoringVersion) {
      await db.update(monitorChecks).set({ finishedAt: new Date(), lastError: 'Monitor changed during the check' }).where(eq(monitorChecks.id, checkId));
      return;
    }
    const sharedSecret = process.env.MONITORING_SHARED_SECRET;
    if (!sharedSecret) throw new Error('MONITORING_SHARED_SECRET is required');
    const response = await getConvexClient(link.environment).mutation(recordHealthCheck, {
      ...check.result, checkId, monitoringVersion: check.monitoringVersion,
      sharedSecret, urlId: link.convexUrlId, shortUrl: link.shortUrl, longUrl: link.longUrl,
      checkedAt: check.measuredAt.getTime(),
    });
    if (response?.success !== true && !shouldDisableMissingMonitor(response)) throw new Error('Convex did not confirm the check result');
    await db.transaction(async transaction => {
      if (shouldDisableMissingMonitor(response)) await transaction.update(monitoredLinks)
        .set({ isActive: false, isDeleted: true, updatedAt: new Date() })
        .where(and(eq(monitoredLinks.id, link.id), eq(monitoredLinks.monitoringVersion, check!.monitoringVersion)));
      await transaction.update(monitorChecks).set({ finishedAt: new Date(), queueLeaseUntil: null, lastError: null })
        .where(eq(monitorChecks.id, checkId));
    });
  } catch (error) {
    const attempts = (check?.deliveryAttempts ?? 0) + 1;
    await db.update(monitorChecks).set({
      deliveryAttempts: sql`${monitorChecks.deliveryAttempts} + 1`,
      nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9))),
      queueLeaseUntil: null,
      lastError: error instanceof Error ? error.message : 'Check delivery failed',
    }).where(eq(monitorChecks.id, checkId));
    throw error;
  }
}

let worker: ReturnType<typeof createWorker> | null = null;
export async function startWorker(): Promise<void> {
  if (worker) return;
  worker = createWorker(processJob);
  worker.on('error', () => { serviceState.workerReady = false; });
  worker.on('ready', () => { serviceState.workerReady = true; });
  await worker.waitUntilReady();
  serviceState.workerReady = true;
  logger.info('Monitor worker started');
}
export async function shutdownWorker(): Promise<void> {
  serviceState.workerReady = false;
  await worker?.close();
  worker = null;
}
