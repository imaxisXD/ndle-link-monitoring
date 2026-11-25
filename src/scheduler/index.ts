import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db';
import { monitorChecks, monitoredLinks } from '../db/schema';
import { getQueue as defaultGetQueue } from '../queue/factory';
import { schedulerLogger as logger } from '../lib/logger';
import { SCHEDULER_INTERVAL_MS, SCHEDULER_BATCH_SIZE } from '../lib/constants';
import { PRODUCTION_MONITORING_INTERVAL_MS } from '../lib/monitor-policy';
import { enabledEnvironments as defaultEnabledEnvironments } from '../lib/config';
import { serviceState } from '../lib/service-state';

const QUEUE_LEASE_MS = 60_000;
const RETENTION_WINDOW_MS = 35 * 86_400_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 500;
const PRUNE_MAX_BATCHES = 20;

let running: Promise<number> | null = null;
let interval: Timer | null = null;
let pruning: Promise<number> | null = null;
let pruneInterval: Timer | null = null;

export interface SchedulerDependencies {
  db: typeof defaultDb;
  getQueue: typeof defaultGetQueue;
  enabledEnvironments: typeof defaultEnabledEnvironments;
}

const defaultDeps: SchedulerDependencies = {
  db: defaultDb,
  getQueue: defaultGetQueue,
  enabledEnvironments: defaultEnabledEnvironments,
};

export async function claimDueChecks(
  now = new Date(),
  overrides: Partial<SchedulerDependencies> = {}
): Promise<number> {
  const deps = { ...defaultDeps, ...overrides };
  if (!deps.enabledEnvironments().includes('prod')) return 0;

  return deps.db.transaction(async transaction => {
    const links = await transaction
      .select()
      .from(monitoredLinks)
      .where(
        and(
          lte(monitoredLinks.nextCheckAt, now),
          eq(monitoredLinks.isActive, true),
          eq(monitoredLinks.isDeleted, false),
          eq(monitoredLinks.environment, 'prod')
        )
      )
      .orderBy(monitoredLinks.nextCheckAt)
      .limit(SCHEDULER_BATCH_SIZE)
      .for('update', { skipLocked: true });

    if (!links.length) return 0;

    // Occurrence IDs are based on stored due time, never the enqueue attempt.
    await transaction
      .insert(monitorChecks)
      .values(
        links.map(link => ({
          id: `${link.id}-${link.monitoringVersion}-${link.nextCheckAt.getTime()}`,
          linkId: link.id,
          monitoringVersion: link.monitoringVersion,
          scheduledAt: link.nextCheckAt,
          source: 'scheduled' as const,
          nextAttemptAt: now,
        }))
      )
      .onConflictDoNothing();

    await transaction
      .update(monitoredLinks)
      .set({
        intervalMs: sql`GREATEST(${monitoredLinks.intervalMs}, ${PRODUCTION_MONITORING_INTERVAL_MS})`,
        nextCheckAt: sql`${now.toISOString()}::timestamptz + (GREATEST(${monitoredLinks.intervalMs}, ${PRODUCTION_MONITORING_INTERVAL_MS}) * interval '1 millisecond')`,
        updatedAt: now,
      })
      .where(
        inArray(
          monitoredLinks.id,
          links.map(link => link.id)
        )
      );

    return links.length;
  });
}

