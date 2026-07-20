import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_TENANT_ID } from "../tenancy/constants.js";

export type AgentRole =
  | "orchestrator"
  | "office"
  | "planner"
  | "infra"
  | "market"
  | "research"
  | "database"
  | "engineer"
  | "critic"
  | "verifier"
  | "general";

export type AgenticRunStatus = "running" | "succeeded" | "blocked" | "failed" | "aborted";
export type AgentTaskStatus = "pending" | "running" | "succeeded" | "blocked" | "failed" | "skipped";
export type AgentTaskProgressPhase = "starting" | "thinking" | "tool" | "finalizing";
export type HandoffStatus = "pending" | "accepted" | "completed" | "blocked" | "failed" | "rejected";
export type EvidenceKind = "observation" | "tool_result" | "fact" | "decision" | "error" | "verification";
export type AgenticLogLevel = "debug" | "info" | "warn" | "error";

export type AgenticLogAction =
  | "run.created"
  | "run.updated"
  | "run.round"
  | "run.critique"
  | "run.verification"
  | "run.completed"
  | "run.recovered"
  | "task.created"
  | "task.updated"
  | "task.progress"
  | "handoff.created"
  | "handoff.updated"
  | "evidence.created";

export type AgentTaskProgress = {
  step: number;
  maxSteps: number;
  phase: AgentTaskProgressPhase;
  activeTool?: string;
};

export type AgenticStateEvent = {
  type: "run.updated" | "task.updated" | "handoff.updated" | "evidence.created" | "log.created";
  action?: AgenticLogAction;
  runId: string;
  taskId?: string;
  payload?: unknown;
  emittedAt: string;
};

export type AgenticLogEntry = {
  id: string;
  sequence: number;
  tenantId: string;
  jobId: string;
  runId: string;
  traceId: string;
  taskId?: string;
  spanId?: string;
  level: AgenticLogLevel;
  action: AgenticLogAction;
  message: string;
  tags: string[];
  agent?: AgentRole;
  tool?: string;
  step?: number;
  maxSteps?: number;
  data?: unknown;
  createdAt: string;
};

export type EvidenceRecord = {
  id: string;
  runId: string;
  taskId?: string;
  agent: AgentRole;
  kind: EvidenceKind;
  claim: string;
  data?: unknown;
  sourceTool?: string;
  confidence: number;
  createdAt: string;
};

export type AgentHandoff = {
  id: string;
  runId: string;
  taskId?: string;
  fromAgent: AgentRole;
  toAgent: AgentRole;
  objective: string;
  context?: string;
  evidenceIds: string[];
  expectedOutput?: string;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
};

export type AgentTask = {
  id: string;
  spanId: string;
  key: string;
  role: AgentRole;
  tags: string[];
  objective: string;
  dependsOn: string[];
  status: AgentTaskStatus;
  handoffId?: string;
  result?: string;
  error?: string;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
  progress?: AgentTaskProgress;
  lastActivityAt?: string;
  startedAt?: string;
  completedAt?: string;
};

export type AgenticRun = {
  id: string;
  tenantId: string;
  jobId: string;
  traceId: string;
  tags: string[];
  goal: string;
  status: AgenticRunStatus;
  round: number;
  tasks: AgentTask[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  critique?: unknown;
  verification?: unknown;
  synthesis?: string;
  blockedReason?: string;
};

export type AgentTaskSpec = {
  key: string;
  role: AgentRole;
  objective: string;
  dependsOn?: string[];
  tags?: string[];
};

type AgenticState = {
  version: 2;
  runs: AgenticRun[];
  handoffs: AgentHandoff[];
  evidence: EvidenceRecord[];
  logs: AgenticLogEntry[];
  nextLogSequence: number;
};

function emptyState(): AgenticState {
  return { version: 2, runs: [], handoffs: [], evidence: [], logs: [], nextLogSequence: 0 };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function normalizeTags(value: unknown, limit = 20): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^#/, "").slice(0, 48).toLowerCase())
    .filter(Boolean))].slice(0, limit);
}

