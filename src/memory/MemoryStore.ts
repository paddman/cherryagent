import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type OfficeTask = {
  id: string;
  title: string;
  due?: string;
  status: "open" | "done";
  createdAt: string;
};

export type OfficeNote = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
};

type MemoryData = {
  tasks: OfficeTask[];
  notes: OfficeNote[];
  facts: Record<string, string>;
};

const emptyMemory = (): MemoryData => ({ tasks: [], notes: [], facts: {} });

export class MemoryStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<MemoryData> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as MemoryData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMemory();
      throw error;
    }
  }

  async write(data: MemoryData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  async createTask(input: { title: string; due?: string }): Promise<OfficeTask> {
    const memory = await this.read();
    const task: OfficeTask = {
      id: crypto.randomUUID(),
      title: input.title,
      status: "open",
      createdAt: new Date().toISOString(),
      ...(input.due ? { due: input.due } : {}),
    };
    memory.tasks.push(task);
    await this.write(memory);
    return task;
  }

  async listTasks(status?: OfficeTask["status"]): Promise<OfficeTask[]> {
    const { tasks } = await this.read();
    return status ? tasks.filter((task) => task.status === status) : tasks;
  }

  async completeTask(id: string): Promise<OfficeTask> {
    const memory = await this.read();
    const task = memory.tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.status = "done";
    await this.write(memory);
    return task;
  }

  async createNote(input: { title: string; content: string }): Promise<OfficeNote> {
    const memory = await this.read();
    const note: OfficeNote = {
      id: crypto.randomUUID(),
      title: input.title,
      content: input.content,
      createdAt: new Date().toISOString(),
    };
    memory.notes.push(note);
    await this.write(memory);
    return note;
  }

  async remember(key: string, value: string): Promise<{ key: string; value: string }> {
    const memory = await this.read();
    memory.facts[key] = value;
    await this.write(memory);
    return { key, value };
  }

  async recall(key: string): Promise<string | null> {
    const memory = await this.read();
    return memory.facts[key] ?? null;
  }
}
