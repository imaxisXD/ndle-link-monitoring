export function enabledEnvironments(): Array<'dev' | 'prod'> {
  const values = (process.env.MONITORING_ENVIRONMENTS || 'prod').split(',').map(value => value.trim());
  if (values.some(value => value !== 'dev' && value !== 'prod')) {
    throw new Error('MONITORING_ENVIRONMENTS must contain prod, dev, or both');
  }
  return [...new Set(values)] as Array<'dev' | 'prod'>;
}

export function validateConfiguration(runWorker: boolean): void {
  for (const name of ['DATABASE_URL', 'REDIS_URL', 'MONITORING_API_SECRET']) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  if (runWorker) {
    if (!process.env.MONITORING_SHARED_SECRET) throw new Error('MONITORING_SHARED_SECRET is required');
    for (const environment of enabledEnvironments()) {
      const name = `CONVEX_URL_${environment.toUpperCase()}`;
      if (!process.env[name]) throw new Error(`${name} is required for ${environment} checks`);
    }
  }
}
