import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_TENANT_ID } from "../tenancy/constants.js";

export type OfficeInboxStatus = "new" | "triaged" | "ignored";

export type OfficeInboxItem = {
  id: string;
  tenantId: string;
  source: "gmail";
  externalId: string;
  threadId?: string;
  subject: string;
  from: string;
  to?: string;
  date?: string;
  snippet: string;
  status: OfficeInboxStatus;
  planItemId?: string;
  createdAt: string;
  updatedAt: string;
};

type InboxState = { version: 1; items: OfficeInboxItem[] };

function emptyState(): InboxState { return { version: 1, items: [] }; }

export class OfficeInboxStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async upsertMany(items: OfficeInboxItem[]): Promise<OfficeInboxItem[]> {
    return this.#mutate((state) => {
      const created: OfficeInboxItem[] = [];
      for (const input of items) {
        const existing = state.items.find((item) => item.tenantId === input.tenantId && item.externalId === input.externalId);
        if (existing) {
          existing.subject = input.subject;
          existing.from = input.from;
          existing.snippet = input.snippet;
          if (input.threadId) existing.threadId = input.threadId;
          if (input.to) existing.to = input.to;
          if (input.date) existing.date = input.date;
          existing.updatedAt = new Date().toISOString();
          created.push(existing);
        } else {
          state.items.unshift(input);
          created.push(input);
        }
      }
      if (state.items.length > 10_000) state.items.length = 10_000;
      return created;
    });
  }

  async list(tenantId = DEFAULT_TENANT_ID, status?: OfficeInboxStatus): Promise<OfficeInboxItem[]> {
    const state = await this.#read();
    return state.items.filter((item) => item.tenantId === tenantId && (!status || item.status === status));
  }

  async update(id: string, tenantId: string, patch: { status?: OfficeInboxStatus; planItemId?: string }): Promise<OfficeInboxItem> {
    return this.#mutate((state) => {
      const item = state.items.find((candidate) => candidate.id === id && candidate.tenantId === tenantId);
      if (!item) throw new Error(`Office inbox item not found: ${id}`);
      if (patch.status) item.status = patch.status;
      if (patch.planItemId) item.planItemId = patch.planItemId;
      item.updatedAt = new Date().toISOString();
      return item;
    });
  }

  async #read(): Promise<InboxState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<InboxState>;
      return parsed.version === 1 && Array.isArray(parsed.items) ? { version: 1, items: parsed.items } : emptyState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async #mutate<T>(mutation: (state: InboxState) => T): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.#queue = this.#queue.catch(() => undefined).then(async () => {
      try {
        const state = await this.#read();
        const value = mutation(state);
        await mkdir(dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
        await rename(temp, this.filePath);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }
}
