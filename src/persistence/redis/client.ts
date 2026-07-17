/**
 * Redis Hot Cache and Locks
 * 
 * Redis handles:
 * - Hot state cache (Engineer Loop, Planner items in-flight)
 * - Distributed locks for concurrent access
 * - Idempotency keys for retries
 * - Rate limiting
 * - Short-lived NCA attention state
 */

import * as redis from 'redis';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

export class RedisClient {
  private client: redis.RedisClientType;
  private keyPrefix: string;

  constructor(config: RedisConfig) {
    this.keyPrefix = config.keyPrefix || 'cherry:';
    this.client = redis.createClient({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db || 0,
    }) as any;
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      console.log('✓ Connected to Redis');
    } catch (error) {
      console.error('Redis connection failed:', error);
      throw error;
    }
  }

  /**
   * Set value with TTL
   */
  async set(
    key: string,
    value: any,
    ttlSeconds?: number
  ): Promise<void> {
    const fullKey = this.prefixKey(key);
    const serialized = JSON.stringify(value);

    if (ttlSeconds) {
      await this.client.setEx(fullKey, ttlSeconds, serialized);
    } else {
      await this.client.set(fullKey, serialized);
    }
  }

  /**
   * Get value
   */
  async get<T = any>(key: string): Promise<T | null> {
    const fullKey = this.prefixKey(key);
    const value = await this.client.get(fullKey);
    return value ? JSON.parse(value) : null;
  }

  /**
   * Delete key
   */
  async delete(key: string): Promise<number> {
    const fullKey = this.prefixKey(key);
    return this.client.del(fullKey);
  }

  /**
   * Acquire distributed lock
   */
  async acquireLock(
    lockKey: string,
    ttlSeconds: number = 30
  ): Promise<string | null> {
    const fullKey = this.prefixKey(`lock:${lockKey}`);
    const lockId = `${Date.now()}-${Math.random()}`;

    const result = await this.client.set(
      fullKey,
      lockId,
      {
        NX: true,
        EX: ttlSeconds,
      } as any
    );

    return result === 'OK' ? lockId : null;
  }

  /**
   * Release lock
   */
  async releaseLock(lockKey: string, lockId: string): Promise<boolean> {
    const fullKey = this.prefixKey(`lock:${lockKey}`);
    const currentLockId = await this.client.get(fullKey);

    if (currentLockId === lockId) {
      await this.client.del(fullKey);
      return true;
    }

    return false;
  }

  /**
   * Idempotency key check/set
   */
  async checkIdempotency(
    idempotencyKey: string,
    ttlSeconds: number = 3600
  ): Promise<string | null> {
    const fullKey = this.prefixKey(`idempotency:${idempotencyKey}`);
    const existing = await this.client.get(fullKey);

    if (existing) {
      return existing;
    }

    const requestId = `${Date.now()}-${Math.random()}`;
    await this.client.setEx(fullKey, ttlSeconds, requestId);
    return null;
  }

  /**
   * Increment counter (for rate limiting)
   */
  async increment(
    key: string,
    ttlSeconds?: number
  ): Promise<number> {
    const fullKey = this.prefixKey(key);
    const count = await this.client.incr(fullKey);

    if (ttlSeconds) {
      await this.client.expire(fullKey, ttlSeconds);
    }

    return count;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch (error) {
      console.error('Redis health check failed:', error);
      return false;
    }
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    await this.client.quit();
    console.log('✓ Redis connection closed');
  }

  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}

/**
 * Singleton instance
 */
let redisInstance: RedisClient | null = null;

export function initRedis(config: RedisConfig): RedisClient {
  if (redisInstance) {
    return redisInstance;
  }
  redisInstance = new RedisClient(config);
  return redisInstance;
}

export function getRedis(): RedisClient {
  if (!redisInstance) {
    throw new Error('Redis not initialized. Call initRedis() first.');
  }
  return redisInstance;
}
