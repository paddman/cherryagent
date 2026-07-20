import type { AgentTool, ToolContext } from "../../core/types.js";
import type { CherryNodeGateway } from "../../nodes/CherryNodeGateway.js";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function run(
  gateway: CherryNodeGateway,
  context: ToolContext,
  operation: string,
  capability: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const result = await gateway.dispatch({
    tenantId: context.tenantId,
    chatId: context.sessionId,
    operation,
    capability,
    args,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return {
    node: { id: result.node.id, name: result.node.name, platform: result.node.platform, online: result.node.online },
    taskId: result.task.id,
    operation,
    output: result.result.output,
  };
}

export function createNodeTools(gateway: CherryNodeGateway): AgentTool[] {
  return [
    {
      name: "node_list",
      description: "List Cherry Nodes paired with this workspace, including capabilities and online state.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, context) => gateway.listNodes(context.tenantId),
    },
    {
      name: "node_get_binding",
      description: "Show which Cherry Node is bound to the current Chat ID.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, context) => gateway.binding(context.tenantId, context.sessionId),
    },
    {
      name: "node_bind_chat",
      description: "Bind the current Chat ID to a paired Cherry Node so subsequent node_* actions run there.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { nodeId: { type: "string", description: "Node ID from node_list" } },
        required: ["nodeId"],
        additionalProperties: false,
      },
      execute: async (args, context) => gateway.bind(context.tenantId, context.sessionId, requiredString(args, "nodeId")),
    },
    {
      name: "node_system_info",
      description: "Get verified OS, architecture, hostname, user, uptime, and workspace evidence from the bound Cherry Node.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, context) => run(gateway, context, "system_info", "system_info", {}),
    },
    {
      name: "node_process_list",
      description: "List processes on the bound Cherry Node.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, context) => run(gateway, context, "process_list", "process_list", {}),
    },
    {
      name: "node_read_file",
      description: "Read a UTF-8 file from the bound Cherry Node. File access is restricted by the node's local workspace policy.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          maxBytes: { type: "number", minimum: 1, maximum: 1000000 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (args, context) => run(gateway, context, "read_file", "read_file", {
        path: requiredString(args, "path"),
        ...(typeof args.maxBytes === "number" ? { maxBytes: args.maxBytes } : {}),
      }),
    },
    {
      name: "node_write_file",
      description: "Write a UTF-8 file on the bound Cherry Node. Requires dangerous approval and obeys the node's local workspace policy.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      execute: async (args, context) => run(gateway, context, "write_file", "write_file", {
        path: requiredString(args, "path"),
        content: typeof args.content === "string" ? args.content : "",
      }),
    },
    {
      name: "node_exec",
      description: "Execute an approved shell command on the bound Cherry Node as the node daemon's OS user and return bounded stdout/stderr evidence.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number", minimum: 1000, maximum: 600000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const timeoutMs = typeof args.timeoutMs === "number" ? Math.min(600_000, Math.max(1_000, args.timeoutMs)) : 60_000;
        return run(gateway, context, "exec", "exec", {
          command: requiredString(args, "command"),
          ...(optionalString(args, "cwd") ? { cwd: optionalString(args, "cwd") } : {}),
          timeoutMs,
        }, timeoutMs + 5_000);
      },
    },
  ];
}
