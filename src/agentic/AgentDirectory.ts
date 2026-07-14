import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentRole } from "./AgenticStateStore.js";

export type SubAgentProfile = {
  id: string;
  name: string;
  role: AgentRole;
  mission: string;
  instructions?: string;
  enabled: boolean;
  builtin: boolean;
};

type AgentDirectoryState = {
  version: 1;
  customAgents: SubAgentProfile[];
};

const BUILTIN_SUB_AGENTS: readonly SubAgentProfile[] = [
  {
    id: "mira",
    name: "Mira",
    role: "office",
    mission: "Own office operations, email, calendar, Drive, notes, follow-up, and administrative execution.",
    enabled: true,
    builtin: true,
  },
  {
    id: "navi",
    name: "Navi",
    role: "planner",
    mission: "Turn goals into dependency-aware plans, schedules, reminders, priorities, and executable work queues.",
    enabled: true,
    builtin: true,
  },
  {
    id: "atlas",
    name: "Atlas",
    role: "infra",
    mission: "Operate and investigate infrastructure across Proxmox, vSphere, VMs, hosts, storage, networking, and cloud systems.",
    enabled: true,
    builtin: true,
  },
  {
    id: "lyra",
    name: "Lyra",
    role: "market",
    mission: "Handle market intelligence, crypto exchange data, analysis, and approval-gated trading actions.",
    enabled: true,
    builtin: true,
  },
  {
    id: "iris",
    name: "Iris",
    role: "research",
    mission: "Collect, cross-check, and synthesize research, news, financials, files, and evidence into grounded findings.",
    enabled: true,
    builtin: true,
  },
  {
    id: "nox",
    name: "Nox",
    role: "database",
    mission: "Inspect and operate PostgreSQL, MySQL, SQLite, and Redis under strict evidence and risk controls.",
    enabled: true,
    builtin: true,
  },
  {
    id: "forge",
    name: "Forge",
    role: "engineer",
    mission: "Solve incidents and technical problems through diagnose, patch, test, verify, and reusable runbook learning.",
    enabled: true,
    builtin: true,
  },
  {
    id: "scout",
    name: "Scout",
    role: "general",
    mission: "Handle cross-domain reconnaissance, bridge gaps between specialists, and execute work that has no narrower owner.",
    enabled: true,
    builtin: true,
  },
  {
    id: "raven",
    name: "Raven",
    role: "critic",
    mission: "Challenge assumptions, detect contradictions, expose missing evidence, and identify uncompleted requirements or hidden risk.",
    enabled: true,
    builtin: true,
  },
  {
    id: "vera",
    name: "Vera",
    role: "verifier",
    mission: "Independently verify that final claims are supported by observable evidence before Cherry reports completion.",
    enabled: true,
    builtin: true,
  },
];

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyState(): AgentDirectoryState {
  return { version: 1, customAgents: [] };
}

export class AgentDirectory {
  #state: AgentDirectoryState = emptyState();
  #loaded = false;
  #queue: Promise<void> = Promise.resolve();
  #cursor = new Map<AgentRole, number>();

  constructor(private readonly file: string) {}

  async list(input: { role?: AgentRole; enabledOnly?: boolean } = {}): Promise<SubAgentProfile[]> {
    await this.#load();
    return this.#all()
      .filter((agent) => !input.role || agent.role === input.role)
      .filter((agent) => !input.enabledOnly || agent.enabled)
      .map(clone);
  }

  async get(id: string): Promise<SubAgentProfile> {
    await this.#load();
    const normalized = normalizeId(id);
    const agent = this.#all().find((item) => item.id === normalized);
    if (!agent) throw new Error(`Sub-agent not found: ${id}`);
    return clone(agent);
  }

  async add(input: {
    id?: string;
    name: string;
    role: AgentRole;
    mission: string;
    instructions?: string;
  }): Promise<SubAgentProfile> {
    if (input.role === "orchestrator") throw new Error("Cherry is the orchestrator; custom workers cannot use the orchestrator role");
    const name = input.name.trim();
    const mission = input.mission.trim();
    if (!name) throw new Error("Sub-agent name is required");
    if (!mission) throw new Error("Sub-agent mission is required");
    const id = normalizeId(input.id ?? name);
    if (!id) throw new Error("Sub-agent id is required");

    return await this.#mutate((state) => {
      if (this.#all(state).some((agent) => agent.id === id)) throw new Error(`Sub-agent id already exists: ${id}`);
      const profile: SubAgentProfile = {
        id,
        name,
        role: input.role,
        mission,
        enabled: true,
        builtin: false,
        ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
      };
      state.customAgents.push(profile);
      return clone(profile);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<SubAgentProfile> {
    const normalized = normalizeId(id);
    if (BUILTIN_SUB_AGENTS.some((agent) => agent.id === normalized)) {
      throw new Error("Built-in sub-agents cannot be disabled; add or select custom workers instead");
    }
    return await this.#mutate((state) => {
      const agent = state.customAgents.find((item) => item.id === normalized);
      if (!agent) throw new Error(`Custom sub-agent not found: ${id}`);
      agent.enabled = enabled;
      return clone(agent);
    });
  }

  async selectForRole(role: AgentRole): Promise<SubAgentProfile> {
    const candidates = await this.list({ role, enabledOnly: true });
    if (!candidates.length) {
      return {
        id: role,
        name: role.charAt(0).toUpperCase() + role.slice(1),
        role,
        mission: `Handle ${role} work assigned by Cherry Orchestrator.`,
        enabled: true,
        builtin: true,
      };
    }
    const cursor = this.#cursor.get(role) ?? 0;
    const selected = candidates[cursor % candidates.length]!;
    this.#cursor.set(role, cursor + 1);
    return selected;
  }

  async rosterSummary(): Promise<string> {
    const agents = await this.list({ enabledOnly: true });
    return agents.map((agent) => `${agent.name} (${agent.id}) -> ${agent.role}: ${agent.mission}`).join("\n");
  }

  #all(state = this.#state): SubAgentProfile[] {
    return [...BUILTIN_SUB_AGENTS, ...state.customAgents];
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<AgentDirectoryState>;
      this.#state = {
        version: 1,
        customAgents: Array.isArray(parsed.customAgents)
          ? parsed.customAgents.filter((item): item is SubAgentProfile => Boolean(item && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string" && typeof item.role === "string" && typeof item.mission === "string" && typeof item.enabled === "boolean"))
            .map((item) => ({ ...item, builtin: false }))
          : [],
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw error;
      this.#state = emptyState();
    }
    this.#loaded = true;
  }

  async #mutate<T>(mutation: (state: AgentDirectoryState) => T): Promise<T> {
    await this.#load();
    let result!: T;
    const operation = this.#queue.then(async () => {
      result = mutation(this.#state);
      await this.#persist();
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.#state, null, 2), "utf8");
    await rename(temporary, this.file);
  }
}

let singleton: AgentDirectory | undefined;

export function getAgentDirectory(): AgentDirectory {
  singleton ??= new AgentDirectory(resolve(process.env.CHERRY_AGENT_ROSTER_FILE ?? ".cherry/agents.json"));
  return singleton;
}

export { BUILTIN_SUB_AGENTS };
