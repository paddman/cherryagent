import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CherryNode = {
  id: string;
  tenantId: string;
  name: string;
  platform: string;
  arch: string;
  version: string;
  capabilities: string[];
  workspace?: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
};

export type PublicCherryNode = Omit<CherryNode, "tokenHash"> & { online: boolean };

type PairingCode = {
  id: string;
  tenantId: string;
  codeHash: string;
  name?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
};

type NodeBinding = {
  tenantId: string;
  chatId: string;
  nodeId: string;
  updatedAt: string;
};

export type NodeTaskResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

export type NodeTask = {
  id: string;
  tenantId: string;
  nodeId: string;
  operation: string;
  args: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: NodeTaskResult;
};

type NodeData = {
  version: 1;
  nodes: CherryNode[];
  pairingCodes: PairingCode[];
  bindings: NodeBinding[];
  tasks: NodeTask[];
};

function emptyData(): NodeData {
  return { version: 1, nodes: [], pairingCodes: [], bindings: [], tasks: [] };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function publicNode(node: CherryNode, onlineWindowMs: number): PublicCherryNode {
  const { tokenHash: _tokenHash, ...rest } = node;
  return { ...structuredClone(rest), online: Date.now() - Date.parse(node.lastSeenAt) <= onlineWindowMs };
}

export class CherryNodeGateway {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onlineWindowMs = 30_000,
    private readonly taskTimeoutMs = 60_000,
  ) {}

  async createPairingCode(input: { tenantId: string; name?: string; ttlMs?: number }): Promise<{
    id: string;
    code: string;
    expiresAt: string;
  }> {
    const code = `cherry-${randomBytes(18).toString("base64url")}`;
    const pairing: PairingCode = {
      id: randomUUID(),
      tenantId: input.tenantId,
      codeHash: hash(code),
      ...(input.name ? { name: input.name } : {}),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + Math.min(60 * 60_000, Math.max(60_000, input.ttlMs ?? 10 * 60_000))).toISOString(),
    };
    await this.mutate((data) => {
      data.pairingCodes = data.pairingCodes.filter((item) => !item.usedAt && Date.parse(item.expiresAt) > Date.now());
      data.pairingCodes.push(pairing);
    });
    return { id: pairing.id, code, expiresAt: pairing.expiresAt };
  }

  async pair(input: {
    code: string;
    name: string;
    platform: string;
    arch: string;
    version: string;
    capabilities: string[];
    workspace?: string;
  }): Promise<{ token: string; node: PublicCherryNode }> {
    const token = randomBytes(32).toString("base64url");
    let paired: CherryNode | undefined;
    await this.mutate((data) => {
      const codeHash = hash(input.code);
      const pairing = data.pairingCodes.find((item) => !item.usedAt && equalHash(item.codeHash, codeHash));
      if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) throw new Error("Pairing code is invalid or expired");
      const now = new Date().toISOString();
      pairing.usedAt = now;
      paired = {
        id: randomUUID(),
        tenantId: pairing.tenantId,
        name: pairing.name ?? input.name,
        platform: input.platform,
        arch: input.arch,
        version: input.version,
        capabilities: [...new Set(input.capabilities)].sort(),
        ...(input.workspace ? { workspace: input.workspace } : {}),
        tokenHash: hash(token),
        createdAt: now,
        lastSeenAt: now,
      };
      data.nodes.push(paired);
    });
    if (!paired) throw new Error("Node pairing failed");
    return { token, node: publicNode(paired, this.onlineWindowMs) };
  }

  async authenticate(token: string): Promise<CherryNode | undefined> {
    if (!token) return undefined;
    const tokenHash = hash(token);
    const data = await this.read();
    const node = data.nodes.find((item) => equalHash(item.tokenHash, tokenHash));
    return node ? structuredClone(node) : undefined;
  }

  async listNodes(tenantId: string): Promise<PublicCherryNode[]> {
    const data = await this.read();
    return data.nodes
      .filter((node) => node.tenantId === tenantId)
      .map((node) => publicNode(node, this.onlineWindowMs))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async bind(tenantId: string, chatId: string, nodeId: string): Promise<NodeBinding> {
    let binding: NodeBinding | undefined;
    await this.mutate((data) => {
      if (!data.nodes.some((node) => node.tenantId === tenantId && node.id === nodeId)) {
        throw new Error(`Unknown Cherry Node: ${nodeId}`);
      }
      const now = new Date().toISOString();
      const existing = data.bindings.find((item) => item.tenantId === tenantId && item.chatId === chatId);
      if (existing) {
        existing.nodeId = nodeId;
        existing.updatedAt = now;
        binding = existing;
      } else {
        binding = { tenantId, chatId, nodeId, updatedAt: now };
        data.bindings.push(binding);
      }
    });
    if (!binding) throw new Error("Node binding failed");
    return structuredClone(binding);
  }

  async binding(tenantId: string, chatId: string): Promise<{ binding?: NodeBinding; node?: PublicCherryNode }> {
    const data = await this.read();
    const binding = data.bindings.find((item) => item.tenantId === tenantId && item.chatId === chatId);
    if (!binding) return {};
    const node = data.nodes.find((item) => item.id === binding.nodeId && item.tenantId === tenantId);
    return {
      binding: structuredClone(binding),
      ...(node ? { node: publicNode(node, this.onlineWindowMs) } : {}),
    };
  }

  async resolveNode(tenantId: string, chatId: string): Promise<PublicCherryNode> {
    const current = await this.binding(tenantId, chatId);
    if (current.node) return current.node;
    const nodes = await this.listNodes(tenantId);
    if (nodes.length === 1 && nodes[0]) {
      await this.bind(tenantId, chatId, nodes[0].id);
      return nodes[0];
    }
    if (nodes.length === 0) throw new Error("No Cherry Node is paired. Create a pairing code and start cherry-node on the target machine.");
    throw new Error("This chat is not bound to a Cherry Node. Use node_list and node_bind_chat first.");
  }

  async dispatch(input: {
    tenantId: string;
    chatId: string;
    operation: string;
    capability: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<{ node: PublicCherryNode; task: NodeTask; result: NodeTaskResult }> {
    const node = await this.resolveNode(input.tenantId, input.chatId);
    if (!node.capabilities.includes(input.capability)) {
      throw new Error(`Cherry Node '${node.name}' does not advertise capability '${input.capability}'`);
    }
    const task: NodeTask = {
      id: randomUUID(),
      tenantId: input.tenantId,
      nodeId: node.id,
      operation: input.operation,
      args: structuredClone(input.args),
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    await this.mutate((data) => {
      data.tasks.push(task);
      this.pruneTasks(data);
    });

    const timeoutMs = Math.min(10 * 60_000, Math.max(1_000, input.timeoutMs ?? this.taskTimeoutMs));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = (await this.read()).tasks.find((item) => item.id === task.id);
      if (current?.result && (current.status === "completed" || current.status === "failed")) {
        if (!current.result.ok) throw new Error(current.result.error ?? `Node task ${current.id} failed`);
        return { node, task: structuredClone(current), result: structuredClone(current.result) };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await this.mutate((data) => {
      const current = data.tasks.find((item) => item.id === task.id);
      if (current && current.status !== "completed" && current.status !== "failed") {
        current.status = "failed";
        current.completedAt = new Date().toISOString();
        current.result = { ok: false, error: `Node task timed out after ${timeoutMs} ms` };
      }
    });
    throw new Error(`Cherry Node '${node.name}' did not complete task ${task.id} within ${timeoutMs} ms`);
  }

  async poll(nodeId: string): Promise<NodeTask | undefined> {
    let task: NodeTask | undefined;
    await this.mutate((data) => {
      const node = data.nodes.find((item) => item.id === nodeId);
      if (!node) throw new Error("Unknown Cherry Node");
      node.lastSeenAt = new Date().toISOString();
      task = data.tasks.find((item) => item.nodeId === nodeId && item.status === "queued");
      if (task) {
        task.status = "running";
        task.startedAt = new Date().toISOString();
      }
    });
    return task ? structuredClone(task) : undefined;
  }

  async complete(nodeId: string, taskId: string, result: NodeTaskResult): Promise<NodeTask> {
    let completed: NodeTask | undefined;
    await this.mutate((data) => {
      const node = data.nodes.find((item) => item.id === nodeId);
      if (!node) throw new Error("Unknown Cherry Node");
      node.lastSeenAt = new Date().toISOString();
      const task = data.tasks.find((item) => item.id === taskId && item.nodeId === nodeId);
      if (!task) throw new Error(`Unknown node task: ${taskId}`);
      if (task.status !== "running") throw new Error(`Node task ${taskId} is not running`);
      task.status = result.ok ? "completed" : "failed";
      task.result = structuredClone(result);
      task.completedAt = new Date().toISOString();
      completed = task;
    });
    if (!completed) throw new Error("Node task completion failed");
    return structuredClone(completed);
  }

  private async read(): Promise<NodeData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<NodeData>;
      return {
        version: 1,
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        pairingCodes: Array.isArray(parsed.pairingCodes) ? parsed.pairingCodes : [],
        bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw error;
    }
  }

  private async mutate(mutator: (data: NodeData) => void): Promise<void> {
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

  private pruneTasks(data: NodeData): void {
    const retained = data.tasks
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 2_000);
    data.tasks = retained;
  }
}
