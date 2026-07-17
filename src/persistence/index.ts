/**
 * Persistence Layer Entry Point
 * 
 * Initializes PostgreSQL and Redis, provides unified access to all stores
 */

import { PostgresDB, initPostgres } from './database/postgres';
import { RedisClient, initRedis } from './redis/client';
import { PlannerStore } from './planner/store';
import { EngineerStore } from './engineer/store';
import { ApprovalStore } from './approvals/store';
import { AuditStore } from './audit/store';

export interface PersistenceConfig {
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
  };
}

export class PersistenceLayer {
  private db: PostgresDB;
  private cache: RedisClient;
  public planner: PlannerStore;
  public engineer: EngineerStore;
  public approvals: ApprovalStore;
  public audit: AuditStore;

  constructor(config: PersistenceConfig) {
    this.db = initPostgres(config.postgres);
    this.cache = initRedis({ ...config.redis, keyPrefix: 'cherry:' });
    this.planner = new PlannerStore();
    this.engineer = new EngineerStore();
    this.approvals = new ApprovalStore();
    this.audit = new AuditStore();
  }

  async initialize(): Promise<void> {
    console.log('Initializing persistence layer...');
    await this.cache.connect();
    await this.db.initialize();
    console.log('✓ Persistence layer ready');
  }

  async healthCheck(): Promise<{
    postgres: boolean;
    redis: boolean;
  }> {
    return {
      postgres: await this.db.healthCheck(),
      redis: await this.cache.healthCheck(),
    };
  }

  async close(): Promise<void> {
    await this.db.close();
    await this.cache.close();
    console.log('✓ Persistence layer closed');
  }
}

/**
 * Global instance
 */
let persistenceInstance: PersistenceLayer | null = null;

export function initPersistence(config: PersistenceConfig): PersistenceLayer {
  if (persistenceInstance) {
    return persistenceInstance;
  }
  persistenceInstance = new PersistenceLayer(config);
  return persistenceInstance;
}

export function getPersistence(): PersistenceLayer {
  if (!persistenceInstance) {
    throw new Error('Persistence layer not initialized. Call initPersistence() first.');
  }
  return persistenceInstance;
}

// Export all store types
export * from './planner/store';
export * from './engineer/store';
export * from './approvals/store';
export * from './audit/store';
