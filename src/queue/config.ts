import type { RedisOptions } from 'ioredis';

export const redisConfig: RedisOptions = {
  // BullMQ requires maxRetriesPerRequest to be null
  maxRetriesPerRequest: null,
  // Enable dual-stack (IPv4 + IPv6) lookup
  family: 0,
};

export function getConnectionUrl(): string {
  return process.env.REDIS_URL || 'redis://localhost:6379';
}
