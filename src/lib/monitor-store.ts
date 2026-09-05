import { and, eq, gt, gte, sql } from 'drizzle-orm';
import { db } from '../db';
import { monitoredLinks, type NewMonitoredLink } from '../db/schema';
import { getEffectiveMonitoringIntervalMs, shouldRunContinuousMonitoring } from './monitor-policy';

export type Registration = {
  convexUrlId: string;
  convexUserId: string;
  longUrl: string;
  shortUrl: string;
  environment: 'dev' | 'prod';
  monitoringVersion?: number;
  intervalMs?: number;
};

export async function registerMonitor(input: Registration) {
  const version = input.monitoringVersion ?? 0;
  const values: NewMonitoredLink = {
    ...input,
    monitoringVersion: version,
    intervalMs: getEffectiveMonitoringIntervalMs(input.intervalMs),
    isActive: shouldRunContinuousMonitoring(input.environment),
    isDeleted: false,
    nextCheckAt: new Date(),
  };
  const [updated] = await db.insert(monitoredLinks).values(values).onConflictDoUpdate({
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
      updatedAt: new Date(),
    },
    // Equal deliveries do not reset the schedule or revive a deletion tombstone.
    setWhere: gt(sql`${version}`, monitoredLinks.monitoringVersion),
  }).returning({ id: monitoredLinks.id, monitoringVersion: monitoredLinks.monitoringVersion, isDeleted: monitoredLinks.isDeleted });
  return updated ?? await db.query.monitoredLinks.findFirst({
    columns: { id: true, monitoringVersion: true, isDeleted: true },
    where: and(eq(monitoredLinks.environment, input.environment), eq(monitoredLinks.convexUrlId, input.convexUrlId)),
  });
}

export async function unregisterMonitor(convexUrlId: string, environment: 'dev' | 'prod', version = 0) {
  // Retain a tombstone even if deletion arrives before registration.
  const [row] = await db.insert(monitoredLinks).values({
    convexUrlId, environment, monitoringVersion: version,
    convexUserId: '', longUrl: '', shortUrl: '', nextCheckAt: new Date(),
    isActive: false, isDeleted: true,
  }).onConflictDoUpdate({
    target: [monitoredLinks.environment, monitoredLinks.convexUrlId],
    set: { monitoringVersion: version, isActive: false, isDeleted: true, schedulerLockedUntil: null, updatedAt: new Date() },
    setWhere: gte(sql`${version}`, monitoredLinks.monitoringVersion),
  }).returning({ id: monitoredLinks.id, monitoringVersion: monitoredLinks.monitoringVersion, isDeleted: monitoredLinks.isDeleted });
  return row ?? await db.query.monitoredLinks.findFirst({
    columns: { id: true, monitoringVersion: true, isDeleted: true },
    where: and(eq(monitoredLinks.environment, environment), eq(monitoredLinks.convexUrlId, convexUrlId)),
  });
}
