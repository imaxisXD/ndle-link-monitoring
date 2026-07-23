import { describe, expect, test } from 'bun:test';
import {
  getEffectiveMonitoringIntervalMs,
  PRODUCTION_MONITORING_INTERVAL_MS,
  shouldDisableMissingMonitor,
  shouldRunContinuousMonitoring,
  shouldRunMonitoringJob,
} from './monitor-policy';

describe('monitor policy', () => {
  test('continuous checks run only in production', () => {
    expect(shouldRunContinuousMonitoring('prod')).toBe(true);
    expect(shouldRunContinuousMonitoring('dev')).toBe(false);
  });

  test('manual checks remain available in development', () => {
    expect(shouldRunMonitoringJob('dev', 'manual')).toBe(true);
    expect(shouldRunMonitoringJob('dev', 'scheduled')).toBe(false);
  });

  test('production checks cannot run more often than every 30 minutes', () => {
    expect(getEffectiveMonitoringIntervalMs(5 * 60 * 1000)).toBe(
      PRODUCTION_MONITORING_INTERVAL_MS
    );
    expect(getEffectiveMonitoringIntervalMs(undefined)).toBe(
      PRODUCTION_MONITORING_INTERVAL_MS
    );
    expect(getEffectiveMonitoringIntervalMs(60 * 60 * 1000)).toBe(
      60 * 60 * 1000
    );
  });

  test('only a missing Convex URL permanently disables a monitor', () => {
    expect(
      shouldDisableMissingMonitor({
        success: false,
        reason: 'url_not_found',
      })
    ).toBe(true);
    expect(shouldDisableMissingMonitor({ success: true })).toBe(false);
  });
});
