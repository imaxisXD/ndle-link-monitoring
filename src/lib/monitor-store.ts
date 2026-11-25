import { and, eq, gt, gte, sql } from 'drizzle-orm';
import { db } from '../db';
import { monitoredLinks, type NewMonitoredLink } from '../db/schema';
import type { LinkStatus, MonitoringEnvironment } from '../types/monitoring';
import {
  getEffectiveMonitoringIntervalMs,
  shouldRunContinuousMonitoring,
} from './monitor-policy';

export type Registration = {
  convexUrlId: string;
  convexUserId: string;
  longUrl: string;
  shortUrl: string;
  environment: MonitoringEnvironment;
  monitoringVersion?: number;
  intervalMs?: number;
};

export type MonitorReceipt = {
  id: string;
  monitoringVersion: number;
  isDeleted: boolean;
};

const receiptReturning = {
  id: monitoredLinks.id,
  monitoringVersion: monitoredLinks.monitoringVersion,
  isDeleted: monitoredLinks.isDeleted,
};

export async function readMonitorReceipt(
  environment: MonitoringEnvironment,
  convexUrlId: string
): Promise<MonitorReceipt | undefined> {
  return db.query.monitoredLinks.findFirst({
    columns: { id: true, monitoringVersion: true, isDeleted: true },
    where: and(
      eq(monitoredLinks.environment, environment),
      eq(monitoredLinks.convexUrlId, convexUrlId)
    ),
  });
}

export async function registerMonitor(
  input: Registration
): Promise<MonitorReceipt | undefined> {
  const version = input.monitoringVersion ?? 0;
  const now = new Date();
  const values: NewMonitoredLink = {
    ...input,
    monitoringVersion: version,
    intervalMs: getEffectiveMonitoringIntervalMs(input.intervalMs),
    isActive: shouldRunContinuousMonitoring(input.environment),
    isDeleted: false,
    nextCheckAt: now,
  };
  // Reset stale check status whenever the target URL changes or a deleted monitor is revived.
  const shouldResetStatus = sql`(${monitoredLinks.isDeleted} = true OR ${monitoredLinks.longUrl} IS DISTINCT FROM EXCLUDED.long_url)`;

  const [updated] = await db
    .insert(monitoredLinks)
    .values(values)
    .onConflictDoUpdate({
      target: [monitoredLinks.environment, monitoredLinks.convexUrlId],
      set: {
        convexUserId: values.convexUserId,
        longUrl: values.longUrl,
        shortUrl: values.shortUrl,
        monitoringVersion: version,
        intervalMs: values.intervalMs,
        isActive: values.isActive,
        isDeleted: false,
        nextCheckAt: values.nextCheckAt,
        currentStatus: sql<LinkStatus>`CASE WHEN ${shouldResetStatus} THEN 'pending' ELSE ${monitoredLinks.currentStatus} END`,
        lastCheckedAt: sql<Date | null>`CASE WHEN ${shouldResetStatus} THEN NULL ELSE ${monitoredLinks.lastCheckedAt} END`,
        lastStatusCode: sql<number | null>`CASE WHEN ${shouldResetStatus} THEN NULL ELSE ${monitoredLinks.lastStatusCode} END`,
        lastLatencyMs: sql<number | null>`CASE WHEN ${shouldResetStatus} THEN NULL ELSE ${monitoredLinks.lastLatencyMs} END`,
        consecutiveFailures: sql<number>`CASE WHEN ${shouldResetStatus} THEN 0 ELSE ${monitoredLinks.consecutiveFailures} END`,
        updatedAt: now,
      },
      // Equal deliveries do not reset the schedule or revive a deletion tombstone.
      setWhere: gt(sql`${version}`, monitoredLinks.monitoringVersion),
    })
    .returning(receiptReturning);

  return updated ?? readMonitorReceipt(input.environment, input.convexUrlId);
}

export async function unregisterMonitor(
  convexUrlId: string,
  environment: MonitoringEnvironment,
  version = 0
): Promise<MonitorReceipt | undefined> {
  const now = new Date();
  // Retain a tombstone even if deletion arrives before registration.
  const [row] = await db
    .insert(monitoredLinks)
    .values({
      convexUrlId,
      environment,
      monitoringVersion: version,
      convexUserId: '',
      longUrl: '',
      shortUrl: '',
      nextCheckAt: now,
      isActive: false,
      isDeleted: true,
    })
    .onConflictDoUpdate({
      target: [monitoredLinks.environment, monitoredLinks.convexUrlId],
      set: {
        monitoringVersion: version,
        isActive: false,
        isDeleted: true,
        updatedAt: now,
      },
      setWhere: gte(sql`${version}`, monitoredLinks.monitoringVersion),
    })
    .returning(receiptReturning);

  return row ?? readMonitorReceipt(environment, convexUrlId);
}
