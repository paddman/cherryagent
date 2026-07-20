import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ChatLogStatus = "succeeded" | "failed";

export type ChatLogEntry = {
  id: string;
  chatId: string;
  traceId: string;
  sessionId: string;
  tenantId: string;
  userId: string;
  status: ChatLogStatus;
  createdAt: string;
  completedAt: string;
  durationMs: number;
  steps?: number;
  correctness?: {
    status: string;
    confidence: number;
    passes: number;
  };
  error?: string;
};

type ChatLogData = {
  version: 1;
  entries: ChatLogEntry[];
};

function emptyData(): ChatLogData {
  return { version: 1, entries: [] };
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ChatLogStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = 10_000,
  ) {}

  async list(input: { tenantId: string; chatId?: string; limit?: number }): Promise<ChatLogEntry[]> {
    const data = await this.read();
    const limit = Math.min(500, positiveInteger(input.limit ?? 100, 100));
    return clone(data.entries
      .filter((entry) => entry.tenantId === input.tenantId)
      .filter((entry) => !input.chatId || entry.chatId === input.chatId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit));
  }

  async append(entry: ChatLogEntry): Promise<ChatLogEntry> {
    await this.mutate((data) => {
      data.entries.unshift(entry);
      if (data.entries.length > this.maxEntries) data.entries.length = this.maxEntries;
    });
    return clone(entry);
  }

  private async read(): Promise<ChatLogData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<ChatLogData>;
      return {
        version: 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw error;
    }
  }

  private async mutate(mutator: (data: ChatLogData) => void): Promise<void> {
    const operation = this.#queue.then(async () => {
      const data = await this.read();
      mutator(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}
