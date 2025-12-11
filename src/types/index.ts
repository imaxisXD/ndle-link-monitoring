export interface RegisterLinkInput {
  convexUrlId: string;
  convexUserId: string;
  longUrl: string;
  shortUrl: string;
  intervalMs?: number;
}

export interface BatchRegisterInput {
  links: RegisterLinkInput[];
}

export interface ForceCheckInput {
  linkId: string;
}

export interface HealthCheckResult {
  statusCode: number;
  latencyMs: number;
  isHealthy: boolean;
  healthStatus: 'up' | 'down' | 'degraded';
  errorMessage?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}
