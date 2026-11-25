import type { Job } from 'bullmq';
import { and, eq, gt, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db';
import { monitoredLinks, monitorChecks, type MonitorCheck } from '../db/schema';
import { createWorker, type HealthCheckJob } from '../queue/factory';
import { checkUrl as defaultCheckUrl } from '../lib/checker';
import { getConvexClient as defaultGetConvexClient } from '../lib/convex';
import {
  createWorkerLogger as defaultCreateWorkerLogger,
  logger,
} from '../lib/logger';
import { recordHealthCheck } from '../types/convexApiTypes';
import {
  computeDeliveryRetryDelayMs,
  getDeliveryRetryDecision,
  shouldDisableMissingMonitor,
  shouldRunMonitoringJob,
} from '../lib/monitor-policy';
import { serviceState } from '../lib/service-state';
import { CHECK_TIMEOUT_MS } from '../lib/constants';
import { enabledEnvironments as defaultEnabledEnvironments } from '../lib/config';

export interface WorkerDependencies {
  db: typeof defaultDb;
  checkUrl: typeof defaultCheckUrl;
  getConvexClient: typeof defaultGetConvexClient;
  createWorkerLogger: typeof defaultCreateWorkerLogger;
  enabledEnvironments: typeof defaultEnabledEnvironments;
  getSharedSecret: () => string | undefined;
  random: () => number;
}

const defaultDeps: WorkerDependencies = {
  db: defaultDb,
  checkUrl: defaultCheckUrl,
  getConvexClient: defaultGetConvexClient,
  createWorkerLogger: defaultCreateWorkerLogger,
  enabledEnvironments: defaultEnabledEnvironments,
  getSharedSecret: () => process.env.MONITORING_SHARED_SECRET,
  random: Math.random,
};

// A newer result for the same link already reached Convex, so this one can no longer change the current status.
async function hasNewerDeliveredCheck(
  database: typeof defaultDb,
  check: MonitorCheck
): Promise<boolean> {
  const [newer] = await database
    .select({ id: monitorChecks.id })
    .from(monitorChecks)
    .where(
      and(
        eq(monitorChecks.linkId, check.linkId),
        ne(monitorChecks.id, check.id),
        gt(monitorChecks.measuredAt, check.measuredAt ?? check.scheduledAt),
        isNotNull(monitorChecks.finishedAt),
        isNull(monitorChecks.failedAt),
        isNull(monitorChecks.lastError)
      )
    )
    .limit(1);
  return Boolean(newer);
}

export function createJobProcessor(overrides: Partial<WorkerDependencies> = {}) {
  const deps: WorkerDependencies = { ...defaultDeps, ...overrides };

  return async function processJob(
    job: Pick<Job<HealthCheckJob>, 'id' | 'data'>
  ): Promise<void> {
    const checkId = job.data.checkId;
    const [row] = await deps.db
      .select({ check: monitorChecks, link: monitoredLinks })
      .from(monitorChecks)
      .innerJoin(monitoredLinks, eq(monitorChecks.linkId, monitoredLinks.id))
      .where(eq(monitorChecks.id, checkId))
      .limit(1);

    if (!row || row.check.finishedAt) return;
    let { check } = row;
    const { link } = row;
    const log = deps.createWorkerLogger(checkId, link.id);

    if (
      link.isDeleted ||
      !deps.enabledEnvironments().includes(link.environment) ||
      link.monitoringVersion !== check.monitoringVersion ||
      !shouldRunMonitoringJob(link.environment, check.source) ||
      (check.source === 'scheduled' && !link.isActive)
    ) {
      await deps.db
        .update(monitorChecks)
        .set({
          finishedAt: new Date(),
          lastError: 'Monitor was removed or changed',
        })
        .where(eq(monitorChecks.id, checkId));
      return;
    }

    try {
      let justMeasured = false;
      if (!check.result || !check.measuredAt) {
        const now = new Date();
        const [claimed] = await deps.db
          .update(monitorChecks)
          .set({
            measurementLeaseUntil: new Date(
              now.getTime() + Math.max(CHECK_TIMEOUT_MS * 2, 60_000)
            ),
          })
          .where(
            and(
              eq(monitorChecks.id, checkId),
              isNull(monitorChecks.result),
              or(
                isNull(monitorChecks.measurementLeaseUntil),
                lte(monitorChecks.measurementLeaseUntil, now)
              )
            )
          )
          .returning();

        // Another worker already holds the measurement lease; exit cleanly without corrupting retry state.
        if (!claimed) {
          log.debug('Check is already being measured by another worker');
          return;
        }

        const result = await deps.checkUrl(link.longUrl, log);
        const measuredAt = new Date();
        const savedCheck = await deps.db.transaction(async transaction => {
          const [saved] = await transaction
            .update(monitorChecks)
            .set({ result, measuredAt, measurementLeaseUntil: null })
            .where(and(eq(monitorChecks.id, checkId), isNull(monitorChecks.result)))
            .returning();
          if (!saved) return null;

          await transaction
            .update(monitoredLinks)
            .set({
              lastCheckedAt: measuredAt,
              currentStatus: result.healthStatus,
              lastStatusCode: result.statusCode,
              lastLatencyMs: result.latencyMs,
              consecutiveFailures:
                result.healthStatus === 'unknown'
                  ? sql`${monitoredLinks.consecutiveFailures}`
                  : result.isHealthy
                    ? 0
                    : sql`${monitoredLinks.consecutiveFailures} + 1`,
              updatedAt: measuredAt,
            })
            .where(
              and(
                eq(monitoredLinks.id, link.id),
                eq(monitoredLinks.monitoringVersion, check.monitoringVersion),
                eq(monitoredLinks.isDeleted, false),
                or(
                  isNull(monitoredLinks.lastCheckedAt),
                  lte(monitoredLinks.lastCheckedAt, measuredAt)
                )
              )
            );
          return saved;
        });

        if (savedCheck) {
          check = savedCheck;
        } else {
          const [existing] = await deps.db
            .select()
            .from(monitorChecks)
            .where(eq(monitorChecks.id, checkId))
            .limit(1);
          if (!existing || existing.finishedAt) return;
          check = existing;
        }
        justMeasured = true;
      }

      if (!check.result || !check.measuredAt) {
        throw new Error('The check result was not saved');
      }

      if (justMeasured) {
        // A deletion or newer registration can arrive while the destination responds.
        const [current] = await deps.db
          .select({
            isDeleted: monitoredLinks.isDeleted,
            monitoringVersion: monitoredLinks.monitoringVersion,
          })
          .from(monitoredLinks)
          .where(eq(monitoredLinks.id, link.id))
          .limit(1);

        if (
          !current ||
          current.isDeleted ||
          current.monitoringVersion !== check.monitoringVersion
        ) {
          await deps.db
            .update(monitorChecks)
            .set({
              finishedAt: new Date(),
              lastError: 'Monitor changed during the check',
            })
            .where(eq(monitorChecks.id, checkId));
          return;
        }
      }

      const sharedSecret = deps.getSharedSecret();
      if (!sharedSecret) {
        throw new Error('MONITORING_SHARED_SECRET is required');
      }

      // skipQueue: deliveries run in parallel instead of behind the shared client's mutation queue.
      const response = await deps.getConvexClient(link.environment).mutation(
        recordHealthCheck,
        {
          ...check.result,
          checkId,
          monitoringVersion: check.monitoringVersion,
          sharedSecret,
          urlId: link.convexUrlId,
          shortUrl: link.shortUrl,
          longUrl: link.longUrl,
          checkedAt: check.measuredAt.getTime(),
        },
        { skipQueue: true }
      );

      if (response?.success !== true && !shouldDisableMissingMonitor(response)) {
        throw new Error('Convex did not confirm the check result');
      }

      const finishedAt = new Date();
      if (shouldDisableMissingMonitor(response)) {
        await deps.db.transaction(async transaction => {
          await transaction
            .update(monitoredLinks)
            .set({ isActive: false, isDeleted: true, updatedAt: finishedAt })
            .where(
              and(
                eq(monitoredLinks.id, link.id),
                eq(monitoredLinks.monitoringVersion, check.monitoringVersion)
              )
            );
          await transaction
            .update(monitorChecks)
            .set({ finishedAt, queueLeaseUntil: null, lastError: null })
            .where(eq(monitorChecks.id, checkId));
        });
      } else {
        await deps.db
          .update(monitorChecks)
          .set({ finishedAt, queueLeaseUntil: null, lastError: null })
          .where(eq(monitorChecks.id, checkId));
      }
    } catch (error) {
      const now = new Date();
      const attempts = check.deliveryAttempts + 1;
      const superseded = await hasNewerDeliveredCheck(deps.db, check).catch(
        () => false
      );
      const decision = getDeliveryRetryDecision(
        attempts,
        check.measuredAt ?? check.scheduledAt,
        now,
        superseded
      );
      const retryDelayMs = computeDeliveryRetryDelayMs(attempts, deps.random);

      await deps.db
        .update(monitorChecks)
        .set({
          deliveryAttempts: sql`${monitorChecks.deliveryAttempts} + 1`,
          nextAttemptAt: new Date(now.getTime() + retryDelayMs),
          queueLeaseUntil: null,
          lastError:
            error instanceof Error ? error.message : 'Check delivery failed',
          // Finished rows are never dispatched again; failedAt records that Convex never confirmed the result.
          ...(decision === 'retry' ? {} : { finishedAt: now, failedAt: now }),
        })
        .where(eq(monitorChecks.id, checkId));

      if (decision === 'superseded') {
        log.warn(
          { err: error, attempts },
          'Check result superseded by a newer delivered check; retries stopped'
        );
      } else if (decision !== 'retry') {
        log.error(
          { err: error, attempts, reason: decision },
          'Check result delivery failed permanently'
        );
      }
      throw error;
    }
  };
}

export const processJob = createJobProcessor();

export interface WorkerLike {
  isRunning(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface BlockingClientLike {
  status?: string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export function attachWorkerReadiness(
  workerInstance: WorkerLike,
  blockingClient: BlockingClientLike
): void {
  const isBlockingReady = () => blockingClient.status === 'ready';
  const markReadyIfRunning = () => {
    if (workerInstance.isRunning()) serviceState.workerReady = true;
  };
  const syncReadiness = () => {
    serviceState.workerReady = workerInstance.isRunning() && isBlockingReady();
  };

  workerInstance.on('ready', markReadyIfRunning);
  workerInstance.on('completed', markReadyIfRunning);
  workerInstance.on('drained', markReadyIfRunning);
  workerInstance.on('closing', () => {
    serviceState.workerReady = false;
  });
  workerInstance.on('closed', () => {
    serviceState.workerReady = false;
  });
  // Transient errors on non-blocking connections must not permanently latch workerReady=false.
  workerInstance.on('error', syncReadiness);

  blockingClient.on('ready', markReadyIfRunning);
  blockingClient.on('close', () => {
    serviceState.workerReady = false;
  });
  blockingClient.on('end', () => {
    serviceState.workerReady = false;
  });
  blockingClient.on('reconnecting', () => {
    serviceState.workerReady = false;
  });

  syncReadiness();
}

let worker: ReturnType<typeof createWorker> | null = null;

export async function startWorker(): Promise<void> {
  if (worker) return;
  worker = createWorker(processJob);
  const blockingClient = await worker.waitUntilReady();
  attachWorkerReadiness(worker, blockingClient);
  serviceState.workerReady = worker.isRunning();
  logger.info('Monitor worker started');
}

export async function shutdownWorker(): Promise<void> {
  serviceState.workerReady = false;
  await worker?.close();
  worker = null;
}
