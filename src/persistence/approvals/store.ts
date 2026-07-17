/**
 * Approval Inbox Persistence Store
 * 
 * Stores approval requests for external and dangerous actions
 * with full audit trail and status tracking
 */

import { v4 as uuidv4 } from 'uuid';
import { getPostgres } from '../database/postgres';

export interface ApprovalRequest {
  id: string;
  tenantId: string;
  actionType: string;
  resourceType: string;
  resourceId: string;
  description?: string;
  riskLevel: 'safe' | 'write' | 'external' | 'dangerous';
  detailsJson?: any;
  status: 'pending' | 'approved' | 'rejected';
  approvedAt?: Date;
  approvedByUserId?: string;
  approvalReason?: string;
  createdAt: Date;
}

export class ApprovalStore {
  async createRequest(
    tenantId: string,
    request: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt'>
  ): Promise<ApprovalRequest> {
    const db = getPostgres();
    const id = uuidv4();
    const now = new Date();

    const result = await db.query(
      `INSERT INTO approvals.inbox (
        id, tenant_id, action_type, resource_type, resource_id,
        description, risk_level, details_json, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        id,
        tenantId,
        request.actionType,
        request.resourceType,
        request.resourceId,
        request.description || null,
        request.riskLevel,
        request.detailsJson ? JSON.stringify(request.detailsJson) : null,
        'pending',
        now,
      ]
    );

    return this.rowToApproval(result.rows[0]);
  }

  async getRequest(tenantId: string, requestId: string): Promise<ApprovalRequest | null> {
    const db = getPostgres();

    const result = await db.query(
      'SELECT * FROM approvals.inbox WHERE id = $1 AND tenant_id = $2',
      [requestId, tenantId]
    );

    return result.rows.length > 0 ? this.rowToApproval(result.rows[0]) : null;
  }

  async listPendingRequests(tenantId: string): Promise<ApprovalRequest[]> {
    const db = getPostgres();

    const result = await db.query(
      `SELECT * FROM approvals.inbox
       WHERE tenant_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [tenantId]
    );

    return result.rows.map((row) => this.rowToApproval(row));
  }

  async approveRequest(
    tenantId: string,
    requestId: string,
    userId: string,
    reason?: string
  ): Promise<ApprovalRequest | null> {
    const db = getPostgres();

    const result = await db.query(
      `UPDATE approvals.inbox
       SET status = 'approved', approved_at = NOW(),
           approved_by_user_id = $1, approval_reason = $2
       WHERE id = $3 AND tenant_id = $4
       RETURNING *`,
      [userId, reason || null, requestId, tenantId]
    );

    return result.rows.length > 0 ? this.rowToApproval(result.rows[0]) : null;
  }

  async rejectRequest(
    tenantId: string,
    requestId: string,
    userId: string,
    reason?: string
  ): Promise<ApprovalRequest | null> {
    const db = getPostgres();

    const result = await db.query(
      `UPDATE approvals.inbox
       SET status = 'rejected', approved_at = NOW(),
           approved_by_user_id = $1, approval_reason = $2
       WHERE id = $3 AND tenant_id = $4
       RETURNING *`,
      [userId, reason || null, requestId, tenantId]
    );

    return result.rows.length > 0 ? this.rowToApproval(result.rows[0]) : null;
  }

  private rowToApproval(row: any): ApprovalRequest {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      actionType: row.action_type,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      description: row.description,
      riskLevel: row.risk_level,
      detailsJson: row.details_json,
      status: row.status,
      approvedAt: row.approved_at,
      approvedByUserId: row.approved_by_user_id,
      approvalReason: row.approval_reason,
      createdAt: row.created_at,
    };
  }
}
