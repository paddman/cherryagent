/**
 * PostgreSQL Connection Pool and Client
 * 
 * Manages database connections with proper pooling, error handling,
 * and health checks for multi-user Cherry Agent production deployment
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export class PostgresDB {
  private pool: Pool;
  private initialized = false;

  constructor(config: DatabaseConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.max || 20,
      idleTimeoutMillis: config.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis || 2000,
    });

    // Error event handler
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }

  /**
   * Initialize database: create schema, run migrations
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Test connection
      const client = await this.pool.connect();
      console.log('✓ Connected to PostgreSQL');
      client.release();

      // Check if schema exists
      const schemaCheck = await this.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'identity'"
      );

      if (schemaCheck.rows.length === 0) {
        console.log('Creating database schema...');
        await this.initializeSchema();
      }

      await this.runMigrations();
      this.initialized = true;
      console.log('✓ Database initialized');
    } catch (error) {
      console.error('Database initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize database schema
   */
  private async initializeSchema(): Promise<void> {
    const { SCHEMA } = await import('./schema');
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(SCHEMA);
      await client.query('COMMIT');
      console.log('✓ Schema created');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run database migrations
   */
  private async runMigrations(): Promise<void> {
    const migrationsDir = path.join(__dirname, 'migrations');

    if (!fs.existsSync(migrationsDir)) {
      console.log('No migrations directory found');
      return;
    }

    const migrations = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const migration of migrations) {
      const migrationPath = path.join(migrationsDir, migration);
      const sql = fs.readFileSync(migrationPath, 'utf-8');

      try {
        await this.query(sql);
        console.log(`✓ Migration: ${migration}`);
      } catch (error) {
        console.error(`Migration failed: ${migration}`, error);
        throw error;
      }
    }
  }

  /**
   * Execute query
   */
  async query<T = any>(
    text: string,
    values?: any[]
  ): Promise<QueryResult<T>> {
    try {
      return await this.pool.query(text, values);
    } catch (error) {
      console.error('Query error:', { text, values, error });
      throw error;
    }
  }

  /**
   * Get a single client for transaction
   */
  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.query('SELECT 1');
      return result.rows.length > 0;
    } catch (error) {
      console.error('Health check failed:', error);
      return false;
    }
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    await this.pool.end();
    console.log('✓ Database connections closed');
  }
}

/**
 * Singleton instance
 */
let pgInstance: PostgresDB | null = null;

export function initPostgres(config: DatabaseConfig): PostgresDB {
  if (pgInstance) {
    return pgInstance;
  }
  pgInstance = new PostgresDB(config);
  return pgInstance;
}

export function getPostgres(): PostgresDB {
  if (!pgInstance) {
    throw new Error('PostgreSQL not initialized. Call initPostgres() first.');
  }
  return pgInstance;
}
