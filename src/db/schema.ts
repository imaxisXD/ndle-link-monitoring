import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const monitoredLinks = pgTable(
  'monitored_links',
  {
    // Primary key
    id: uuid('id').primaryKey().defaultRandom(),

    // Convex references (stored as strings since Convex IDs are strings)
    convexUrlId: text('convex_url_id').notNull(),
    convexUserId: text('convex_user_id').notNull(),

    // Environment (which Convex instance to write results to)
    environment: text('environment')
      .$type<'dev' | 'prod'>()
      .notNull()
      .default('prod'),

    // URLs
    longUrl: text('long_url').notNull(), // What we check
    shortUrl: text('short_url').notNull(), // For reference/logging

    // Scheduling
    intervalMs: integer('interval_ms').notNull().default(60000), // 1 min default
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull(),
    schedulerLockedUntil: timestamp('scheduler_locked_until', {
      withTimezone: true,
    }),

    // Status tracking
    isActive: boolean('is_active').notNull().default(true),
    currentStatus: text('current_status')
      .$type<'up' | 'down' | 'degraded' | 'pending'>()
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
    // Index for scheduler query: WHERE next_check_at <= NOW() AND is_active = true
    index('idx_next_check_active').on(table.nextCheckAt, table.isActive),
    // Index for looking up by Convex URL ID
    index('idx_convex_url_id').on(table.convexUrlId),
    // Index for user queries
    index('idx_convex_user_id').on(table.convexUserId),
  ]
);
export type MonitoredLink = typeof monitoredLinks.$inferSelect;
export type NewMonitoredLink = typeof monitoredLinks.$inferInsert;
