import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type EngineerPhase = "plan" | "execute" | "observe" | "diagnose" | "patch" | "test" | "verify" | "learn";
export type EngineerLoopStatus = "running" | "blocked" | "succeeded" | "failed" | "aborted";

export type EngineerLoopEvent = {
  id: string;
  iteration: number;
  phase: EngineerPhase;
  summary: string;
  evidence: string[];
  createdAt: string;
  tool?: string;
  error?: string;
  nextPhase?: EngineerPhase;
};

export type EngineerLoop = {
  id: string;
  objective: string;
  successCriteria: string[];
  status: EngineerLoopStatus;
  phase: EngineerPhase;
  iteration: number;
  maxIterations: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  planItemId?: string;
  hypothesis?: string;
  rootCause?: string;
  fix?: string;
  rollback?: string;
  prevention: string[];
  verificationEvidence: string[];
  stopReason?: string;
  events: EngineerLoopEvent[];
};

export type EngineerRunbook = {
  id: string;
  loopId: string;
  title: string;
  objective: string;
  symptoms: string[];
  rootCause: string;
  fix: string;
  diagnostics: string[];
  verification: string[];
  rollback: string[];
  prevention: string[];
  createdAt: string;
};

type EngineerData = {
  version: 1;
  loops: EngineerLoop[];
  runbooks: EngineerRunbook[];
};

export type EngineerDashboard = {
  generatedAt: string;
  stats: {
    running: number;
    blocked: number;
    succeeded: number;
    failed: number;
    runbooks: number;
  };
  active: EngineerLoop[];
  recent: EngineerLoop[];
  runbooks: EngineerRunbook[];
};

const phases: EngineerPhase[] = ["plan", "execute", "observe", "diagnose", "patch", "test", "verify", "learn"];
const statuses: EngineerLoopStatus[] = ["running", "blocked", "succeeded", "failed", "aborted"];
const allowedTransitions: Record<EngineerPhase, EngineerPhase[]> = {
  plan: ["execute"],
  execute: ["observe"],
  observe: ["diagnose", "verify"],
  diagnose: ["patch", "execute"],
  patch: ["test"],
  test: ["observe", "verify"],
  verify: ["learn", "diagnose"],
  learn: [],
};

