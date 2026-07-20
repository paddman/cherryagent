import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RiskLevel } from "../core/types.js";

export type UsageKind = "tool_call" | "workflow_run" | "office_inbox" | "report_run";

export type UsageEvent = {
  id: string;
  tenantId: string;
  userId: string;
  kind: UsageKind;
  units: number;
  tool?: string;
  risk?: RiskLevel;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type UsageState = {
  version: 1;
  monthlyBudgets: Record<string, number>;
  events: UsageEvent[];
};

export type UsageDecision = {
  allowed: boolean;
  units: number;
  used: number;
  budget: number;
  remaining: number;
  event?: UsageEvent;
  reason?: string;
};

function emptyState(): UsageState {
  return { version: 1, monthlyBudgets: {}, events: [] };
}

function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function defaultBudget(): number {
  return 10_000;
}

function unitsForRisk(risk: RiskLevel): number {
  return { safe: 1, write: 2, external: 5, dangerous: 8 }[risk];
}

export class UsageStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async tryConsume(input: {
    tenantId: string;
    userId: string;
    kind: UsageKind;
    units?: number;
    tool?: string;
    risk?: RiskLevel;
    metadata?: Record<string, unknown>;
  }): Promise<UsageDecision> {
    return this.#mutate((state) => {
      const units = Math.max(1, Math.round(input.units ?? (input.risk ? unitsForRisk(input.risk) : 1)));
      const currentMonth = monthKey();
      const used = state.events
        .filter((event) => event.tenantId === input.tenantId && monthKey(new Date(event.createdAt)) === currentMonth)
        .reduce((sum, event) => sum + event.units, 0);
      const budget = state.monthlyBudgets[input.tenantId] ?? defaultBudget();
      if (used + units > budget) {
        return {
          allowed: false,
          units,
          used,
          budget,
          remaining: Math.max(0, budget - used),
          reason: `Monthly usage budget exceeded for tenant ${input.tenantId}`,
        };
      }
      const event: UsageEvent = {
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        userId: input.userId,
        kind: input.kind,
        units,
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.risk ? { risk: input.risk } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        createdAt: new Date().toISOString(),
      };
      state.events.unshift(event);
      if (state.events.length > 100_000) state.events.length = 100_000;
      return { allowed: true, units, used: used + units, budget, remaining: budget - used - units, event };
    });
  }

  async setBudget(tenantId: string, monthlyCredits: number): Promise<{ tenantId: string; monthlyCredits: number }> {
    return this.#mutate((state) => {
      const value = Math.max(1, Math.round(monthlyCredits));
      state.monthlyBudgets[tenantId] = value;
      return { tenantId, monthlyCredits: value };
    });
  }

  async dashboard(tenantId: string): Promise<{
    tenantId: string;
    period: string;
    used: number;
    budget: number;
    remaining: number;
    percent: number;
    events: number;
    byKind: Record<UsageKind, number>;
    byTool: Array<{ tool: string; units: number; calls: number }>;
  }> {
    return this.#read((state) => {
      const period = monthKey();
      const events = state.events.filter((event) => event.tenantId === tenantId && monthKey(new Date(event.createdAt)) === period);
      const used = events.reduce((sum, event) => sum + event.units, 0);
      const budget = state.monthlyBudgets[tenantId] ?? defaultBudget();
      const byTool = new Map<string, { units: number; calls: number }>();
      for (const event of events) {
        const tool = event.tool ?? event.kind;
        const current = byTool.get(tool) ?? { units: 0, calls: 0 };
        current.units += event.units;
        current.calls += 1;
        byTool.set(tool, current);
      }
      return {
        tenantId,
        period,
        used,
        budget,
        remaining: Math.max(0, budget - used),
        percent: budget ? Math.round((used / budget) * 100) : 100,
        events: events.length,
        byKind: {
          tool_call: events.filter((event) => event.kind === "tool_call").reduce((sum, event) => sum + event.units, 0),
          workflow_run: events.filter((event) => event.kind === "workflow_run").reduce((sum, event) => sum + event.units, 0),
          office_inbox: events.filter((event) => event.kind === "office_inbox").reduce((sum, event) => sum + event.units, 0),
          report_run: events.filter((event) => event.kind === "report_run").reduce((sum, event) => sum + event.units, 0),
        },
        byTool: [...byTool.entries()].map(([tool, value]) => ({ tool, ...value })).sort((a, b) => b.units - a.units).slice(0, 50),
      };
    });
  }

  async listEvents(tenantId: string, limit = 100): Promise<UsageEvent[]> {
    return this.#read((state) => state.events.filter((event) => event.tenantId === tenantId).slice(0, Math.min(1000, Math.max(1, limit))));
  }

  async #readState(): Promise<UsageState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<UsageState>;
      return parsed.version === 1 && Array.isArray(parsed.events)
        ? { version: 1, monthlyBudgets: parsed.monthlyBudgets ?? {}, events: parsed.events }
        : emptyState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async #read<T>(reader: (state: UsageState) => T): Promise<T> {
    await this.#queue;
    return reader(await this.#readState());
  }

  async #mutate<T>(mutation: (state: UsageState) => T): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.#queue = this.#queue.catch(() => undefined).then(async () => {
      try {
        const state = await this.#readState();
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