function makeJobId(id: string, createdAt: string): string {
  const day = createdAt.slice(0, 10).replace(/-/g, "") || "unknown";
  return `job-${day}-${id.slice(0, 8)}`;
}

function normalizeTask(raw: AgentTask): AgentTask {
  const task = raw as AgentTask & { spanId?: string; tags?: unknown };
  task.spanId = task.spanId || `span-${task.id}`;
  task.tags = normalizeTags(task.tags);
  return task;
}

function normalizeRun(raw: AgenticRun): AgenticRun {
  const run = raw as AgenticRun & { tenantId?: string; jobId?: string; traceId?: string; tags?: unknown };
  run.tenantId = run.tenantId || DEFAULT_TENANT_ID;
  run.jobId = run.jobId || makeJobId(run.id, run.createdAt);
  run.traceId = run.traceId || run.id;
  run.tags = normalizeTags(run.tags);
  run.tasks = Array.isArray(run.tasks) ? run.tasks.map(normalizeTask) : [];
  return run;
}

function compactLogData(value: unknown, maxChars = 2400): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return value;
    return `${serialized.slice(0, maxChars)}…[truncated]`;
  } catch {
    return String(value).slice(0, maxChars);
  }
}

export class AgenticStateStore {
  #state: AgenticState = emptyState();
  #loaded = false;
  #queue: Promise<void> = Promise.resolve();
  #listeners = new Map<string, Set<(event: AgenticStateEvent) => void>>();

  constructor(private readonly file: string) {}

