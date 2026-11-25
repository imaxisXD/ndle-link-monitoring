import type { MonitoringEnvironment } from '../types/monitoring';
import { parsePositiveIntEnv } from './constants';
import { configuredServerAddresses } from './server-addresses';

export function enabledEnvironments(): MonitoringEnvironment[] {
  const values = (process.env.MONITORING_ENVIRONMENTS || 'prod')
    .split(',')
    .map(value => value.trim());
  if (values.some(value => value !== 'dev' && value !== 'prod')) {
    throw new Error('MONITORING_ENVIRONMENTS must contain prod, dev, or both');
  }
  return [...new Set(values)] as MonitoringEnvironment[];
}

export function validateNumericConfiguration(): void {
  parsePositiveIntEnv('PORT', 3001, 65535);
  parsePositiveIntEnv('SCHEDULER_INTERVAL_MS', 10_000);
  parsePositiveIntEnv('SCHEDULER_BATCH_SIZE', 500);
  parsePositiveIntEnv('WORKER_CONCURRENCY', 10);
  parsePositiveIntEnv('CHECK_TIMEOUT_MS', 10_000);
  parsePositiveIntEnv('DEGRADED_THRESHOLD_MS', 3_000);
}

export function validateConfiguration(runWorker: boolean): void {
  for (const name of ['DATABASE_URL', 'REDIS_URL', 'MONITORING_API_SECRET']) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  validateNumericConfiguration();
  const environments = enabledEnvironments();
  configuredServerAddresses();
  if (runWorker) {
    if (!process.env.MONITORING_SHARED_SECRET) {
      throw new Error('MONITORING_SHARED_SECRET is required');
    }
    for (const environment of environments) {
      const name = `CONVEX_URL_${environment.toUpperCase()}`;
      if (!process.env[name]) {
        throw new Error(`${name} is required for ${environment} checks`);
      }
    }
  }
}
