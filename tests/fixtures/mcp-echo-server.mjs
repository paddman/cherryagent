import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "cherry-test-echo", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo a value for Cherry Gateway integration tests",
    inputSchema: { value: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ value }) => ({ content: [{ type: "text", text: value }] }),
);

await server.connect(new StdioServerTransport());