export async function dispatchChecks(
  now = new Date(),
  overrides: Partial<SchedulerDependencies> = {}
): Promise<number> {
  const deps = { ...defaultDeps, ...overrides };
  const dueChecks = await deps.db.transaction(async transaction => {
    const rows = await transaction
      .select({ check: monitorChecks, link: monitoredLinks })
      .from(monitorChecks)
      .innerJoin(monitoredLinks, eq(monitorChecks.linkId, monitoredLinks.id))
      .where(
        and(
          isNull(monitorChecks.finishedAt),
          lte(monitorChecks.nextAttemptAt, now),
          inArray(monitoredLinks.environment, deps.enabledEnvironments()),
          or(
            isNull(monitorChecks.queueLeaseUntil),
            lte(monitorChecks.queueLeaseUntil, now)
          )
        )
      )
      .orderBy(monitorChecks.nextAttemptAt)
      .limit(SCHEDULER_BATCH_SIZE)
      .for('update', { of: monitorChecks, skipLocked: true });

    if (rows.length) {
      await transaction
        .update(monitorChecks)
        .set({
          queueLeaseUntil: new Date(now.getTime() + QUEUE_LEASE_MS),
        })
        .where(
          inArray(
            monitorChecks.id,
            rows.map(row => row.check.id)
          )
        );
    }
    return rows;
  });

  if (!dueChecks.length) return 0;

  const queue = deps.getQueue();
  try {
    await queue.addBulk(
      dueChecks.map(({ check, link }) => ({
        name: 'check',
        data: {
          checkId: check.id,
          linkId: link.id,
          convexUrlId: link.convexUrlId,
          longUrl: link.longUrl,
          shortUrl: link.shortUrl,
          environment: link.environment,
          source: check.source,
        },
        opts: {
          jobId: check.id,
          ...(check.source === 'manual' ? { priority: 1 } : {}),
        },
      }))
    );
    return dueChecks.length;
  } catch (error) {
    // Release leases so checks are retried on the next tick instead of waiting 60s.
    await deps.db
      .update(monitorChecks)
      .set({ queueLeaseUntil: null })
      .where(
        inArray(
          monitorChecks.id,
          dueChecks.map(row => row.check.id)
        )
      )
      .catch(releaseError =>
        logger.warn(
          { err: releaseError },
          'Failed to clear queue leases after dispatch error'
        )
      );
    throw error;
  }
}

// Keep the durable recovery window aligned with Convex 35-day receipt retention.
export async function pruneFinishedChecks(
  now = new Date(),
  overrides: Partial<Pick<SchedulerDependencies, 'db'>> = {}
): Promise<number> {
  if (pruning) return pruning;
  const database = overrides.db ?? defaultDb;
  const cutoff = new Date(now.getTime() - RETENTION_WINDOW_MS);

  pruning = (async () => {
    let totalDeleted = 0;
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
      const old = await database
        .select({ id: monitorChecks.id })
        .from(monitorChecks)
        .where(lte(monitorChecks.finishedAt, cutoff))
        .limit(PRUNE_BATCH_SIZE);
      if (!old.length) break;
      await database.delete(monitorChecks).where(
        inArray(
          monitorChecks.id,
          old.map(row => row.id)
        )
      );
      totalDeleted += old.length;
      if (old.length < PRUNE_BATCH_SIZE) break;
    }
    if (totalDeleted > 0) {
      logger.debug({ deleted: totalDeleted }, 'Pruned expired monitor checks');
    }
    return totalDeleted;
  })();

  try {
    return await pruning;
  } finally {
    pruning = null;
  }
}

export async function schedulerTick(): Promise<number> {
  if (running) return running;
  running = (async () => {
    await claimDueChecks();
    const queued = await dispatchChecks();
    serviceState.lastSchedulerSuccess = Date.now();
    logger.debug({ queued }, 'Monitor scheduler completed');
    return queued;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

export async function startScheduler(): Promise<void> {
  if (interval) return;
  await schedulerTick();
  interval = setInterval(() => {
    schedulerTick().catch(error =>
      logger.error({ err: error }, 'Monitor scheduler failed')
    );
  }, SCHEDULER_INTERVAL_MS);

  // Retention pruning runs on its own hourly schedule so it never blocks or degrades readiness.
  pruneInterval = setInterval(() => {
    pruneFinishedChecks().catch(error =>
      logger.warn({ err: error }, 'Monitor check retention pruning failed')
    );
  }, PRUNE_INTERVAL_MS);
  pruneInterval.unref();
}

export async function stopScheduler(): Promise<void> {
  if (interval) clearInterval(interval);
  interval = null;
  if (pruneInterval) clearInterval(pruneInterval);
  pruneInterval = null;
  await Promise.all([running?.catch(() => {}), pruning?.catch(() => {})]);
}
