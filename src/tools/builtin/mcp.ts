import type { AgentTool } from "../../core/types.js";
import type { McpToolHub } from "../../mcp/McpToolHub.js";

export function createMcpManagementTools(hub: McpToolHub): AgentTool[] {
  return [
    {
      name: "mcp_list_servers",
      description: "List MCP servers connected to Cherry and the dynamically loaded tool names available from each server.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, context) => hub.statuses(context.tenantId),
    },
    {
      name: "mcp_reconnect_server",
      description: "Reconnect an already registered MCP server and refresh its dynamic tools.",
      risk: "external",
      parameters: {
        type: "object",
        properties: { serverId: { type: "string" } },
        required: ["serverId"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        if (typeof args.serverId !== "string" || !args.serverId.trim()) throw new Error("serverId is required");
        return hub.reconnect(args.serverId.trim(), context.tenantId);
      },
    },
  ];
}
