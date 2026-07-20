import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RiskLevel, JsonSchema } from "../core/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { McpServerConfig, McpServerStore } from "./McpServerStore.js";

type McpRuntime = {
  config: McpServerConfig;
  client?: Client;
  toolNames: string[];
  status: "connected" | "disconnected" | "error";
  error?: string;
  serverVersion?: { name: string; version: string };
};

export type McpServerStatus = {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  transport: McpServerConfig["connection"]["transport"];
  status: McpRuntime["status"];
  tools: string[];
  serverVersion?: { name: string; version: string };
  error?: string;
};

const knownRisks = new Set<RiskLevel>(["safe", "write", "external", "dangerous"]);

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

function exposedName(server: McpServerConfig, toolName: string): string {
  return `mcp_${slug(server.name).slice(0, 18)}_${server.id.slice(0, 6)}_${slug(toolName)}`.slice(0, 64);
}

function riskFor(server: McpServerConfig, tool: {
  name: string;
  annotations?: { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined; openWorldHint?: boolean | undefined } | undefined;
}): RiskLevel {
  const override = server.toolRisks?.[tool.name];
  if (override && knownRisks.has(override)) return override;
  if (tool.annotations?.destructiveHint) return "dangerous";
  if (tool.annotations?.readOnlyHint && tool.annotations.openWorldHint === false) return "safe";
  return server.risk;
}

function inputSchema(value: { type: "object"; properties?: Record<string, object> | undefined; required?: string[] | undefined }): JsonSchema {
  return {
    type: "object",
    properties: value.properties ?? {},
    ...(value.required ? { required: value.required } : {}),
    additionalProperties: true,
  };
}

function environment(mapping?: Record<string, string>): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const [targetName, sourceName] of Object.entries(mapping ?? {})) {
    const value = process.env[sourceName];
    if (value !== undefined) env[targetName] = value;
  }
  return env;
}

function headers(mapping?: Record<string, string>): Headers {
  const result = new Headers();
  for (const [targetName, sourceName] of Object.entries(mapping ?? {})) {
    const value = process.env[sourceName];
    if (value !== undefined) result.set(targetName, value);
  }
  return result;
}

export class McpToolHub {
  readonly #runtimes = new Map<string, McpRuntime>();

  constructor(
    private readonly store: McpServerStore,
    private readonly tools: ToolRegistry,
  ) {}

  async initialize(): Promise<McpServerStatus[]> {
    const servers = await this.store.list();
    for (const server of servers) {
      if (server.enabled) await this.connect(server).catch(() => undefined);
      else this.#runtimes.set(server.id, { config: server, toolNames: [], status: "disconnected" });
    }
    return this.statuses();
  }

  statuses(tenantId?: string): McpServerStatus[] {
    return [...this.#runtimes.values()]
      .filter((runtime) => !tenantId || runtime.config.tenantId === tenantId)
      .map((runtime) => ({
        id: runtime.config.id,
        tenantId: runtime.config.tenantId,
        name: runtime.config.name,
        enabled: runtime.config.enabled,
        transport: runtime.config.connection.transport,
        status: runtime.status,
        tools: [...runtime.toolNames],
        ...(runtime.serverVersion ? { serverVersion: runtime.serverVersion } : {}),
        ...(runtime.error ? { error: runtime.error } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async add(input: Parameters<McpServerStore["create"]>[0]): Promise<McpServerStatus> {
    const config = await this.store.create(input);
    if (config.enabled) await this.connect(config).catch(() => undefined);
    else this.#runtimes.set(config.id, { config, toolNames: [], status: "disconnected" });
    return this.requireStatus(config.id);
  }

  async reconnect(id: string, tenantId: string): Promise<McpServerStatus> {
    const config = await this.store.get(id, tenantId);
    if (!config) throw new Error(`Unknown MCP server: ${id}`);
    await this.disconnect(id);
    await this.connect(config);
    return this.requireStatus(id);
  }

  async remove(id: string, tenantId: string): Promise<boolean> {
    await this.disconnect(id);
    return this.store.remove(id, tenantId);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map((id) => this.disconnect(id)));
  }

  private requireStatus(id: string): McpServerStatus {
    const status = this.statuses().find((item) => item.id === id);
    if (!status) throw new Error(`Unknown MCP runtime: ${id}`);
    return status;
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const runtime: McpRuntime = { config, toolNames: [], status: "disconnected" };
    this.#runtimes.set(config.id, runtime);
    try {
      const client = new Client({ name: "CherryAgent", version: "0.1.0" }, { capabilities: {} });
      let transport: StdioClientTransport | StreamableHTTPClientTransport;
      if (config.connection.transport === "stdio") {
        transport = new StdioClientTransport({
          command: config.connection.command,
          ...(config.connection.args ? { args: config.connection.args } : {}),
          ...(config.connection.cwd ? { cwd: config.connection.cwd } : {}),
          env: environment(config.connection.envFrom),
          stderr: "pipe",
        });
      } else {
        transport = new StreamableHTTPClientTransport(new URL(config.connection.url), {
          requestInit: { headers: headers(config.connection.headersFrom) },
        });
      }
      runtime.client = client;
      await client.connect(transport as unknown as Transport);

      let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of result.tools) {
          const name = exposedName(config, tool.name);
          if (runtime.toolNames.includes(name)) throw new Error(`MCP tool name collision: ${name}`);
          runtime.toolNames.push(name);
          this.tools.replace({
            name,
            description: `[MCP:${config.name}] ${tool.description ?? tool.name}`,
            risk: riskFor(config, tool),
            parameters: inputSchema(tool.inputSchema),
            execute: async (args, context) => {
              if (context.tenantId !== config.tenantId) throw new Error("MCP server is not available to this tenant");
              const active = this.#runtimes.get(config.id);
              if (!active?.client || active.status !== "connected") throw new Error(`MCP server '${config.name}' is not connected`);
              const output = await active.client.callTool({ name: tool.name, arguments: args });
              if ("isError" in output && output.isError) {
                const detail = "content" in output ? JSON.stringify(output.content) : JSON.stringify(output);
                throw new Error(`MCP tool '${tool.name}' failed: ${detail}`);
              }
              return { serverId: config.id, server: config.name, tool: tool.name, result: output };
            },
          });
        }
        cursor = result.nextCursor;
      } while (cursor);

      const version = client.getServerVersion();
      runtime.status = "connected";
      if (version) runtime.serverVersion = { name: version.name, version: version.version };
    } catch (error) {
      runtime.status = "error";
      runtime.error = error instanceof Error ? error.message : String(error);
      for (const name of runtime.toolNames) this.tools.unregister(name);
      runtime.toolNames = [];
      await runtime.client?.close().catch(() => undefined);
      throw error;
    }
  }

  private async disconnect(id: string): Promise<void> {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    for (const name of runtime.toolNames) this.tools.unregister(name);
    await runtime.client?.close().catch(() => undefined);
    this.#runtimes.delete(id);
  }
}
