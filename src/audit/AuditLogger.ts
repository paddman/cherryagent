import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import type { RiskLevel } from "../core/types.js";

// ============================================================================
// AuditLogger — บันทึกทุกการกระทำในระบบลง PostgreSQL
// Phase 1: hook เข้า ToolRegistry.execute + HTTP request lifecycle
// Auth identity is supplied by the local-first HTTP auth layer; PostgreSQL-backed identity can be added later.
// ============================================================================

/**
 * Auto-load .env.pg (เหมือน loadDotEnv ใน config.ts)
 * ทำให้ config PG แยกจาก .env หลัก เพื่อความปลอดภัย
 */
function loadPgEnv(path = ".env.pg"): void {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return;
  for (const rawLine of readFileSync(absolute, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf("=");
    if (sep < 1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadPgEnv();

export type AuditAction =
  | "http_request"
  | "tool_call"
  | "tool_approve"
  | "tool_deny"
  | "tool_pending"
  | "login"
  | "logout"
  | "login_failed"
  | "rbac_deny";

export interface AuditEvent {
  action: AuditAction;
  userId?: string;
  sessionId?: string;
  traceId?: string;
  ip?: string;
  method?: string;
  path?: string;
  tool?: string;
  risk?: RiskLevel;
  // args ที่จะเก็บ — จะถูก hash อัตโนมัติ ไม่เก็บ raw (ป้องกันข้อมูล sensitive)
  args?: unknown;
  resultStatus?: string;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  // ถ้า PG ล่ม จะ fail-soft (log warning แทน throw) เพื่อไม่ให้ audit พัง app
  failSoft?: boolean;
}

/**
 * แปลง args object → hash SHA-256 (เก็บเพื่อ correlation แต่ไม่เปิดเผยเนื้อหา)
 * Skip สำหรับ action ที่ไม่มีความเสี่ยง (เช่น http_request)
 */
function hashArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  try {
    const json = JSON.stringify(args, Object.keys(args as object).sort());
    return "sha256:" + createHash("sha256").update(json).digest("hex").slice(0, 32);
  } catch {
    return "sha256:hash-error";
  }
}

export class AuditLogger {
  private pool: Pool;
  private failSoft: boolean;
  private connected = false;
  private warnedOffline = false;

  constructor(opts: AuditLoggerOptions = {}) {
    this.failSoft = opts.failSoft ?? true;

    const host = opts.host ?? process.env.CHERRY_PG_HOST ?? "127.0.0.1";
    const port = opts.port ?? Number(process.env.CHERRY_PG_PORT ?? 5432);
    const database = opts.database ?? process.env.CHERRY_PG_DB ?? "cherryagent";
    const user = opts.user ?? process.env.CHERRY_PG_USER ?? "cherryagent";
    const password = opts.password ?? process.env.CHERRY_PG_PASSWORD;
    const ssl = opts.ssl ?? process.env.CHERRY_PG_SSL === "true";

    if (!password) {
      // ไม่มี password → ทำงานในโหมด "no-op" (Phase 1 อาจยังไม่ได้ set)
      this.pool = new Pool({ host, port, database, user, password: "", ssl, max: 4 });
      console.warn("[AuditLogger] WARNING: no CHERRY_PG_PASSWORD — will run in degraded mode");
    } else {
      this.pool = new Pool({ host, port, database, user, password, ssl, max: 4 });
    }
  }

  /**
   * ทดสอบ connection + mark connected (call ตอน boot)
   */
  async ping(): Promise<boolean> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("SELECT 1");
      this.connected = true;
      return true;
    } catch (err) {
      this.connected = false;
      if (!this.warnedOffline) {
        console.warn(
          `[AuditLogger] PG connection failed: ${err instanceof Error ? err.message : String(err)}. ` +
            `Audit will run in fail-soft mode (events dropped).`
        );
        this.warnedOffline = true;
      }
      return false;
    } finally {
      client?.release();
    }
  }

  /**
   * บันทึก audit event (non-blocking — fire and forget)
   * ถ้า fail-soft จะไม่ throw เพื่อไม่ให้ audit พัง app หลัก
   */
  log(event: AuditEvent): void {
    // ใช้ .catch แทน await เพื่อ non-blocking
    this.logAsync(event).catch((err) => {
      if (!this.failSoft) throw err;
      // fail-soft: แค่ log warning ครั้งเดียว
      if (!this.warnedOffline) {
        console.warn(`[AuditLogger] write failed (fail-soft): ${err instanceof Error ? err.message : String(err)}`);
        this.warnedOffline = true;
      }
    });
  }

  /**
   * บันทึก audit event (await-able สำหรับกรณีต้องการยืนยัน เช่น login/logout)
   */
  async logAsync(event: AuditEvent): Promise<void> {
    const argsHash = event.action === "tool_call" || event.action === "tool_approve" || event.action === "tool_deny"
      ? hashArgs(event.args)
      : undefined;

    const ip = event.ip && this.isValidIp(event.ip) ? event.ip : null;

    const sql = `
      INSERT INTO cherry_audit.audit_events
        (user_id, session_id, trace_id, ip, method, path, action, tool, risk,
         args_hash, result_status, duration_ms, error, metadata)
      VALUES ($1, $2, $3, $4::inet, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
    `;
    const params = [
      event.userId ?? null,
      event.sessionId ?? null,
      event.traceId ?? null,
      ip,
      event.method ?? null,
      event.path ?? null,
      event.action,
      event.tool ?? null,
      event.risk ?? null,
      argsHash ?? null,
      event.resultStatus ?? null,
      event.durationMs ?? null,
      event.error ? event.error.slice(0, 1000) : null,
      JSON.stringify(event.metadata ?? {}),
    ];

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query(sql, params);
      this.connected = true;
    } finally {
      client?.release();
    }
  }

  private isValidIp(s: string): boolean {
    // ป้องกัน invalid inet ทำให้ INSERT fail
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || /^[0-9a-f:]+$/i.test(s);
  }

  /**
   * ปิด pool (call ตอน shutdown)
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /** helper: สร้าง traceId ใหม่สำหรับ request/tool-call correlation */
  static newTraceId(): string {
    return randomUUID();
  }
}

/**
 * Singleton instance — สร้างครั้งเดียวตอน boot (bootstrap.ts)
 * export ให้ทุกส่วนของระบบใช้ร่วมกัน
 */
let singleton: AuditLogger | undefined;

export function getAuditLogger(): AuditLogger {
  if (!singleton) singleton = new AuditLogger();
  return singleton;
}

export function setAuditLogger(logger: AuditLogger): void {
  singleton = logger;
}
