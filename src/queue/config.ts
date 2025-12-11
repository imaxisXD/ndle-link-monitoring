import { RedisOptions } from 'ioredis';

export const redisConfig: RedisOptions = {
  // BullMQ requires maxRetriesPerRequest to be null
  maxRetriesPerRequest: null,
};

export const connectionUrl = process.env.REDIS_URL || 'redis://localhost:6379';
