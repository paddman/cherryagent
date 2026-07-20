import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RiskLevel } from "../core/types.js";

export type McpStdioConfig = {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  envFrom?: Record<string, string>;
};

export type McpHttpConfig = {
  transport: "streamable-http";
  url: string;
  headersFrom?: Record<string, string>;
};

export type McpServerConfig = {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  risk: RiskLevel;
  toolRisks?: Record<string, RiskLevel>;
  connection: McpStdioConfig | McpHttpConfig;
  createdAt: string;
  updatedAt: string;
};

type McpData = {
  version: 1;
  servers: McpServerConfig[];
};

function emptyData(): McpData {
  return { version: 1, servers: [] };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class McpServerStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(tenantId?: string): Promise<McpServerConfig[]> {
    const data = await this.read();
    return clone(data.servers
      .filter((server) => !tenantId || server.tenantId === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name)));
  }

  async get(id: string, tenantId?: string): Promise<McpServerConfig | undefined> {
    const data = await this.read();
    const server = data.servers.find((item) => item.id === id && (!tenantId || item.tenantId === tenantId));
    return server ? clone(server) : undefined;
  }

  async create(input: {
    tenantId: string;
    name: string;
    enabled?: boolean;
    risk?: RiskLevel;
    toolRisks?: Record<string, RiskLevel>;
    connection: McpStdioConfig | McpHttpConfig;
  }): Promise<McpServerConfig> {
    const now = new Date().toISOString();
    const server: McpServerConfig = {
      id: randomUUID(),
      tenantId: input.tenantId,
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      risk: input.risk ?? "external",
      ...(input.toolRisks ? { toolRisks: clone(input.toolRisks) } : {}),
      connection: clone(input.connection),
      createdAt: now,
      updatedAt: now,
    };
    if (!server.name) throw new Error("MCP server name is required");
    await this.mutate((data) => {
      if (data.servers.some((item) => item.tenantId === input.tenantId && item.name.toLowerCase() === server.name.toLowerCase())) {
        throw new Error(`MCP server name already exists: ${server.name}`);
      }
      data.servers.push(server);
    });
    return clone(server);
  }

  async remove(id: string, tenantId: string): Promise<boolean> {
    let removed = false;
    await this.mutate((data) => {
      const index = data.servers.findIndex((item) => item.id === id && item.tenantId === tenantId);
      if (index >= 0) {
        data.servers.splice(index, 1);
        removed = true;
      }
    });
    return removed;
  }

  private async read(): Promise<McpData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<McpData>;
      return { version: 1, servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw error;
    }
  }

  private async mutate(mutator: (data: McpData) => void): Promise<void> {
    const operation = this.#queue.then(async () => {
      const data = await this.read();
      mutator(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}
