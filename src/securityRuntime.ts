import { config } from "./config.js";
import { DatabaseCliHub } from "./connectors/database/DatabaseCliHub.js";
import type { LinuxSshClient } from "./connectors/linux/LinuxSshClient.js";
import type { AgentTool, ToolContext } from "./core/types.js";
import { SecurityEventStore } from "./security/SecurityEventStore.js";
import { SecurityPolicyEngine, type SecurityExecutionMode } from "./security/SecurityPolicyEngine.js";
import { createSecurityOpsTools } from "./tools/builtin/securityOps.js";
import { createSecurityPolicyTools } from "./tools/builtin/securityPolicy.js";

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numericArg(args: Record<string, unknown>, key: string, fallback: number): number {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function modeArg(value: unknown): SecurityExecutionMode {
  if (value === undefined) return "manual";
  if (value !== "manual" && value !== "auto" && value !== "emergency") {
    throw new Error("mode must be manual, auto, or emergency");
  }
  return value;
}

function timeoutToMinutes(value: unknown): number {
  const raw = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "1h";
  const match = raw.match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error("timeout must use nft-style duration such as 30m, 1h, or 1d");
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "s") return Math.max(1, Math.ceil(amount / 60));
  if (unit === "m") return amount;
  if (unit === "h") return amount * 60;
  return amount * 1_440;
}

function executionSucceeded(output: unknown): boolean {
  return Boolean(output && typeof output === "object" && "exitCode" in output && (output as { exitCode?: unknown }).exitCode === 0);
}

function sourceIpField(target: string): { sourceIp: string } | Record<string, never> {
  return target && !target.includes("/") ? { sourceIp: target } : {};
}

function guardSecurityOpsTools(
  baseTools: AgentTool[],
  policy: SecurityPolicyEngine,
  events: SecurityEventStore,
): AgentTool[] {
  return baseTools.map((tool): AgentTool => {
    if (tool.name === "security_firewall_temporary_block") {
      return {
        ...tool,
        description: `${tool.description} Hard policy is enforced before execution, including protected ranges, allowlist, CIDR breadth, TTL, confidence, evidence, and emergency-mode rules.`,
        parameters: {
          ...tool.parameters,
          properties: {
            ...tool.parameters.properties,
            confidence: { type: "number", description: "Attack confidence from 0 to 1; required for auto/emergency containment" },
            evidenceCount: { type: "number", description: "Independent evidence signals supporting containment" },
            mode: { type: "string", enum: ["manual", "auto", "emergency"], description: "Execution mode; defaults to manual" },
          },
        },
        execute: async (args: Record<string, unknown>, context: ToolContext) => {
          const mode = modeArg(args.mode);
          const target = String(args.target ?? "").trim();
          const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : undefined;
          const decision = policy.evaluate({
            action: "temporary_block",
            target,
            timeoutMinutes: timeoutToMinutes(args.timeout),
            confidence: numericArg(args, "confidence", mode === "manual" ? 1 : 0),
            evidenceCount: Math.max(0, Math.floor(numericArg(args, "evidenceCount", mode === "manual" ? 1 : 0))),
            mode,
            ...(reason ? { reason } : {}),
          });
          if (!decision.allowed) {
            throw new Error(`Security policy denied containment: ${decision.reasons.join("; ")}`);
          }

          const output = await tool.execute(args, context);
          const blocked = executionSucceeded(output);
          await events.record({
            category: "containment",
            severity: blocked ? 8 : 6,
            action: "temporary_block",
            ...sourceIpField(target),
            confidence: decision.confidence,
            blocked,
            evidenceCount: decision.evidenceCount,
            tags: ["firewall", "nftables", `mode:${mode}`],
            payload: { decision, execution: output },
          });
          return { policy: decision, execution: output };
        },
      };
    }

    if (tool.name === "security_firewall_remove_block") {
      return {
        ...tool,
        execute: async (args: Record<string, unknown>, context: ToolContext) => {
          const target = String(args.target ?? "").trim();
          const output = await tool.execute(args, context);
          await events.record({
            category: "containment",
            severity: 3,
            action: "remove_block",
            ...sourceIpField(target),
            blocked: false,
            evidenceCount: 1,
            tags: ["firewall", "rollback"],
            payload: { target, execution: output },
          });
          return output;
        },
      };
    }

    return tool;
  });
}

export type SecurityRuntime = {
  policy: SecurityPolicyEngine;
  events: SecurityEventStore;
  tools: AgentTool[];
};

export function createSecurityRuntime(linux: LinuxSshClient): SecurityRuntime {
  const database = new DatabaseCliHub({
    timeoutMs: config.database.timeoutMs,
    maxOutputBytes: config.database.maxOutputBytes,
    ...(config.database.postgresUrl ? { postgresUrl: config.database.postgresUrl } : {}),
    ...(config.database.redisUrl ? { redisUrl: config.database.redisUrl } : {}),
  });
  const policy = SecurityPolicyEngine.fromEnvironment();
  const events = new SecurityEventStore(database, {
    host: process.env.CHERRY_LINUX_SSH_HOST ?? "unknown",
    batchSize: integerEnv("CHERRY_SECURITY_DB_BATCH_SIZE", 250),
    flushIntervalMs: integerEnv("CHERRY_SECURITY_DB_FLUSH_INTERVAL_MS", 500),
    memoryLimit: integerEnv("CHERRY_SECURITY_DB_MEMORY_LIMIT", 10_000),
  });
  const guardedOpsTools = guardSecurityOpsTools(createSecurityOpsTools(linux), policy, events);

  return {
    policy,
    events,
    tools: [
      ...guardedOpsTools,
      ...createSecurityPolicyTools(policy, events),
    ],
  };
}
