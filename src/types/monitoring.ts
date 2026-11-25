export type MonitoringEnvironment = 'dev' | 'prod';
export type MonitoringJobSource = 'scheduled' | 'manual';
export type HealthStatus = 'up' | 'down' | 'degraded' | 'unknown';
export type LinkStatus = HealthStatus | 'pending';

export interface CheckResult {
  statusCode: number;
  latencyMs: number;
  isHealthy: boolean;
  healthStatus: HealthStatus;
  errorMessage?: string;
}
