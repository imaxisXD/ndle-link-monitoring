import { RedisOptions } from 'ioredis';

export const redisConfig: RedisOptions = {
  // BullMQ requires maxRetriesPerRequest to be null
  maxRetriesPerRequest: null,
  // Enable dual-stack (IPv4 + IPv6) lookup for Railway compatibility
  family: 0,
};

export const connectionUrl = process.env.REDIS_URL || 'redis://localhost:6379';