  subscribe(runId: string, listener: (event: AgenticStateEvent) => void): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(runId);
    };
  }

  async createRun(goal: string, input: { tenantId?: string; traceId?: string; tags?: string[] } = {}): Promise<AgenticRun> {
    return await this.#mutate((state) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const run: AgenticRun = {
        id,
        tenantId: input.tenantId?.trim() || DEFAULT_TENANT_ID,
        jobId: makeJobId(id, now),
        traceId: input.traceId?.trim() || crypto.randomUUID(),
        tags: normalizeTags(input.tags),
        goal: goal.trim(),
        status: "running",
        round: 1,
        tasks: [],
        createdAt: now,
        updatedAt: now,
      };
      state.runs.unshift(run);
      return run;
    }, (run) => ({ type: "run.updated", action: "run.created", runId: run.id }));
  }

  async getRun(id: string, tenantId?: string): Promise<AgenticRun> {
    return await this.#read((state) => {
      const run = state.runs.find((item) => item.id === id);
      if (!run || (tenantId && run.tenantId !== tenantId)) throw new Error(`Agentic run not found: ${id}`);
      return run;
    });
  }

  async listRuns(status?: AgenticRunStatus, limit = 50, tenantId?: string): Promise<AgenticRun[]> {
    return await this.#read((state) => state.runs
      .filter((run) => !status || run.status === status)
      .filter((run) => !tenantId || run.tenantId === tenantId)
      .slice(0, Math.max(1, Math.min(500, limit))));
  }

  async recoverInterruptedRuns(): Promise<AgenticRun[]> {
    const recovered = await this.#mutate((state) => {
      const now = new Date().toISOString();
      const runs = state.runs.filter((run) => {
        if (run.status === "running") return true;
        return run.tasks.some((task) =>
          task.status === "running" || (task.status === "pending" && task.dependsOn.some((dependencyId) => {
            const dependency = run.tasks.find((item) => item.id === dependencyId);
            return dependency && ["failed", "blocked", "skipped"].includes(dependency.status);
          }))
        );
      });
      for (const run of runs) {
        const wasRunning = (run.status as string) === "running";
        if (wasRunning) {
          run.status = "aborted";
          run.blockedReason = "Workflow process restarted before the run completed.";
        }
        run.updatedAt = now;
        run.completedAt = now;
        for (const task of run.tasks) {
          if (task.status === "running") {
            task.status = "skipped";
            task.error = "Workflow process restarted before this task completed.";
            task.updatedAt = now;
            task.completedAt = now;
          }
        }
        let changed = true;
        while (changed) {
          changed = false;
          for (const task of run.tasks) {
            if (task.status !== "pending") continue;
            const dependency = task.dependsOn
              .map((dependencyId) => run.tasks.find((item) => item.id === dependencyId))
              .find((item) => item && ["failed", "blocked", "skipped"].includes(item.status));
            if (!dependency) continue;
            task.status = "skipped";
            task.error = `Dependency ${dependency.key} ended as ${dependency.status}`;
            task.updatedAt = now;
            task.completedAt = now;
            changed = true;
          }
        }
        if (!wasRunning) {
          for (const task of run.tasks) {
            if (task.status !== "pending") continue;
            task.status = "skipped";
            task.error = "Run ended before this task became runnable.";
            task.updatedAt = now;
            task.completedAt = now;
          }
        }
      }
      return runs;
    });
    for (const run of recovered) {
      this.#emit({
        type: "run.updated",
        runId: run.id,
        payload: run,
        emittedAt: new Date().toISOString(),
      });
    }
    return recovered;
  }

  async addTasks(runId: string, specs: AgentTaskSpec[]): Promise<AgentTask[]> {
    return await this.#mutate((state) => {
      const run = this.#run(state, runId);
      const existingKeys = new Set(run.tasks.map((task) => task.key));
      const localKeys = new Set<string>();
      for (const spec of specs) {
        if (!spec.key.trim()) throw new Error("Task key is required");
        if (existingKeys.has(spec.key) || localKeys.has(spec.key)) throw new Error(`Duplicate task key: ${spec.key}`);
        localKeys.add(spec.key);
      }

      const now = new Date().toISOString();
      const keyToId = new Map(run.tasks.map((task) => [task.key, task.id]));
      const created = specs.map((spec) => {
        const task: AgentTask = {
          id: crypto.randomUUID(),
          spanId: `span-${crypto.randomUUID()}`,
          key: spec.key.trim(),
          role: spec.role,
          tags: normalizeTags([...(run.tags ?? []), ...(spec.tags ?? []), `agent:${spec.role}`, `task:${spec.key}`]),
          objective: spec.objective.trim(),
          dependsOn: [],
          status: "pending",
          evidenceIds: [],
          createdAt: now,
          updatedAt: now,
        };
        keyToId.set(task.key, task.id);
        return task;
      });

      created.forEach((task, index) => {
        const dependsOnKeys = specs[index]?.dependsOn ?? [];
        task.dependsOn = dependsOnKeys.map((key) => {
          const id = keyToId.get(key);
          if (!id) throw new Error(`Unknown dependency key ${key} for task ${task.key}`);
          return id;
        });
      });

      run.tasks.push(...created);
      run.updatedAt = now;
      return created;
    }, (tasks) => ({ type: "task.updated", action: "task.created", runId, ...(tasks.length === 1 && tasks[0] ? { taskId: tasks[0].id } : {}) }));
  }

  async updateTask(
    runId: string,
    taskId: string,
    patch: Partial<Pick<AgentTask, "status" | "handoffId" | "result" | "error" | "evidenceIds" | "progress" | "lastActivityAt" | "startedAt" | "completedAt">>,
  ): Promise<AgentTask> {
    return await this.#mutate((state) => {
      const run = this.#run(state, runId);
      const task = run.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Agent task not found: ${taskId}`);
      if (patch.status !== undefined) task.status = patch.status;
      if (patch.handoffId !== undefined) task.handoffId = patch.handoffId;
      if (patch.result !== undefined) task.result = patch.result;
      if (patch.error !== undefined) task.error = patch.error;
      if (patch.evidenceIds !== undefined) task.evidenceIds = [...patch.evidenceIds];
      if (patch.progress !== undefined) task.progress = structuredClone(patch.progress);
      if (patch.lastActivityAt !== undefined) task.lastActivityAt = patch.lastActivityAt;
      if (patch.startedAt !== undefined) task.startedAt = patch.startedAt;
      if (patch.completedAt !== undefined) task.completedAt = patch.completedAt;
      task.updatedAt = new Date().toISOString();
      run.updatedAt = task.updatedAt;
      return task;
    }, (task) => ({
      type: "task.updated",
      action: task.progress ? "task.progress" : "task.updated",
      runId,
      taskId,
    }));
  }

  async setRunRound(runId: string, round: number): Promise<AgenticRun> {
    return await this.#mutate((state) => {
      const run = this.#run(state, runId);
      run.round = Math.max(1, round);
      run.updatedAt = new Date().toISOString();
      return run;
    }, () => ({ type: "run.updated", action: "run.round", runId }));
  }

  async setRunCritique(runId: string, critique: unknown): Promise<AgenticRun> {
    return await this.#mutate((state) => {
      const run = this.#run(state, runId);
      run.critique = critique;
      run.updatedAt = new Date().toISOString();
      return run;
    }, () => ({ type: "run.updated", action: "run.critique", runId }));
  }

  async setRunVerification(runId: string, verification: unknown): Promise<AgenticRun> {
    return await this.#mutate((state) => {
      const run = this.#run(state, runId);
      run.verification = verification;
      run.updatedAt = new Date().toISOString();
      return run;
    }, () => ({ type: "run.updated", action: "run.verification", runId }));
  }

  async completeRun(runId: string, input: {
    status: AgenticRunStatus;
    synthesis?: string;
    blockedReason?: string;
  }): Promise<AgenticRun> {
    return await this.#mutate((state) => {
      const run = this.#run(state, runId);
      const now = new Date().toISOString();
      run.status = input.status;
      if (input.synthesis !== undefined) run.synthesis = input.synthesis;
      if (input.blockedReason !== undefined) run.blockedReason = input.blockedReason;
      run.updatedAt = now;
      if (input.status !== "running") run.completedAt = now;
      return run;
    }, () => ({ type: "run.updated", action: "run.completed", runId }));
  }

  async publishEvidence(input: {
    runId: string;
    taskId?: string;
    agent: AgentRole;
    kind: EvidenceKind;
    claim: string;
    data?: unknown;
    sourceTool?: string;
    confidence?: number;
  }): Promise<EvidenceRecord> {
    return await this.#mutate((state) => {
      this.#run(state, input.runId);
      const evidence: EvidenceRecord = {
        id: crypto.randomUUID(),
        runId: input.runId,
        agent: input.agent,
        kind: input.kind,
        claim: input.claim.trim(),
        confidence: clampConfidence(input.confidence ?? 1),
        createdAt: new Date().toISOString(),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
        ...(input.sourceTool ? { sourceTool: input.sourceTool } : {}),
      };
      state.evidence.unshift(evidence);
      if (state.evidence.length > 10_000) state.evidence.length = 10_000;
      const run = this.#run(state, input.runId);
      const task = input.taskId ? run.tasks.find((item) => item.id === input.taskId) : undefined;
      if (task && !task.evidenceIds.includes(evidence.id)) task.evidenceIds.push(evidence.id);
      run.updatedAt = evidence.createdAt;
      return evidence;
    }, (evidence) => ({ type: "evidence.created", action: "evidence.created", runId: input.runId, ...(evidence.taskId ? { taskId: evidence.taskId } : {}) }));
  }

  async listEvidence(input: { runId?: string; taskId?: string; limit?: number } = {}): Promise<EvidenceRecord[]> {
    return await this.#read((state) => state.evidence
      .filter((item) => (!input.runId || item.runId === input.runId) && (!input.taskId || item.taskId === input.taskId))
      .slice(0, Math.max(1, Math.min(2000, input.limit ?? 200))));
  }

  async listLogs(input: { runId?: string; taskId?: string; level?: AgenticLogLevel; since?: number; limit?: number } = {}): Promise<AgenticLogEntry[]> {
    return await this.#read((state) => state.logs
      .filter((item) => (!input.runId || item.runId === input.runId)
        && (!input.taskId || item.taskId === input.taskId)
        && (!input.level || item.level === input.level)
        && (!input.since || item.sequence > input.since))
      .slice(0, Math.max(1, Math.min(5000, input.limit ?? 500))));
  }

  async createHandoff(input: {
    runId: string;
    taskId?: string;
    fromAgent: AgentRole;
    toAgent: AgentRole;
    objective: string;
    context?: string;
    evidenceIds?: string[];
    expectedOutput?: string;
  }): Promise<AgentHandoff> {
    return await this.#mutate((state) => {
      this.#run(state, input.runId);
      const now = new Date().toISOString();
      const handoff: AgentHandoff = {
        id: crypto.randomUUID(),
        runId: input.runId,
        fromAgent: input.fromAgent,
        toAgent: input.toAgent,
        objective: input.objective.trim(),
        evidenceIds: [...(input.evidenceIds ?? [])],
        status: "pending",
        createdAt: now,
        updatedAt: now,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.expectedOutput ? { expectedOutput: input.expectedOutput } : {}),
      };
      state.handoffs.unshift(handoff);
      if (state.handoffs.length > 5000) state.handoffs.length = 5000;
      return handoff;
    }, () => ({ type: "handoff.updated", action: "handoff.created", runId: input.runId, ...(input.taskId ? { taskId: input.taskId } : {}) }));
  }

  async acceptHandoff(id: string): Promise<AgentHandoff> {
    return await this.#mutate((state) => {
      const handoff = this.#handoff(state, id);
      if (handoff.status !== "pending") throw new Error(`Handoff ${id} is ${handoff.status}, not pending`);
      const now = new Date().toISOString();
      handoff.status = "accepted";
      handoff.acceptedAt = now;
      handoff.updatedAt = now;
      return handoff;
    }, (handoff) => ({ type: "handoff.updated", action: "handoff.updated", runId: handoff.runId, ...(handoff.taskId ? { taskId: handoff.taskId } : {}) }));
  }

  async finishHandoff(id: string, input: {
    status: Extract<HandoffStatus, "completed" | "blocked" | "failed" | "rejected">;
    result?: string;
    error?: string;
    evidenceIds?: string[];
  }): Promise<AgentHandoff> {
    return await this.#mutate((state) => {
      const handoff = this.#handoff(state, id);
      const now = new Date().toISOString();
      handoff.status = input.status;
      if (input.result !== undefined) handoff.result = input.result;
      if (input.error !== undefined) handoff.error = input.error;
      if (input.evidenceIds !== undefined) handoff.evidenceIds = [...new Set([...handoff.evidenceIds, ...input.evidenceIds])];
      handoff.completedAt = now;
      handoff.updatedAt = now;
      return handoff;
    }, (handoff) => ({ type: "handoff.updated", action: "handoff.updated", runId: handoff.runId, ...(handoff.taskId ? { taskId: handoff.taskId } : {}) }));
  }

  async listHandoffs(input: { runId?: string; status?: HandoffStatus; limit?: number } = {}): Promise<AgentHandoff[]> {
    return await this.#read((state) => state.handoffs
      .filter((item) => (!input.runId || item.runId === input.runId) && (!input.status || item.status === input.status))
      .slice(0, Math.max(1, Math.min(1000, input.limit ?? 100))));
  }

  async dashboard(tenantId?: string): Promise<{
    runs: Record<AgenticRunStatus, number>;
    handoffs: Record<HandoffStatus, number>;
    evidence: number;
    activeTasks: number;
  }> {
    return await this.#read((state) => {
      const runs = state.runs.filter((item) => !tenantId || item.tenantId === tenantId);
      const runIds = new Set(runs.map((item) => item.id));
      return {
      runs: {
        running: runs.filter((item) => item.status === "running").length,
        succeeded: runs.filter((item) => item.status === "succeeded").length,
        blocked: runs.filter((item) => item.status === "blocked").length,
        failed: runs.filter((item) => item.status === "failed").length,
        aborted: runs.filter((item) => item.status === "aborted").length,
      },
      handoffs: {
        pending: state.handoffs.filter((item) => runIds.has(item.runId) && item.status === "pending").length,
        accepted: state.handoffs.filter((item) => runIds.has(item.runId) && item.status === "accepted").length,
        completed: state.handoffs.filter((item) => runIds.has(item.runId) && item.status === "completed").length,
        blocked: state.handoffs.filter((item) => runIds.has(item.runId) && item.status === "blocked").length,
        failed: state.handoffs.filter((item) => runIds.has(item.runId) && item.status === "failed").length,
        rejected: state.handoffs.filter((item) => runIds.has(item.runId) && item.status === "rejected").length,
      },
      evidence: state.evidence.filter((item) => runIds.has(item.runId)).length,
      activeTasks: runs.flatMap((run) => run.tasks).filter((task) => task.status === "pending" || task.status === "running").length,
    };
    });
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<AgenticState>;
      if (parsed && (Number(parsed.version) === 1 || Number(parsed.version) === 2) && Array.isArray(parsed.runs)) {
        const logs = Array.isArray(parsed.logs) ? parsed.logs : [];
        const runs = parsed.runs.map((run) => normalizeRun(run as AgenticRun));
        this.#state = {
          version: 2,
          runs,
          handoffs: Array.isArray(parsed.handoffs) ? parsed.handoffs : [],
          evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
          logs: logs.map((log) => ({
            ...(log as AgenticLogEntry),
            tenantId: (log as AgenticLogEntry).tenantId || runs.find((run) => run.id === (log as AgenticLogEntry).runId)?.tenantId || DEFAULT_TENANT_ID,
          })),
          nextLogSequence: Math.max(
            Number(parsed.nextLogSequence) || 0,
            ...logs.map((item) => Number(item.sequence) || 0),
          ),
        };
      } else {
        this.#state = emptyState();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#state = emptyState();
    }
    this.#loaded = true;
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(this.#state, null, 2), "utf8");
    await rename(temp, this.file);
  }

  async #read<T>(reader: (state: AgenticState) => T): Promise<T> {
    await this.#queue;
    await this.#ensureLoaded();
    return clone(reader(this.#state));
  }

  async #mutate<T>(
    mutation: (state: AgenticState) => T,
    eventFactory?: (result: T) => Omit<AgenticStateEvent, "payload" | "emittedAt">,
  ): Promise<T> {
    const operation = this.#queue.then(async () => {
      await this.#ensureLoaded();
      const result = mutation(this.#state);
      const cloned = clone(result);
      const event = eventFactory?.(cloned);
      const log = event ? this.#logFromEvent(this.#state, event, cloned) : undefined;
      if (log) {
        this.#state.logs.unshift(log);
        if (this.#state.logs.length > 25_000) this.#state.logs.length = 25_000;
      }
      await this.#persist();
      if (event) this.#emit({ ...event, payload: cloned, emittedAt: new Date().toISOString() });
      if (log) {
        this.#emit({
          type: "log.created",
          runId: log.runId,
          ...(log.taskId ? { taskId: log.taskId } : {}),
          payload: log,
          emittedAt: log.createdAt,
        });
      }
      return cloned;
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  #emit(event: AgenticStateEvent): void {
    for (const listener of this.#listeners.get(event.runId) ?? []) {
      try {
        listener(clone(event));
      } catch {
        // Disconnected SSE clients must never break state persistence.
      }
    }
  }

  #logFromEvent(
    state: AgenticState,
    event: Omit<AgenticStateEvent, "payload" | "emittedAt">,
    payload: unknown,
  ): AgenticLogEntry | undefined {
    if (event.type === "log.created") return undefined;
    const run = state.runs.find((item) => item.id === event.runId);
    if (!run) return undefined;
    const taskId = event.taskId
      ?? (Array.isArray(payload) && payload.length === 1 ? (payload[0] as AgentTask | undefined)?.id : undefined);
    const task = taskId ? run.tasks.find((item) => item.id === taskId) : undefined;
    const action = event.action ?? event.type;
    let level: AgenticLogLevel = "info";
    let message: string = action;
    let tool: string | undefined;
    let step: number | undefined;
    let maxSteps: number | undefined;
    let agent: AgentRole | undefined = task?.role;
    let data: unknown;

    if (action === "run.created") {
      message = `Run created for goal: ${run.goal.slice(0, 180)}`;
      data = { goal: run.goal, taskCount: run.tasks.length };
    } else if (action === "run.completed") {
      level = run.status === "succeeded" ? "info" : run.status === "aborted" ? "warn" : "error";
      message = `Run ${run.status}`;
      data = { status: run.status, round: run.round, blockedReason: run.blockedReason };
    } else if (action === "run.round") {
      message = `Run entered round ${run.round}`;
      data = { round: run.round };
    } else if (action === "run.critique") {
      message = "Critic review updated";
      data = compactLogData(run.critique);
    } else if (action === "run.verification") {
      message = "Verification review updated";
      data = compactLogData(run.verification);
    } else if (action === "task.created") {
      const tasks = Array.isArray(payload) ? payload as AgentTask[] : [payload as AgentTask];
      message = `Created ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
      data = tasks.map((item) => ({ id: item.id, key: item.key, role: item.role, dependsOn: item.dependsOn }));
      agent = undefined;
    } else if (action === "task.progress" || action === "task.updated") {
      if (!task) return undefined;
      const progress = task.progress;
      level = task.status === "failed" ? "error" : task.status === "blocked" ? "warn" : "info";
      message = progress
        ? `${task.key} ${task.status} · ${progress.phase}${progress.activeTool ? ` · ${progress.activeTool}` : ""} · step ${progress.step}/${progress.maxSteps}`
        : `${task.key} ${task.status}`;
      tool = progress?.activeTool;
      step = progress?.step;
      maxSteps = progress?.maxSteps;
      data = {
        status: task.status,
        key: task.key,
        handoffId: task.handoffId,
        evidenceCount: task.evidenceIds.length,
        error: task.error,
      };
    } else if (action === "handoff.created" || action === "handoff.updated") {
      const handoff = payload as AgentHandoff;
      level = ["blocked", "failed", "rejected"].includes(handoff.status) ? "warn" : "info";
      message = `Handoff ${handoff.fromAgent} → ${handoff.toAgent} · ${handoff.status}`;
      agent = handoff.toAgent;
      data = { id: handoff.id, status: handoff.status, objective: handoff.objective.slice(0, 300), evidenceIds: handoff.evidenceIds };
    } else if (action === "evidence.created") {
      const evidence = payload as EvidenceRecord;
      level = evidence.kind === "error" ? "error" : "info";
      message = `${evidence.kind}${evidence.sourceTool ? ` · ${evidence.sourceTool}` : ""}: ${evidence.claim.slice(0, 180)}`;
      tool = evidence.sourceTool;
      agent = evidence.agent;
      data = { id: evidence.id, kind: evidence.kind, confidence: evidence.confidence, claim: evidence.claim };
    } else {
      message = `${event.type} updated`;
      data = compactLogData(payload);
    }

    const tags = [
      `job:${run.jobId}`,
      `run:${run.id}`,
      ...run.tags,
      ...(task ? [`task:${task.key}`, `agent:${task.role}`, ...task.tags] : []),
    ];
    const createdAt = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sequence: ++state.nextLogSequence,
      tenantId: run.tenantId,
      jobId: run.jobId,
      runId: run.id,
      traceId: run.traceId,
      ...(task ? { taskId: task.id, spanId: task.spanId } : {}),
      level,
      action,
      message,
      tags: [...new Set(tags)],
      ...(agent ? { agent } : {}),
      ...(tool ? { tool } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(data !== undefined ? { data: compactLogData(data) } : {}),
      createdAt,
    };
  }

  #run(state: AgenticState, id: string): AgenticRun {
    const run = state.runs.find((item) => item.id === id);
    if (!run) throw new Error(`Agentic run not found: ${id}`);
    return run;
  }

  #handoff(state: AgenticState, id: string): AgentHandoff {
    const handoff = state.handoffs.find((item) => item.id === id);
    if (!handoff) throw new Error(`Agent handoff not found: ${id}`);
    return handoff;
  }
}
