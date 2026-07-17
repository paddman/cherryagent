/**
 * Engineer Loop Persistence Store
 * 
 * Replaces JSON persistence with PostgreSQL/Redis for Engineer Loops,
 * phase events, and runbooks with full ACID transaction support
 */

import { v4 as uuidv4 } from 'uuid';
import { getPostgres } from '../database/postgres';
import { getRedis } from '../redis/client';

export interface EngineerLoop {
  id: string;
  tenantId: string;
  objective: string;
  successCriteria: string[];
  status: 'running' | 'blocked' | 'succeeded' | 'failed' | 'aborted';
  currentPhase: string;
  currentIteration: number;
  maxIterations: number;
  hypothesis?: string;
  rootCause?: string;
  fixApplied?: string;
  rollbackPlan?: string;
  prevention?: string;
  phaseHistory: any[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PhaseEvent {
  id: string;
  loopId: string;
  phase: string;
  iteration: number;
  summary?: string;
  toolUsed?: string;
  command?: string;
  output?: string;
  error?: string;
  evidence?: any;
  verificationEvidence?: any;
  timestamp: Date;
}

export interface Runbook {
  id: string;
  tenantId: string;
  loopId?: string;
  title: string;
  symptoms?: string;
  rootCause?: string;
  fix?: string;
  diagnosticEvidence?: any;
  verificationEvidence?: any;
  rollbackInstructions?: string;
  prevention?: string;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export class EngineerStore {
  async startLoop(
    tenantId: string,
    objective: string,
    successCriteria: string[],
    maxIterations: number = 5
  ): Promise<EngineerLoop> {
    const db = getPostgres();
    const id = uuidv4();
    const now = new Date();

    const result = await db.query(
      `INSERT INTO engineer.loops (
        id, tenant_id, objective, success_criteria, status, current_phase,
        current_iteration, max_iterations, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        id,
        tenantId,
        objective,
        JSON.stringify(successCriteria),
        'running',
        'plan',
        1,
        maxIterations,
        now,
        now,
      ]
    );

    // Cache in Redis for hot access
    await getRedis().set(
      `engineer:loop:${id}`,
      result.rows[0],
      3600 // 1 hour TTL
    );

    return this.rowToLoop(result.rows[0]);
  }

  async getLoop(loopId: string): Promise<EngineerLoop | null> {
    const redis = getRedis();
    const cacheKey = `engineer:loop:${loopId}`;

    // Try cache first
    let cached = await redis.get<any>(cacheKey);
    if (cached) {
      return this.rowToLoop(cached);
    }

    // Fetch from DB
    const db = getPostgres();
    const result = await db.query(
      'SELECT * FROM engineer.loops WHERE id = $1',
      [loopId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Cache result
    await redis.set(cacheKey, result.rows[0], 3600);
    return this.rowToLoop(result.rows[0]);
  }

  async recordPhase(
    loopId: string,
    phase: string,
    iteration: number,
    event: Partial<PhaseEvent>
  ): Promise<PhaseEvent> {
    const db = getPostgres();
    const id = uuidv4();

    const result = await db.query(
      `INSERT INTO engineer.phase_events (
        id, loop_id, phase, iteration, summary, tool_used, command,
        output, error, evidence, verification_evidence, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        id,
        loopId,
        phase,
        iteration,
        event.summary || null,
        event.toolUsed || null,
        event.command || null,
        event.output || null,
        event.error || null,
        event.evidence ? JSON.stringify(event.evidence) : null,
        event.verificationEvidence ? JSON.stringify(event.verificationEvidence) : null,
        new Date(),
      ]
    );

    // Invalidate loop cache
    await getRedis().delete(`engineer:loop:${loopId}`);

    return this.rowToPhaseEvent(result.rows[0]);
  }

  async updateLoopStatus(
    loopId: string,
    status: string,
    currentPhase: string,
    iteration?: number
  ): Promise<EngineerLoop | null> {
    const db = getPostgres();

    const result = await db.query(
      `UPDATE engineer.loops
       SET status = $1, current_phase = $2,
           current_iteration = COALESCE($3, current_iteration),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, currentPhase, iteration || null, loopId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Invalidate cache
    await getRedis().delete(`engineer:loop:${loopId}`);

    return this.rowToLoop(result.rows[0]);
  }

  async getPhaseHistory(loopId: string): Promise<PhaseEvent[]> {
    const db = getPostgres();

    const result = await db.query(
      `SELECT * FROM engineer.phase_events
       WHERE loop_id = $1
       ORDER BY timestamp ASC`,
      [loopId]
    );

    return result.rows.map((row) => this.rowToPhaseEvent(row));
  }

  async completeLoop(
    loopId: string,
    status: 'succeeded' | 'failed' | 'aborted',
    metadata?: {
      rootCause?: string;
      fixApplied?: string;
      rollbackPlan?: string;
      prevention?: string;
    }
  ): Promise<EngineerLoop | null> {
    const db = getPostgres();

    const result = await db.query(
      `UPDATE engineer.loops
       SET status = $1, current_phase = 'complete',
           root_cause = $2, fix_applied = $3,
           rollback_plan = $4, prevention = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        status,
        metadata?.rootCause || null,
        metadata?.fixApplied || null,
        metadata?.rollbackPlan || null,
        metadata?.prevention || null,
        loopId,
      ]
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Invalidate cache
    await getRedis().delete(`engineer:loop:${loopId}`);

    return this.rowToLoop(result.rows[0]);
  }

  async saveRunbook(
    tenantId: string,
    loopId: string,
    runbook: Omit<Runbook, 'id' | 'usageCount' | 'createdAt' | 'updatedAt'>
  ): Promise<Runbook> {
    const db = getPostgres();
    const id = uuidv4();
    const now = new Date();

    const result = await db.query(
      `INSERT INTO engineer.runbooks (
        id, tenant_id, loop_id, title, symptoms, root_cause, fix,
        diagnostic_evidence, verification_evidence, rollback_instructions,
        prevention, usage_count, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        id,
        tenantId,
        loopId,
        runbook.title,
        runbook.symptoms || null,
        runbook.rootCause || null,
        runbook.fix || null,
        runbook.diagnosticEvidence ? JSON.stringify(runbook.diagnosticEvidence) : null,
        runbook.verificationEvidence ? JSON.stringify(runbook.verificationEvidence) : null,
        runbook.rollbackInstructions || null,
        runbook.prevention || null,
        0,
        now,
        now,
      ]
    );

    return this.rowToRunbook(result.rows[0]);
  }

  async listRunbooks(tenantId: string): Promise<Runbook[]> {
    const db = getPostgres();

    const result = await db.query(
      `SELECT * FROM engineer.runbooks
       WHERE tenant_id = $1
       ORDER BY usage_count DESC, created_at DESC`,
      [tenantId]
    );

    return result.rows.map((row) => this.rowToRunbook(row));
  }

  async getDashboard(tenantId: string) {
    const db = getPostgres();

    const [loops, runbooks] = await Promise.all([
      db.query(
        `SELECT status, COUNT(*) as count FROM engineer.loops
         WHERE tenant_id = $1
         GROUP BY status`,
        [tenantId]
      ),
      db.query(
        `SELECT COUNT(*) as count FROM engineer.runbooks
         WHERE tenant_id = $1`,
        [tenantId]
      ),
    ]);

    const statusCounts = {} as Record<string, number>;
    for (const row of loops.rows) {
      statusCounts[row.status] = Number(row.count);
    }

    return {
      loops: statusCounts,
      runbookCount: Number(runbooks.rows[0].count),
    };
  }

  private rowToLoop(row: any): EngineerLoop {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      objective: row.objective,
      successCriteria: row.success_criteria || [],
      status: row.status,
      currentPhase: row.current_phase,
      currentIteration: row.current_iteration,
      maxIterations: row.max_iterations,
      hypothesis: row.hypothesis,
      rootCause: row.root_cause,
      fixApplied: row.fix_applied,
      rollbackPlan: row.rollback_plan,
      prevention: row.prevention,
      phaseHistory: row.phase_history || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToPhaseEvent(row: any): PhaseEvent {
    return {
      id: row.id,
      loopId: row.loop_id,
      phase: row.phase,
      iteration: row.iteration,
      summary: row.summary,
      toolUsed: row.tool_used,
      command: row.command,
      output: row.output,
      error: row.error,
      evidence: row.evidence,
      verificationEvidence: row.verification_evidence,
      timestamp: row.timestamp,
    };
  }

  private rowToRunbook(row: any): Runbook {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      loopId: row.loop_id,
      title: row.title,
      symptoms: row.symptoms,
      rootCause: row.root_cause,
      fix: row.fix,
      diagnosticEvidence: row.diagnostic_evidence,
      verificationEvidence: row.verification_evidence,
      rollbackInstructions: row.rollback_instructions,
      prevention: row.prevention,
      usageCount: row.usage_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
