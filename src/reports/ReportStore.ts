import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReportRecord } from "./types.js";

type ReportState = { version: 1; reports: ReportRecord[] };
type ReportPatch = { [Key in keyof ReportRecord]?: ReportRecord[Key] | undefined };

function emptyState(): ReportState { return { version: 1, reports: [] }; }

export class ReportStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async create(record: ReportRecord): Promise<ReportRecord> {
    return this.#mutate((state) => {
      state.reports.unshift(record);
      return record;
    });
  }

  async update(id: string, tenantId: string, patch: ReportPatch): Promise<ReportRecord> {
    return this.#mutate((state) => {
      const report = state.reports.find((item) => item.id === id && item.tenantId === tenantId);
      if (!report) throw new Error(`Report not found: ${id}`);
      Object.assign(report, patch, { id: report.id, tenantId: report.tenantId, updatedAt: new Date().toISOString() });
      return report;
    });
  }

  async get(id: string, tenantId: string): Promise<ReportRecord> {
    const state = await this.#readState();
    const report = state.reports.find((item) => item.id === id && item.tenantId === tenantId);
    if (!report) throw new Error(`Report not found: ${id}`);
    return structuredClone(report);
  }

  async list(tenantId: string, limit = 50): Promise<ReportRecord[]> {
    const state = await this.#readState();
    return structuredClone(state.reports.filter((item) => item.tenantId === tenantId).slice(0, Math.max(1, Math.min(500, limit))));
  }

  async active(): Promise<ReportRecord[]> {
    const state = await this.#readState();
    return structuredClone(state.reports.filter((item) => item.status === "queued" || item.status === "running"));
  }

  async remove(id: string, tenantId: string): Promise<ReportRecord> {
    return this.#mutate((state) => {
      const index = state.reports.findIndex((item) => item.id === id && item.tenantId === tenantId);
      if (index < 0) throw new Error(`Report not found: ${id}`);
      const [removed] = state.reports.splice(index, 1);
      if (!removed) throw new Error(`Report not found: ${id}`);
      return removed;
    });
  }

  async expired(now = new Date()): Promise<ReportRecord[]> {
    const state = await this.#readState();
    return structuredClone(state.reports.filter((item) => Date.parse(item.expiresAt) <= now.getTime()));
  }

  async #readState(): Promise<ReportState> {
    await this.#queue;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<ReportState>;
      return parsed.version === 1 && Array.isArray(parsed.reports) ? { version: 1, reports: parsed.reports } : emptyState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async #mutate<T>(mutation: (state: ReportState) => T): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.#queue = this.#queue.catch(() => undefined).then(async () => {
      try {
        let state: ReportState;
        try {
          const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<ReportState>;
          state = parsed.version === 1 && Array.isArray(parsed.reports) ? { version: 1, reports: parsed.reports } : emptyState();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          state = emptyState();
        }
        const value = mutation(state);
        await mkdir(dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
        await rename(temp, this.filePath);
        resolveResult(structuredClone(value));
      } catch (error) { rejectResult(error); }
    });
    return result;
  }
}
