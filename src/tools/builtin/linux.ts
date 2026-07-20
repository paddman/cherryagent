import type { AgentTool } from "../../core/types.js";
import type { LinuxSshClient } from "../../connectors/linux/LinuxSshClient.js";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string, fallback: number): number {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}

function serviceAction(value: unknown): "start" | "stop" | "restart" | "reload" {
  if (value !== "start" && value !== "stop" && value !== "restart" && value !== "reload") {
    throw new Error("action must be start, stop, restart, or reload");
  }
  return value;
}

export function createLinuxTools(linux: LinuxSshClient): AgentTool[] {
  return [
    {
      name: "linux_get_connection_status",
      description: "Check whether the Linux SSH capability pack is configured and inspect the configured SSH target without exposing private key contents.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => linux.status(),
    },
    {
      name: "linux_probe_connection",
      description: "Safely verify SSH connectivity to the configured Linux host and return the remote hostname, current user, kernel, and uptime. Use this for a bare ssh/connect request before any mutating command.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => linux.execute("printf '%s\\n' '--- hostname ---'; hostname; printf '%s\\n' '--- user ---'; id -un; printf '%s\\n' '--- kernel ---'; uname -sr; printf '%s\\n' '--- uptime ---'; uptime"),
    },
    {
      name: "linux_exec",
      description: "Execute an arbitrary shell command on the configured Linux host over SSH. This is a high-impact escape hatch: prefer narrower Linux tools for diagnostics and only use raw execution when necessary. Always inspect exitCode, stdout and stderr, then verify consequential changes separately.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute remotely" },
          timeoutMs: { type: "number", description: "Optional command timeout in milliseconds" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (args) => linux.execute(
        requiredString(args, "command"),
        optionalInteger(args, "timeoutMs", 30_000),
      ),
    },
    {
      name: "linux_read_file",
      description: "Read up to a bounded number of bytes from one file on the configured Linux host. Because remote files may contain secrets, this tool requires external-action approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or user-relative remote file path" },
          maxBytes: { type: "number", description: "Maximum bytes to return; capped by connector output limits" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (args) => linux.readFile(
        requiredString(args, "path"),
        optionalInteger(args, "maxBytes", 256_000),
      ),
    },
    {
      name: "linux_write_file",
      description: "Replace one file on the configured Linux host with UTF-8 text, optionally using sudo and chmod. Use only after reading the current state, preserving rollback data, and defining verification evidence.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Complete UTF-8 replacement content; maximum 256000 bytes" },
          sudo: { type: "boolean", description: "Use sudo for tee/chmod; defaults to false" },
          mode: { type: "string", description: "Optional chmod mode such as 0644" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const sudo = optionalBoolean(args, "sudo");
        const mode = optionalString(args, "mode");
        return await linux.writeFile(
          requiredString(args, "path"),
          String(args.content ?? ""),
          {
            ...(sudo !== undefined ? { sudo } : {}),
            ...(mode !== undefined ? { mode } : {}),
          },
        );
      },
    },
    {
      name: "linux_service_status",
      description: "Inspect systemd status and key unit state fields for one service on the configured Linux host.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { service: { type: "string", description: "systemd service or unit name, for example nginx or nginx.service" } },
        required: ["service"],
        additionalProperties: false,
      },
      execute: async (args) => linux.serviceStatus(requiredString(args, "service")),
    },
    {
      name: "linux_service_action",
      description: "Start, stop, restart or reload a systemd service on the configured Linux host. Verify resulting service state and application health after execution.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string" },
          action: { type: "string", enum: ["start", "stop", "restart", "reload"] },
          sudo: { type: "boolean", description: "Use sudo; defaults to true" },
        },
        required: ["service", "action"],
        additionalProperties: false,
      },
      execute: async (args) => linux.serviceAction(
        requiredString(args, "service"),
        serviceAction(args.action),
        optionalBoolean(args, "sudo") ?? true,
      ),
    },
    {
      name: "linux_logs",
      description: "Read recent journalctl logs for one systemd unit, optionally constrained by a systemd-compatible --since expression.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          unit: { type: "string" },
          lines: { type: "number", description: "Number of recent log lines; maximum 5000" },
          since: { type: "string", description: "Optional journalctl --since value such as '30 minutes ago'" },
        },
        required: ["unit"],
        additionalProperties: false,
      },
      execute: async (args) => linux.logs(
        requiredString(args, "unit"),
        optionalInteger(args, "lines", 200),
        optionalString(args, "since"),
      ),
    },
    {
      name: "linux_disk_status",
      description: "Inspect Linux filesystem capacity, filesystem types and inode usage for disk-full diagnosis.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => linux.diskStatus(),
    },
    {
      name: "linux_process_list",
      description: "List Linux processes ordered by CPU usage with PID, parent PID, user, CPU, memory, state, elapsed time and command details.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Maximum processes to return; capped at 200" } },
        additionalProperties: false,
      },
      execute: async (args) => linux.processList(optionalInteger(args, "limit", 30)),
    },
    {
      name: "linux_network_status",
      description: "Inspect Linux interface addresses, routes and listening TCP/UDP sockets using ip and ss.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => linux.networkStatus(),
    },
    {
      name: "linux_verify_http",
      description: "Verify an HTTP or HTTPS endpoint from the configured Linux host using curl and return explicit verification status.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          expectedStatus: { type: "number", description: "Expected HTTP status code; defaults to 200" },
          timeoutSeconds: { type: "number", description: "curl timeout in seconds; maximum 120" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      execute: async (args) => linux.verifyHttp(
        requiredString(args, "url"),
        optionalInteger(args, "expectedStatus", 200),
        optionalInteger(args, "timeoutSeconds", 10),
      ),
    },
  ];
}
