import { describe, expect, test } from 'bun:test';
import {
  getDeliveryRetryDecision,
  getEffectiveMonitoringIntervalMs,
  MAX_DELIVERY_AGE_MS,
  MAX_DELIVERY_ATTEMPTS,
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

  test('delivery retries stop after 300 attempts or 24 hours, whichever comes first', () => {
    const storedAt = new Date('2026-09-01T00:00:00Z');
    const after = (ms: number) => new Date(storedAt.getTime() + ms);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(300);
    expect(MAX_DELIVERY_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(getDeliveryRetryDecision(1, storedAt, after(2000), false)).toBe(
      'retry'
    );
    expect(
      getDeliveryRetryDecision(
        MAX_DELIVERY_ATTEMPTS - 1,
        storedAt,
        after(MAX_DELIVERY_AGE_MS - 1),
        false
      )
    ).toBe('retry');
    // A few hours of failed deliveries no longer drops a result.
    expect(
      getDeliveryRetryDecision(40, storedAt, after(3 * 60 * 60 * 1000), false)
    ).toBe('retry');
    expect(
      getDeliveryRetryDecision(
        MAX_DELIVERY_ATTEMPTS,
        storedAt,
        after(60 * 60 * 1000),
        false
      )
    ).toBe('attempt_limit');
    expect(
      getDeliveryRetryDecision(
        MAX_DELIVERY_ATTEMPTS + 5,
        storedAt,
        after(MAX_DELIVERY_AGE_MS * 2),
        false
      )
    ).toBe('attempt_limit');
    expect(
      getDeliveryRetryDecision(3, storedAt, after(MAX_DELIVERY_AGE_MS), false)
    ).toBe('age_limit');
  });

  test('a result superseded by a newer delivered check stops retrying at once', () => {
    const storedAt = new Date('2026-09-01T00:00:00Z');
    expect(
      getDeliveryRetryDecision(
        1,
        storedAt,
        new Date(storedAt.getTime() + 1000),
        true
      )
    ).toBe('superseded');
  });
});
