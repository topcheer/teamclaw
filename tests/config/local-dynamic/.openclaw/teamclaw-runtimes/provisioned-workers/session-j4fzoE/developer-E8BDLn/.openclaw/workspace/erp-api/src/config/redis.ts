// src/config/redis.ts
import { createClient, RedisClientType } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient: RedisClientType = createClient({ url: redisUrl });

redisClient.on('error', (err) => console.error('Redis Client Error:', err));

export async function connectRedis(): Promise<void> {
  await redisClient.connect();
}

export async function disconnectRedis(): Promise<void> {
  await redisClient.quit();
}

/**
 * 获取分布式锁
 * @returns 是否成功获取锁
 */
export async function acquireLock(
  key: string,
  ttlMs: number = 10000
): Promise<boolean> {
  const result = await redisClient.set(key, 'locked', {
    PX: ttlMs,
    NX: true,
  });
  return result === 'OK';
}

/**
 * 释放分布式锁
 */
export async function releaseLock(key: string): Promise<void> {
  await redisClient.del(key);
}

export default redisClient;
