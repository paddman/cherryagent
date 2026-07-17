/**
 * Planner Persistence Store
 * 
 * Replaces JSON persistence with PostgreSQL/Redis for Planner items,
 * reminders, and alerts with full ACID support
 */

import { v4 as uuidv4 } from 'uuid';
import { getPostgres } from '../database/postgres';
import { getRedis } from '../redis/client';

export interface PlannerItem {
  id: string;
  tenantId: string;
  title: string;
  description?: string;
  status: 'inbox' | 'planned' | 'doing' | 'waiting' | 'done' | 'cancelled';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  flowId?: string;
  startAt?: Date;
  dueAt?: Date;
  durationMinutes?: number;
  timezone: string;
  tags: string[];
  dependencies: string[];
  metadataJson?: any;
  createdAt: Date;
  updatedAt: Date;
}

export interface Reminder {
  id: string;
  tenantId: string;
  itemId?: string;
  title: string;
  scheduleKind: 'once' | 'interval' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron';
  scheduleSpecJson: any;
  nextRunAt?: Date;
  lastRunAt?: Date;
  channels: string[];
  status: 'active' | 'paused' | 'completed';
  createdAt: Date;
  updatedAt: Date;
}

export class PlannerStore {
  async createItem(tenantId: string, item: Omit<PlannerItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<PlannerItem> {
    const db = getPostgres();
    const id = uuidv4();
    const now = new Date();

    const result = await db.query(
      `INSERT INTO planning.items (
        id, tenant_id, title, description, status, priority, flow_id,
        start_at, due_at, duration_minutes, timezone, tags, dependencies,
        metadata_json, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        id,
        tenantId,
        item.title,
        item.description || null,
        item.status,
        item.priority,
        item.flowId || null,
        item.startAt || null,
        item.dueAt || null,
        item.durationMinutes || null,
        item.timezone,
        JSON.stringify(item.tags),
        JSON.stringify(item.dependencies),
        item.metadataJson ? JSON.stringify(item.metadataJson) : null,
        now,
        now,
      ]
    );

    // Cache in Redis for fast access
    await getRedis().set(
      `planner:item:${id}`,
      result.rows[0],
      300 // 5 minutes TTL
    );

    return this.rowToItem(result.rows[0]);
  }

  async getItem(tenantId: string, itemId: string): Promise<PlannerItem | null> {
    const redis = getRedis();
    const cacheKey = `planner:item:${itemId}`;

    // Try cache first
    let cached = await redis.get<any>(cacheKey);
    if (cached) {
      return this.rowToItem(cached);
    }

    // Fetch from DB
    const db = getPostgres();
    const result = await db.query(
      'SELECT * FROM planning.items WHERE id = $1 AND tenant_id = $2',
      [itemId, tenantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Cache result
    await redis.set(cacheKey, result.rows[0], 300);
    return this.rowToItem(result.rows[0]);
  }

  async listItems(
    tenantId: string,
    filters?: { status?: string; priority?: string; limit?: number }
  ): Promise<PlannerItem[]> {
    const db = getPostgres();
    let query = 'SELECT * FROM planning.items WHERE tenant_id = $1';
    const params: any[] = [tenantId];

    if (filters?.status) {
      query += ` AND status = $${params.length + 1}`;
      params.push(filters.status);
    }

    if (filters?.priority) {
      query += ` AND priority = $${params.length + 1}`;
      params.push(filters.priority);
    }

    query += ' ORDER BY created_at DESC';

    if (filters?.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(filters.limit);
    }

    const result = await db.query(query, params);
    return result.rows.map((row) => this.rowToItem(row));
  }

  async updateItemStatus(
    tenantId: string,
    itemId: string,
    status: string
  ): Promise<PlannerItem | null> {
    const db = getPostgres();

    const result = await db.query(
      `UPDATE planning.items
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [status, itemId, tenantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Invalidate cache
    await getRedis().delete(`planner:item:${itemId}`);

    return this.rowToItem(result.rows[0]);
  }

  async createReminder(tenantId: string, reminder: Omit<Reminder, 'id' | 'createdAt' | 'updatedAt'>): Promise<Reminder> {
    const db = getPostgres();
    const id = uuidv4();
    const now = new Date();

    const result = await db.query(
      `INSERT INTO planning.reminders (
        id, tenant_id, item_id, title, schedule_kind, schedule_spec_json,
        next_run_at, channels, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        id,
        tenantId,
        reminder.itemId || null,
        reminder.title,
        reminder.scheduleKind,
        JSON.stringify(reminder.scheduleSpecJson),
        reminder.nextRunAt || null,
        JSON.stringify(reminder.channels),
        reminder.status,
        now,
        now,
      ]
    );

    return this.rowToReminder(result.rows[0]);
  }

  async getDueReminders(tenantId: string): Promise<Reminder[]> {
    const db = getPostgres();
    const now = new Date();

    const result = await db.query(
      `SELECT * FROM planning.reminders
       WHERE tenant_id = $1
       AND status = 'active'
       AND next_run_at <= $2
       ORDER BY next_run_at ASC`,
      [tenantId, now]
    );

    return result.rows.map((row) => this.rowToReminder(row));
  }

  async getDashboard(tenantId: string) {
    const db = getPostgres();

    const [items, reminders, alerts] = await Promise.all([
      db.query(
        `SELECT status, COUNT(*) as count FROM planning.items
         WHERE tenant_id = $1
         GROUP BY status`,
        [tenantId]
      ),
      db.query(
        `SELECT COUNT(*) as count FROM planning.reminders
         WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId]
      ),
      db.query(
        `SELECT COUNT(*) as count FROM planning.alerts
         WHERE tenant_id = $1 AND read_at IS NULL`,
        [tenantId]
      ),
    ]);

    const statusCounts = {} as Record<string, number>;
    for (const row of items.rows) {
      statusCounts[row.status] = Number(row.count);
    }

    return {
      items: statusCounts,
      activeReminders: Number(reminders.rows[0].count),
      unreadAlerts: Number(alerts.rows[0].count),
    };
  }

  private rowToItem(row: any): PlannerItem {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      flowId: row.flow_id,
      startAt: row.start_at,
      dueAt: row.due_at,
      durationMinutes: row.duration_minutes,
      timezone: row.timezone,
      tags: row.tags || [],
      dependencies: row.dependencies || [],
      metadataJson: row.metadata_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToReminder(row: any): Reminder {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      itemId: row.item_id,
      title: row.title,
      scheduleKind: row.schedule_kind,
      scheduleSpecJson: row.schedule_spec_json,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      channels: row.channels || [],
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
