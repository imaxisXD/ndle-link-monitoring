import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  bigint,
  jsonb,
} from 'drizzle-orm/pg-core';
import type {
  CheckResult,
  LinkStatus,
  MonitoringEnvironment,
  MonitoringJobSource,
} from '../types/monitoring';

export const monitoredLinks = pgTable(
  'monitored_links',
  {
    // Primary key
    id: uuid('id').primaryKey().defaultRandom(),

    // Convex references (stored as strings since Convex IDs are strings)
    convexUrlId: text('convex_url_id').notNull(),
    convexUserId: text('convex_user_id').notNull(),
    monitoringVersion: bigint('monitoring_version', { mode: 'number' })
      .notNull()
      .default(0),
    isDeleted: boolean('is_deleted').notNull().default(false),

    // Environment (which Convex instance to write results to)
    environment: text('environment')
      .$type<MonitoringEnvironment>()
      .notNull()
      .default('prod'),

    // URLs
    longUrl: text('long_url').notNull(), // What we check
    shortUrl: text('short_url').notNull(), // For reference/logging

    // Scheduling
    intervalMs: integer('interval_ms').notNull().default(1800000), // 30 minutes
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull(),
    // Retained nullable for zero-downtime deploy compatibility; no longer written by app code.
    schedulerLockedUntil: timestamp('scheduler_locked_until', {
      withTimezone: true,
    }),

    // Status tracking
    isActive: boolean('is_active').notNull().default(true),
    currentStatus: text('current_status')
      .$type<LinkStatus>()
      .default('pending'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastLatencyMs: integer('last_latency_ms'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    // Audit
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    // Legacy index retained until safely dropped in a later release.
    index('idx_next_check_active').on(table.nextCheckAt, table.isActive),
    // Partial index for scheduler claims of active non-deleted links by environment and due time.
    index('idx_monitored_links_due')
      .on(table.environment, table.nextCheckAt)
      .where(sql`${table.isActive} = true AND ${table.isDeleted} = false`),
    // UNIQUE index for looking up by Convex URL ID (enables onConflictDoUpdate)
    uniqueIndex('idx_environment_convex_url_id').on(
      table.environment,
      table.convexUrlId
    ),
  ]
);
export type NewMonitoredLink = typeof monitoredLinks.$inferInsert;

// Redis can be rebuilt from unfinished rows; measurements survive delivery failures.
export const monitorChecks = pgTable(
  'monitor_checks',
  {
    id: text('id').primaryKey(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => monitoredLinks.id),
    monitoringVersion: bigint('monitoring_version', {
      mode: 'number',
    }).notNull(),
    source: text('source').$type<MonitoringJobSource>().notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    measuredAt: timestamp('measured_at', { withTimezone: true }),
    result: jsonb('result').$type<CheckResult>(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    queueLeaseUntil: timestamp('queue_lease_until', { withTimezone: true }),
    measurementLeaseUntil: timestamp('measurement_lease_until', {
      withTimezone: true,
    }),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    lastError: text('last_error'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // Set with finishedAt when delivery stopped without Convex confirming the result.
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  table => [
    index('idx_monitor_checks_due').on(table.finishedAt, table.nextAttemptAt),
    index('idx_monitor_checks_link').on(table.linkId),
    index('idx_monitor_checks_delivered')
      .on(table.linkId, table.measuredAt.desc())
      .where(
        sql`${table.finishedAt} IS NOT NULL AND ${table.failedAt} IS NULL AND ${table.lastError} IS NULL`
      ),
    index('idx_monitor_checks_pending')
      .on(table.nextAttemptAt)
      .where(sql`${table.finishedAt} IS NULL`),
    index('idx_monitor_checks_finished')
      .on(table.finishedAt)
      .where(sql`${table.finishedAt} IS NOT NULL`),
  ]
);
export type MonitorCheck = typeof monitorChecks.$inferSelect;
