import { Pool } from 'pg';
import Redis from 'ioredis';

// 从环境变量读取连接配置，提供合理的开发默认值
const pgConfig = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || 'erp',
  user: process.env.PG_USER || 'erp',
  password: process.env.PG_PASSWORD || 'erp',
};

export const pool = new Pool({
  ...pgConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

/** 分布式锁工具 — 基于 Redis SET NX EX */
export async function acquireLock(
  key: string,
  ttlSeconds: number = 10
): Promise<string | null> {
  const lockId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ok = await redis.set(`lock:${key}`, lockId, 'NX', 'EX', ttlSeconds);
  return ok === 'OK' ? lockId : null;
}

export async function releaseLock(key: string, lockId: string): Promise<void> {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(script, 1, `lock:${key}`, lockId);
}
