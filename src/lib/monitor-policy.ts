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