function emptyData(): EngineerData {
  return { version: 1, loops: [], runbooks: [] };
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanStrings(values: string[] | undefined, limit = 50): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function requiredText(value: string, name: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

export class EngineerLoopEngine {
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<EngineerData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<EngineerData>;
      return {
        version: 1,
        loops: Array.isArray(parsed.loops) ? parsed.loops : [],
        runbooks: Array.isArray(parsed.runbooks) ? parsed.runbooks : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw error;
    }
  }

  async #mutate<T>(mutator: (data: EngineerData) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.#writeQueue = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const data = await this.read();
          const value = await mutator(data);
          await mkdir(dirname(this.filePath), { recursive: true });
          await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
          resolveResult(value);
        } catch (error) {
          rejectResult(error);
        }
      });

    return result;
  }

  async startLoop(input: {
    objective: string;
    successCriteria: string[];
    maxIterations?: number | undefined;
    planItemId?: string | undefined;
    hypothesis?: string | undefined;
  }): Promise<EngineerLoop> {
    return this.#mutate((data) => {
      const objective = requiredText(input.objective, "objective");
      const successCriteria = cleanStrings(input.successCriteria, 20);
      if (!successCriteria.length) throw new Error("At least one success criterion is required");
      const maxIterations = Math.min(Math.max(Math.round(input.maxIterations ?? 5), 1), 25);
      const now = nowIso();
      const loop: EngineerLoop = {
        id: crypto.randomUUID(),
        objective,
        successCriteria,
        status: "running",
        phase: "plan",
        iteration: 1,
        maxIterations,
        startedAt: now,
        updatedAt: now,
        prevention: [],
        verificationEvidence: [],
        events: [],
        ...(input.planItemId?.trim() ? { planItemId: input.planItemId.trim() } : {}),
        ...(input.hypothesis?.trim() ? { hypothesis: input.hypothesis.trim() } : {}),
      };
      data.loops.push(loop);
      return loop;
    });
  }

  async getLoop(id: string): Promise<EngineerLoop> {
    const data = await this.read();
    const loop = data.loops.find((candidate) => candidate.id === id);
    if (!loop) throw new Error(`Engineer loop not found: ${id}`);
    return loop;
  }

  async listLoops(status?: EngineerLoopStatus): Promise<EngineerLoop[]> {
    if (status && !statuses.includes(status)) throw new Error(`Unknown engineer loop status: ${status}`);
    const data = await this.read();
    return data.loops
      .filter((loop) => !status || loop.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async recordPhase(input: {
    loopId: string;
    phase: EngineerPhase;
    summary: string;
    evidence?: string[] | undefined;
    tool?: string | undefined;
    error?: string | undefined;
    nextPhase?: EngineerPhase | undefined;
  }): Promise<EngineerLoop> {
    return this.#mutate((data) => {
      const loop = data.loops.find((candidate) => candidate.id === input.loopId);
      if (!loop) throw new Error(`Engineer loop not found: ${input.loopId}`);
      if (loop.status !== "running") throw new Error(`Engineer loop ${loop.id} is ${loop.status}, not running`);
      if (!phases.includes(input.phase)) throw new Error(`Unknown engineer phase: ${input.phase}`);
      if (loop.phase !== input.phase) {
        throw new Error(`Engineer loop ${loop.id} expects phase '${loop.phase}', received '${input.phase}'`);
      }

      const summary = requiredText(input.summary, "summary");
      const evidence = cleanStrings(input.evidence, 100);
      const now = nowIso();
      const event: EngineerLoopEvent = {
        id: crypto.randomUUID(),
        iteration: loop.iteration,
        phase: input.phase,
        summary,
        evidence,
        createdAt: now,
        ...(input.tool?.trim() ? { tool: input.tool.trim() } : {}),
        ...(input.error?.trim() ? { error: input.error.trim() } : {}),
        ...(input.nextPhase ? { nextPhase: input.nextPhase } : {}),
      };

      if (input.nextPhase) {
        if (!phases.includes(input.nextPhase)) throw new Error(`Unknown next engineer phase: ${input.nextPhase}`);
        if (!allowedTransitions[input.phase].includes(input.nextPhase)) {
          throw new Error(`Invalid engineer transition: ${input.phase} -> ${input.nextPhase}`);
        }
        loop.phase = input.nextPhase;
      }

      if (input.phase === "diagnose" && summary) loop.hypothesis = summary;
      if (input.phase === "verify" && evidence.length) {
        loop.verificationEvidence = cleanStrings([...loop.verificationEvidence, ...evidence], 200);
      }
      loop.events.push(event);
      loop.updatedAt = now;
      return loop;
    });
  }

  async nextIteration(input: {
    loopId: string;
    diagnosis: string;
    nextAction: string;
  }): Promise<EngineerLoop> {
    return this.#mutate((data) => {
      const loop = data.loops.find((candidate) => candidate.id === input.loopId);
      if (!loop) throw new Error(`Engineer loop not found: ${input.loopId}`);
      if (loop.status !== "running") throw new Error(`Engineer loop ${loop.id} is ${loop.status}, not running`);
      if (loop.iteration >= loop.maxIterations) {
        const now = nowIso();
        loop.status = "failed";
        loop.stopReason = `Retry budget exhausted after ${loop.maxIterations} iterations`;
        loop.completedAt = now;
        loop.updatedAt = now;
        return loop;
      }
      const now = nowIso();
      loop.iteration += 1;
      loop.phase = "plan";
      loop.hypothesis = requiredText(input.diagnosis, "diagnosis");
      loop.updatedAt = now;
      loop.events.push({
        id: crypto.randomUUID(),
        iteration: loop.iteration,
        phase: "plan",
        summary: requiredText(input.nextAction, "nextAction"),
        evidence: [loop.hypothesis],
        createdAt: now,
        nextPhase: "execute",
      });
      loop.phase = "execute";
      return loop;
    });
  }

  async blockLoop(id: string, reason: string): Promise<EngineerLoop> {
    return this.#mutate((data) => {
      const loop = data.loops.find((candidate) => candidate.id === id);
      if (!loop) throw new Error(`Engineer loop not found: ${id}`);
      if (loop.status !== "running") throw new Error(`Engineer loop ${id} cannot be blocked from status ${loop.status}`);
      loop.status = "blocked";
      loop.stopReason = requiredText(reason, "reason");
      loop.updatedAt = nowIso();
      return loop;
    });
  }

  async resumeLoop(id: string, note?: string): Promise<EngineerLoop> {
    return this.#mutate((data) => {
      const loop = data.loops.find((candidate) => candidate.id === id);
      if (!loop) throw new Error(`Engineer loop not found: ${id}`);
      if (loop.status !== "blocked") throw new Error(`Engineer loop ${id} is not blocked`);
      loop.status = "running";
      delete loop.stopReason;
      loop.updatedAt = nowIso();
      if (note?.trim()) {
        loop.events.push({
          id: crypto.randomUUID(),
          iteration: loop.iteration,
          phase: loop.phase,
          summary: note.trim(),
          evidence: [],
          createdAt: loop.updatedAt,
        });
      }
      return loop;
    });
  }

  async completeLoop(input: {
    loopId: string;
    outcome: string;
    rootCause: string;
    fix: string;
    rollback?: string | undefined;
    prevention?: string[] | undefined;
    runbookTitle?: string | undefined;
  }): Promise<{ loop: EngineerLoop; runbook: EngineerRunbook }> {
    return this.#mutate((data) => {
      const loop = data.loops.find((candidate) => candidate.id === input.loopId);
      if (!loop) throw new Error(`Engineer loop not found: ${input.loopId}`);
      if (loop.status !== "running") throw new Error(`Engineer loop ${loop.id} is ${loop.status}, not running`);
      if (loop.phase !== "learn") throw new Error(`Engineer loop ${loop.id} must reach learn phase before completion`);
      if (!loop.verificationEvidence.length) throw new Error("Cannot complete engineer loop without verification evidence");

      const now = nowIso();
      loop.status = "succeeded";
      loop.rootCause = requiredText(input.rootCause, "rootCause");
      loop.fix = requiredText(input.fix, "fix");
      loop.prevention = cleanStrings(input.prevention, 100);
      loop.stopReason = requiredText(input.outcome, "outcome");
      loop.updatedAt = now;
      loop.completedAt = now;
      if (input.rollback?.trim()) loop.rollback = input.rollback.trim();

      const symptoms = cleanStrings(
        loop.events.filter((event) => event.phase === "observe").flatMap((event) => [event.summary, ...event.evidence]),
        100,
      );
      const diagnostics = cleanStrings(
        loop.events
          .filter((event) => event.phase === "diagnose" || event.phase === "test")
          .flatMap((event) => [event.summary, ...event.evidence]),
        100,
      );
      const rollback = cleanStrings(input.rollback?.trim() ? [input.rollback.trim()] : [], 20);
      const runbook: EngineerRunbook = {
        id: crypto.randomUUID(),
        loopId: loop.id,
        title: input.runbookTitle?.trim() || `Engineer loop: ${loop.objective}`,
        objective: loop.objective,
        symptoms,
        rootCause: loop.rootCause,
        fix: loop.fix,
        diagnostics,
        verification: [...loop.verificationEvidence],
        rollback,
        prevention: [...loop.prevention],
        createdAt: now,
      };
      data.runbooks.push(runbook);
      return { loop, runbook };
    });
  }

  async failLoop(id: string, reason: string): Promise<EngineerLoop> {
    return this.#finishLoop(id, "failed", reason);
  }

  async abortLoop(id: string, reason: string): Promise<EngineerLoop> {
    return this.#finishLoop(id, "aborted", reason);
  }

  async #finishLoop(id: string, status: "failed" | "aborted", reason: string): Promise<EngineerLoop> {
    return this.#mutate((data) => {
      const loop = data.loops.find((candidate) => candidate.id === id);
      if (!loop) throw new Error(`Engineer loop not found: ${id}`);
      if (loop.status === "succeeded" || loop.status === "failed" || loop.status === "aborted") {
        throw new Error(`Engineer loop ${id} is already ${loop.status}`);
      }
      const now = nowIso();
      loop.status = status;
      loop.stopReason = requiredText(reason, "reason");
      loop.updatedAt = now;
      loop.completedAt = now;
      return loop;
    });
  }

  async listRunbooks(limit = 50): Promise<EngineerRunbook[]> {
    const data = await this.read();
    return data.runbooks
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(Math.round(limit), 1), 500));
  }

  async getDashboard(): Promise<EngineerDashboard> {
    const data = await this.read();
    const recent = data.loops.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
    const active = recent.filter((loop) => loop.status === "running" || loop.status === "blocked");
    return {
      generatedAt: nowIso(),
      stats: {
        running: data.loops.filter((loop) => loop.status === "running").length,
        blocked: data.loops.filter((loop) => loop.status === "blocked").length,
        succeeded: data.loops.filter((loop) => loop.status === "succeeded").length,
        failed: data.loops.filter((loop) => loop.status === "failed").length,
        runbooks: data.runbooks.length,
      },
      active,
      recent,
      runbooks: data.runbooks.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10),
    };
  }
}
