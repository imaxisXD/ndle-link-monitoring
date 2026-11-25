import { makeFunctionReference } from 'convex/server';
import type { RecordHealthCheckResult } from '../lib/monitor-policy';
import type { HealthStatus } from './monitoring';

export const recordHealthCheck = makeFunctionReference<
  'mutation',
  {
    checkedAt: number;
    errorMessage?: string;
    healthStatus: HealthStatus;
    checkId: string;
    monitoringVersion: number;
    isHealthy: boolean;
    latencyMs: number;
    longUrl: string;
    sharedSecret: string;
    shortUrl: string;
    statusCode: number;
    urlId: string;
  },
  RecordHealthCheckResult
>('linkHealth:recordHealthCheck');
