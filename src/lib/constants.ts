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
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
