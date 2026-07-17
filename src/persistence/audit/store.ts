/**
 * Audit Log Persistence Store
 * 
 * Comprehensive audit trail for all operations:
 * - tool execution
 * - approval decisions
 * - state changes
 * - error recovery
 */

import { v4 as uuidv4 } from 'uuid';
import { getPostgres } from '../database/postgres';

export interface AuditLog {
  id: string;
  tenantId: string;
  userId?: string;
  agentName?: string;
  actionType: string;
  resourceType: string;
  resourceId: string;
  toolName?: string;
  riskLevel?: string;
  status: 'success' | 'failure' | 'pending';
  durationMs?: number;
  detailsJson?: any;
  errorMessage?: string;
  verificationResult?: any;
  createdAt: Date;
}

export class AuditStore {
  async log(
    tenantId: string,
    log: Omit<AuditLog, 'id' | 'createdAt'>
  ): Promise<AuditLog> {
    const db = getPostgres();
    const id = uuidv4();
    const now = new Date();

    const result = await db.query(
      `INSERT INTO audit.logs (
        id, tenant_id, user_id, agent_name, action_type, resource_type,
        resource_id, tool_name, risk_level, status, duration_ms,
        details_json, error_message, verification_result, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        id,
        tenantId,
        log.userId || null,
        log.agentName || null,
        log.actionType,
        log.resourceType,
        log.resourceId,
        log.toolName || null,
        log.riskLevel || null,
        log.status,
        log.durationMs || null,
        log.detailsJson ? JSON.stringify(log.detailsJson) : null,
        log.errorMessage || null,
        log.verificationResult ? JSON.stringify(log.verificationResult) : null,
        now,
      ]
    );

    return this.rowToAudit(result.rows[0]);
  }

  async getAuditTrail(
    tenantId: string,
    filters?: {
      resourceType?: string;
      resourceId?: string;
      actionType?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<AuditLog[]> {
    const db = getPostgres();
    let query = 'SELECT * FROM audit.logs WHERE tenant_id = $1';
    const params: any[] = [tenantId];

    if (filters?.resourceType) {
      query += ` AND resource_type = $${params.length + 1}`;
      params.push(filters.resourceType);
    }

    if (filters?.resourceId) {
      query += ` AND resource_id = $${params.length + 1}`;
      params.push(filters.resourceId);
    }

    if (filters?.actionType) {
      query += ` AND action_type = $${params.length + 1}`;
      params.push(filters.actionType);
    }

    query += ' ORDER BY created_at DESC';

    if (filters?.limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(filters.limit);
    }

    if (filters?.offset) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(filters.offset);
    }

    const result = await db.query(query, params);
    return result.rows.map((row) => this.rowToAudit(row));
  }

  async getResourceHistory(
    tenantId: string,
    resourceType: string,
    resourceId: string
  ): Promise<AuditLog[]> {
    const db = getPostgres();

    const result = await db.query(
      `SELECT * FROM audit.logs
       WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3
       ORDER BY created_at DESC
       LIMIT 100`,
      [tenantId, resourceType, resourceId]
    );

    return result.rows.map((row) => this.rowToAudit(row));
  }

  private rowToAudit(row: any): AuditLog {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      agentName: row.agent_name,
      actionType: row.action_type,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      toolName: row.tool_name,
      riskLevel: row.risk_level,
      status: row.status,
      durationMs: row.duration_ms,
      detailsJson: row.details_json,
      errorMessage: row.error_message,
      verificationResult: row.verification_result,
      createdAt: row.created_at,
    };
  }
}
