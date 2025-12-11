// Scheduler configuration
export const SCHEDULER_INTERVAL_MS = parseInt(
  process.env.SCHEDULER_INTERVAL_MS || '10000'
);
export const SCHEDULER_BATCH_SIZE = parseInt(
  process.env.SCHEDULER_BATCH_SIZE || '500'
);
export const LOCK_DURATION_MS = 30000; // 30 seconds lock to prevent double-scheduling

// Worker configuration
export const WORKER_CONCURRENCY = parseInt(
  process.env.WORKER_CONCURRENCY || '10'
);
export const QUEUE_RATE_LIMIT_MAX = 100;
export const QUEUE_RATE_LIMIT_DURATION = 1000;

// Health check configuration
export const CHECK_TIMEOUT_MS = parseInt(
  process.env.CHECK_TIMEOUT_MS || '10000'
);
export const DEGRADED_THRESHOLD_MS = parseInt(
  process.env.DEGRADED_THRESHOLD_MS || '3000'
);

// Default monitoring interval for new links
export const DEFAULT_INTERVAL_MS = 60000; // 1 minute

// Tier-based intervals (for future use)
export const TIER_INTERVALS = {
  free: 300000, // 5 minutes
  pro: 60000, // 1 minute
  enterprise: 30000, // 30 seconds
} as const;
