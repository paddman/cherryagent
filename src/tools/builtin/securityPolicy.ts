import type { AgentTool } from "../../core/types.js";
import type { SecurityEventStore } from "../../security/SecurityEventStore.js";
import type { SecurityExecutionMode, SecurityPolicyEngine } from "../../security/SecurityPolicyEngine.js";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined) return undefined;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string, fallback: number): number {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  return value;
}

function executionMode(value: unknown): SecurityExecutionMode {
  if (value === undefined) return "manual";
  if (value !== "manual" && value !== "auto" && value !== "emergency") {
    throw new Error("mode must be manual, auto, or emergency");
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("tags must be an array of strings");
  }
  return value.map(String);
}

export function createSecurityPolicyTools(policy: SecurityPolicyEngine, events: SecurityEventStore): AgentTool[] {
  return [
    {
      name: "security_policy_status",
      description: "Inspect the active Cherry SecurityOps hard safety policy: allowlist/protected ranges, block TTL limits, auto-containment confidence threshold, evidence minimum, CIDR breadth limits, and emergency-mode state.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => policy.status(),
    },
    {
      name: "security_policy_evaluate_block",
      description: "Evaluate an IP/CIDR temporary block against hard policy before containment. This does not modify firewall state.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "IPv4/IPv6 address or CIDR" },
          timeoutMinutes: { type: "number", description: "Requested block TTL in minutes" },
          confidence: { type: "number", description: "Attack confidence from 0 to 1" },
          evidenceCount: { type: "number", description: "Independent evidence signals supporting containment" },
          mode: { type: "string", enum: ["manual", "auto", "emergency"] },
          reason: { type: "string" },
        },
        required: ["target"],
        additionalProperties: false,
      },
      execute: async (args) => policy.evaluate({
        action: "temporary_block",
        target: requiredString(args, "target"),
        ...(optionalNumber(args, "timeoutMinutes") !== undefined ? { timeoutMinutes: optionalNumber(args, "timeoutMinutes") } : {}),
        ...(optionalNumber(args, "confidence") !== undefined ? { confidence: optionalNumber(args, "confidence") } : {}),
        evidenceCount: optionalInteger(args, "evidenceCount", executionMode(args.mode) === "manual" ? 1 : 0),
        mode: executionMode(args.mode),
        ...(optionalString(args, "reason") ? { reason: optionalString(args, "reason") } : {}),
      }),
    },
    {
      name: "security_db_status",
      description: "Inspect SecurityOps telemetry store status, batching configuration, queue depth, persistence availability, and last flush error.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => events.status(),
    },
    {
      name: "security_db_record_event",
      description: "Record one normalized SecurityOps event. Events are kept in the in-memory ring immediately and batched to PostgreSQL when configured.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Event category such as ddos, brute_force, waf, ids, firewall, containment" },
          severity: { type: "number", description: "Severity 0-10" },
          action: { type: "string" },
          sourceIp: { type: "string" },
          destinationIp: { type: "string" },
          confidence: { type: "number", description: "Confidence 0-1" },
          blocked: { type: "boolean" },
          evidenceCount: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
          payload: { type: "object", description: "Structured evidence payload" },
        },
        required: ["category"],
        additionalProperties: false,
      },
      execute: async (args) => events.record({
        category: requiredString(args, "category"),
        ...(optionalNumber(args, "severity") !== undefined ? { severity: optionalNumber(args, "severity") } : {}),
        ...(optionalString(args, "action") ? { action: optionalString(args, "action") } : {}),
        ...(optionalString(args, "sourceIp") ? { sourceIp: optionalString(args, "sourceIp") } : {}),
        ...(optionalString(args, "destinationIp") ? { destinationIp: optionalString(args, "destinationIp") } : {}),
        ...(optionalNumber(args, "confidence") !== undefined ? { confidence: optionalNumber(args, "confidence") } : {}),
        ...(typeof args.blocked === "boolean" ? { blocked: args.blocked } : {}),
        evidenceCount: optionalInteger(args, "evidenceCount", 0),
        tags: stringArray(args.tags),
        ...(args.payload && typeof args.payload === "object" && !Array.isArray(args.payload)
          ? { payload: args.payload as Record<string, unknown> }
          : {}),
      }),
    },
    {
      name: "security_db_recent_events",
      description: "Read recent SecurityOps events from the fast in-memory ring or PostgreSQL persistent store.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["memory", "postgres"], description: "Defaults to memory for lowest latency" },
          limit: { type: "number", description: "Maximum events, capped at 5000" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const source = optionalString(args, "source") ?? "memory";
        if (source !== "memory" && source !== "postgres") throw new Error("source must be memory or postgres");
        const limit = Math.min(5_000, Math.max(1, optionalInteger(args, "limit", 100)));
        return source === "postgres" ? await events.recentPersistent(limit) : events.recentMemory(limit);
      },
    },
    {
      name: "security_db_flush",
      description: "Force queued SecurityOps telemetry to flush to PostgreSQL immediately. Normal operation flushes automatically by batch size or interval.",
      risk: "write",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => events.flush(),
    },
  ];
}
