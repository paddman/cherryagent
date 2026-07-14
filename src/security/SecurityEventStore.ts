import { randomUUID } from "node:crypto";
import type { DatabaseExecutionResult } from "../connectors/database/DatabaseCliHub.js";
import type { DatabaseCliHub } from "../connectors/database/DatabaseCliHub.js";

export type SecurityEvent = {
  id?: string;
  observedAt?: string;
  host?: string;
  category: string;
  severity?: number;
  action?: string;
  sourceIp?: string;
  destinationIp?: string;
  confidence?: number;
  blocked?: boolean;
  evidenceCount?: number;
  tags?: string[];
  payload?: Record<string, unknown>;
};

export type SecurityEventRecord = Required<Pick<SecurityEvent, "id" | "observedAt" | "category">> & {
  host: string;
  severity: number;
  action: string | null;
  sourceIp: string | null;
  destinationIp: string | null;
  confidence: number | null;
  blocked: boolean;
  evidenceCount: number;
  tags: string[];
  payload: Record<string, unknown>;
};

export type SecurityEventStoreOptions = {
  host?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  memoryLimit?: number;
};

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullable(value: string | null): string {
  return value === null ? "NULL" : sqlString(value);
}

function sqlNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "NULL" : String(value);
}

function sqlTextArray(values: string[]): string {
  if (!values.length) return "ARRAY[]::text[]";
  return `ARRAY[${values.map(sqlString).join(",")}]::text[]`;
}

function safeSeverity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(0, Math.floor(value)));
}

function safeConfidence(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export class SecurityEventStore {
  readonly #database: DatabaseCliHub;
  readonly #host: string;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  readonly #memoryLimit: number;
  readonly #queue: SecurityEventRecord[] = [];
  readonly #memory: SecurityEventRecord[] = [];
  #flushPromise: Promise<{ flushed: number; persistent: boolean }> | null = null;
  #lastFlushError: string | null = null;
  #lastFlushAt: string | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(database: DatabaseCliHub, options: SecurityEventStoreOptions = {}) {
    this.#database = database;
    this.#host = options.host?.trim() || "unknown";
    this.#batchSize = Math.min(5_000, Math.max(1, Math.floor(options.batchSize ?? 250)));
    this.#flushIntervalMs = Math.min(60_000, Math.max(50, Math.floor(options.flushIntervalMs ?? 500)));
    this.#memoryLimit = Math.min(100_000, Math.max(100, Math.floor(options.memoryLimit ?? 10_000)));

    if (this.isPersistentConfigured()) {
      this.#timer = setInterval(() => {
        if (this.#queue.length) void this.flush().catch(() => undefined);
      }, this.#flushIntervalMs);
      this.#timer.unref();
    }
  }

  isPersistentConfigured(): boolean {
    return this.#database.configured().postgres;
  }

  status(): Record<string, unknown> {
    return {
      persistentConfigured: this.isPersistentConfigured(),
      queueDepth: this.#queue.length,
      memoryEvents: this.#memory.length,
      batchSize: this.#batchSize,
      flushIntervalMs: this.#flushIntervalMs,
      memoryLimit: this.#memoryLimit,
      lastFlushAt: this.#lastFlushAt,
      lastFlushError: this.#lastFlushError,
      schema: "cherry_security",
      eventTable: "cherry_security.security_events",
    };
  }

  async record(event: SecurityEvent): Promise<SecurityEventRecord> {
    const record: SecurityEventRecord = {
      id: event.id?.trim() || randomUUID(),
      observedAt: event.observedAt ?? new Date().toISOString(),
      host: event.host?.trim() || this.#host,
      category: event.category.trim(),
      severity: safeSeverity(event.severity),
      action: event.action?.trim() || null,
      sourceIp: event.sourceIp?.trim() || null,
      destinationIp: event.destinationIp?.trim() || null,
      confidence: safeConfidence(event.confidence),
      blocked: event.blocked ?? false,
      evidenceCount: Math.max(0, Math.floor(event.evidenceCount ?? 0)),
      tags: [...new Set((event.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 64),
      payload: event.payload ?? {},
    };
    if (!record.category) throw new Error("Security event category is required");

    this.#memory.push(record);
    if (this.#memory.length > this.#memoryLimit) {
      this.#memory.splice(0, this.#memory.length - this.#memoryLimit);
    }

    if (this.isPersistentConfigured()) {
      this.#queue.push(record);
      if (this.#queue.length >= this.#batchSize) await this.flush();
    }
    return record;
  }

  recentMemory(limit = 100): SecurityEventRecord[] {
    const bounded = Math.min(5_000, Math.max(1, Math.floor(limit)));
    return this.#memory.slice(-bounded).reverse();
  }

  async recentPersistent(limit = 100): Promise<DatabaseExecutionResult> {
    const bounded = Math.min(5_000, Math.max(1, Math.floor(limit)));
    return await this.#database.query("postgres", [
      "SELECT observed_at, id, host, category, severity, action, source_ip, destination_ip, confidence, blocked, evidence_count, tags, payload",
      "FROM cherry_security.security_events",
      "ORDER BY observed_at DESC",
      `LIMIT ${bounded}`,
    ].join(" "));
  }

  async flush(): Promise<{ flushed: number; persistent: boolean }> {
    if (!this.isPersistentConfigured()) return { flushed: 0, persistent: false };
    if (this.#flushPromise) return await this.#flushPromise;
    if (!this.#queue.length) return { flushed: 0, persistent: true };

    const batch = this.#queue.splice(0, this.#batchSize);
    this.#flushPromise = this.#flushBatch(batch);
    try {
      return await this.#flushPromise;
    } finally {
      this.#flushPromise = null;
    }
  }

  async #flushBatch(batch: SecurityEventRecord[]): Promise<{ flushed: number; persistent: boolean }> {
    const values = batch.map((event) => `(${[
      `${sqlString(event.observedAt)}::timestamptz`,
      `${sqlString(event.id)}::uuid`,
      sqlString(event.host),
      sqlString(event.category),
      String(event.severity),
      sqlNullable(event.action),
      event.sourceIp === null ? "NULL" : `${sqlString(event.sourceIp)}::inet`,
      event.destinationIp === null ? "NULL" : `${sqlString(event.destinationIp)}::inet`,
      sqlNumber(event.confidence),
      event.blocked ? "TRUE" : "FALSE",
      String(event.evidenceCount),
      sqlTextArray(event.tags),
      `${sqlString(JSON.stringify(event.payload))}::jsonb`,
    ].join(",")})`).join(",");

    const sql = [
      "INSERT INTO cherry_security.security_events",
      "(observed_at, id, host, category, severity, action, source_ip, destination_ip, confidence, blocked, evidence_count, tags, payload)",
      `VALUES ${values}`,
      "ON CONFLICT (observed_at, id) DO NOTHING",
    ].join(" ");

    try {
      await this.#database.query("postgres", sql);
      this.#lastFlushAt = new Date().toISOString();
      this.#lastFlushError = null;
      return { flushed: batch.length, persistent: true };
    } catch (error) {
      this.#queue.unshift(...batch);
      this.#lastFlushError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}
