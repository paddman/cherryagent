import { config } from "./config.js";
import { DatabaseCliHub } from "./connectors/database/DatabaseCliHub.js";
import type { LinuxSshClient } from "./connectors/linux/LinuxSshClient.js";
import type { AgentTool } from "./core/types.js";
import { SecurityEventStore } from "./security/SecurityEventStore.js";
import { SecurityPolicyEngine } from "./security/SecurityPolicyEngine.js";
import { createSecurityOpsTools } from "./tools/builtin/securityOps.js";
import { createSecurityPolicyTools } from "./tools/builtin/securityPolicy.js";

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

  return {
    policy,
    events,
    tools: [
      ...createSecurityOpsTools(linux, { policy, events }),
      ...createSecurityPolicyTools(policy, events),
    ],
  };
}
