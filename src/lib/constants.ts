export function parsePositiveIntEnv(
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(
      max < Number.MAX_SAFE_INTEGER
        ? `${name} must be an integer between 1 and ${max}`
        : `${name} must be a positive integer`
    );
  }
  return parsed;
}

// Scheduler configuration
export const SCHEDULER_INTERVAL_MS = parsePositiveIntEnv(
  'SCHEDULER_INTERVAL_MS',
  10_000
);
export const SCHEDULER_BATCH_SIZE = parsePositiveIntEnv(
  'SCHEDULER_BATCH_SIZE',
  500
);

// Worker configuration
export const WORKER_CONCURRENCY = parsePositiveIntEnv('WORKER_CONCURRENCY', 10);
export const QUEUE_RATE_LIMIT_MAX = 100;
export const QUEUE_RATE_LIMIT_DURATION = 1000;

// Health check configuration
export const CHECK_TIMEOUT_MS = parsePositiveIntEnv('CHECK_TIMEOUT_MS', 10_000);
export const DEGRADED_THRESHOLD_MS = parsePositiveIntEnv(
  'DEGRADED_THRESHOLD_MS',
  3_000
);
