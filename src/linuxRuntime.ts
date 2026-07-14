import { LinuxSshClient } from "./connectors/linux/LinuxSshClient.js";
import type { AgentTool } from "./core/types.js";
import { createSecurityRuntime } from "./securityRuntime.js";
import { createLinuxTools } from "./tools/builtin/linux.js";

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

export type LinuxRuntimeStatus = {
  configured: boolean;
  host: string | null;
  username: string | null;
  port: number;
  strictHostKeyChecking: boolean;
  privateKeyConfigured: boolean;
};

export function createLinuxRuntimeClient(): LinuxSshClient {
  return new LinuxSshClient({
    host: process.env.CHERRY_LINUX_SSH_HOST ?? "",
    ...(process.env.CHERRY_LINUX_SSH_USERNAME?.trim()
      ? { username: process.env.CHERRY_LINUX_SSH_USERNAME.trim() }
      : {}),
    port: integerEnv("CHERRY_LINUX_SSH_PORT", 22),
    ...(process.env.CHERRY_LINUX_SSH_PRIVATE_KEY?.trim()
      ? { privateKeyPath: process.env.CHERRY_LINUX_SSH_PRIVATE_KEY.trim() }
      : {}),
    ...(process.env.CHERRY_LINUX_SSH_KNOWN_HOSTS?.trim()
      ? { knownHostsFile: process.env.CHERRY_LINUX_SSH_KNOWN_HOSTS.trim() }
      : {}),
    strictHostKeyChecking: booleanEnv("CHERRY_LINUX_SSH_STRICT_HOST_KEY_CHECKING", true),
    timeoutMs: integerEnv("CHERRY_LINUX_SSH_TIMEOUT_MS", 30_000),
    maxOutputBytes: integerEnv("CHERRY_LINUX_SSH_MAX_OUTPUT_BYTES", 1_000_000),
  });
}

export function getLinuxRuntimeStatus(): LinuxRuntimeStatus {
  return createLinuxRuntimeClient().status();
}

export function createLinuxRuntimeTools(): AgentTool[] {
  const linux = createLinuxRuntimeClient();
  const security = createSecurityRuntime(linux);
  return [
    ...createLinuxTools(linux),
    ...security.tools,
  ];
}
