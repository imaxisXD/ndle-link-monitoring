import type { CheckResult } from '../types/monitoring';
import { DEGRADED_THRESHOLD_MS } from './constants';

// Servers that mishandle HEAD often answer these; a GET decides the result.
export const HEAD_FALLBACK_CODES = new Set([400, 403, 404, 405, 406, 501]);

// Authentication, bot protection and rate limiting say nothing about whether visitors can reach the page.
export const INCONCLUSIVE_CODES = new Set([401, 403, 405, 406, 429, 503]);

export function shouldFallbackToGet(status: number): boolean {
  return HEAD_FALLBACK_CODES.has(status);
}

export function classifyResponse(
  status: number,
  latencyMs: number
): Pick<CheckResult, 'isHealthy' | 'healthStatus'> {
  const isHealthy = status >= 200 && status < 400;
  if (isHealthy) {
    return {
      isHealthy,
      healthStatus: latencyMs > DEGRADED_THRESHOLD_MS ? 'degraded' : 'up',
    };
  }
  return {
    isHealthy,
    healthStatus: INCONCLUSIVE_CODES.has(status) ? 'unknown' : 'down',
  };
}
