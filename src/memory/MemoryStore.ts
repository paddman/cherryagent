import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_TENANT_ID } from "../tenancy/constants.js";

export type OfficeTask = {
  id: string;
  tenantId: string;
  title: string;
  due?: string;
  status: "open" | "done";
  createdAt: string;
};

export type OfficeNote = {
  id: string;
  tenantId: string;
  title: string;
  content: string;
  createdAt: string;
};

type MemoryData = {
  version: 2;
  tasks: OfficeTask[];
  notes: OfficeNote[];
  facts: Record<string, Record<string, string>>;
};

const emptyMemory = (): MemoryData => ({ version: 2, tasks: [], notes: [], facts: {} });

export class MemoryStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<MemoryData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<MemoryData> & { facts?: unknown };
      const legacyFacts = parsed.facts && typeof parsed.facts === "object" && !Array.isArray(parsed.facts)
        ? parsed.facts as Record<string, unknown>
        : {};
      const facts = Object.values(legacyFacts).every((value) => typeof value === "string")
        ? { [DEFAULT_TENANT_ID]: Object.fromEntries(Object.entries(legacyFacts).filter(([, value]) => typeof value === "string")) as Record<string, string> }
        : Object.fromEntries(Object.entries(legacyFacts).map(([tenantId, value]) => [tenantId, value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {}]));
      return {
        version: 2,
        tasks: (Array.isArray(parsed.tasks) ? parsed.tasks : []).map((task) => ({ ...(task as OfficeTask), tenantId: (task as OfficeTask).tenantId || DEFAULT_TENANT_ID })),
        notes: (Array.isArray(parsed.notes) ? parsed.notes : []).map((note) => ({ ...(note as OfficeNote), tenantId: (note as OfficeNote).tenantId || DEFAULT_TENANT_ID })),
        facts,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMemory();
      throw error;
    }
  }

  async write(data: MemoryData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  async createTask(input: { title: string; due?: string; tenantId?: string }): Promise<OfficeTask> {
    const memory = await this.read();
    const task: OfficeTask = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
      title: input.title,
      status: "open",
      createdAt: new Date().toISOString(),
      ...(input.due ? { due: input.due } : {}),
    };
    memory.tasks.push(task);
    await this.write(memory);
    return task;
  }

  async listTasks(status?: OfficeTask["status"], tenantId = DEFAULT_TENANT_ID): Promise<OfficeTask[]> {
    const { tasks } = await this.read();
    const scoped = tasks.filter((task) => task.tenantId === tenantId);
    return status ? scoped.filter((task) => task.status === status) : scoped;
  }

  async completeTask(id: string, tenantId = DEFAULT_TENANT_ID): Promise<OfficeTask> {
    const memory = await this.read();
    const task = memory.tasks.find((item) => item.id === id && item.tenantId === tenantId);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.status = "done";
    await this.write(memory);
    return task;
  }

  async createNote(input: { title: string; content: string; tenantId?: string }): Promise<OfficeNote> {
    const memory = await this.read();
    const note: OfficeNote = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
      title: input.title,
      content: input.content,
      createdAt: new Date().toISOString(),
    };
    memory.notes.push(note);
    await this.write(memory);
    return note;
  }

  async remember(key: string, value: string, tenantId = DEFAULT_TENANT_ID): Promise<{ key: string; value: string }> {
    const memory = await this.read();
    memory.facts[tenantId] ??= {};
    memory.facts[tenantId][key] = value;
    await this.write(memory);
    return { key, value };
  }

  async recall(key: string, tenantId = DEFAULT_TENANT_ID): Promise<string | null> {
    const memory = await this.read();
    return memory.facts[tenantId]?.[key] ?? null;
  }
}
