export type MonitoringEnvironment = 'dev' | 'prod';
export type MonitoringJobSource = 'scheduled' | 'manual';

export const PRODUCTION_MONITORING_INTERVAL_MS = 30 * 60 * 1000;

export type RecordHealthCheckResult =
  | { success: true }
  | { success: false; reason: 'url_not_found' };

export function shouldRunContinuousMonitoring(
  environment: MonitoringEnvironment
): boolean {
  return environment === 'prod';
}

export function shouldRunMonitoringJob(
  environment: MonitoringEnvironment,
  source: MonitoringJobSource = 'scheduled'
): boolean {
  return source === 'manual' || shouldRunContinuousMonitoring(environment);
}

export function getEffectiveMonitoringIntervalMs(
  requestedIntervalMs: number | undefined
): number {
  if (
    requestedIntervalMs === undefined ||
    !Number.isFinite(requestedIntervalMs)
  ) {
    return PRODUCTION_MONITORING_INTERVAL_MS;
  }

  return Math.max(
    Math.round(requestedIntervalMs),
    PRODUCTION_MONITORING_INTERVAL_MS
  );
}

export function shouldDisableMissingMonitor(
  result: RecordHealthCheckResult
): boolean {
  return result.success === false && result.reason === 'url_not_found';
}

// With the five-minute maximum backoff, 300 attempts span about a day, so the
// 24-hour limit decides: a Convex outage of a few hours drops no results.
export const MAX_DELIVERY_ATTEMPTS = 300;
export const MAX_DELIVERY_AGE_MS = 24 * 60 * 60 * 1000;

export type DeliveryRetryDecision =
  | 'retry'
  | 'attempt_limit'
  | 'age_limit'
  | 'superseded';

// A stored result stops retrying after 300 attempts or 24 hours, whichever comes first,
// or as soon as a newer result for the same link has been delivered.
export function getDeliveryRetryDecision(
  attempts: number,
  storedAt: Date,
  now: Date,
  superseded: boolean
): DeliveryRetryDecision {
  if (superseded) return 'superseded';
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return 'attempt_limit';
  if (now.getTime() - storedAt.getTime() >= MAX_DELIVERY_AGE_MS) {
    return 'age_limit';
  }
  return 'retry';
}
