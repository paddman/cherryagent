import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
export type HandoffStatus = "pending" | "accepted" | "completed" | "blocked" | "failed" | "rejected";
export type EvidenceKind = "observation" | "tool_result" | "fact" | "decision" | "error" | "verification";

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
  key: string;
  role: AgentRole;
  objective: string;
  dependsOn: string[];
  status: AgentTaskStatus;
  handoffId?: string;
  result?: string;
  error?: string;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type AgenticRun = {
  id: string;
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
};

type AgenticState = {
  version: 1;
  runs: AgenticRun[];
  handoffs: AgentHandoff[];
  evidence: EvidenceRecord[];
};

function emptyState(): AgenticState {
  return { version: 1, runs: [], handoffs: [], evidence: [] };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export class AgenticStateStore {
  #state: AgenticState = emptyState();
  #loaded = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async createRun(goal: string): Promise<AgenticRun> {
    return await this.#mutate((state) => {
      const now = new Date().toISOString();
      const run: AgenticRun = {
        id: crypto.randomUUID(),
        goal: goal.trim(),
        status: "running",
        round: 1,
        tasks: [],
        createdAt: now,
        updatedAt: now,
      };
      state.runs.unshift(run);
      return run;
    });
  }

  async getRun(id: string): Promise<AgenticRun> {
    return await this.#read((state) => {
      const run = state.runs.find((item) => item.id === id);
      if (!run) throw new Error(`Agentic run not found: ${id}`);
      return run;
    });
  }

  async listRuns(status?: AgenticRunStatus, limit = 50): Promise<AgenticRun[]> {
    return await this.#read((state) => state.runs
      .filter((run) => !status || run.status === status)
      .slice(0, Math.max(1, Math.min(500, limit))));
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
          key: spec.key.trim(),
          role: spec.role,
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
    });
  }

  async updateTask(
    runId: string,
    taskId: string,
    patch: Partial<Pick<AgentTask, "status" | "handoffId" | "result" | "error" | "evidenceIds" | "startedAt" | "completedAt">>,
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
      if (patch.startedAt !== undefined) task.startedAt = patch.startedAt;
      if (patch.completedAt !== undefined) task.completedAt = patch.completedAt;
      task.updatedAt = new Date().toISOString();
      run.updatedAt = task.updatedAt;
      return task;
    });
  }

  async setRunRound(runId: string, round: number): Promise<AgenticRun> {
    return await this.#mutate((state) => {
      const run = this.#run(state, runId);
      run.round = Math.max(1, round);
      run.updatedAt = new Date().toISOString();
      return run;
    });
  }

  async setRunCritique(runId: string, critique: unknown): Promise<AgenticRun> {
    return await this.#mutate((state) => {
      const run = this.#run(state, runId);
      run.critique = critique;
      run.updatedAt = new Date().toISOString();
      return run;
    });
  }

  async setRunVerification(runId: string, verification: unknown): Promise<AgenticRun> {
    return await this.#mutate((state) => {
      const run = this.#run(state, runId);
      run.verification = verification;
      run.updatedAt = new Date().toISOString();
      return run;
    });
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
    });
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
    });
  }

  async listEvidence(input: { runId?: string; taskId?: string; limit?: number } = {}): Promise<EvidenceRecord[]> {
    return await this.#read((state) => state.evidence
      .filter((item) => (!input.runId || item.runId === input.runId) && (!input.taskId || item.taskId === input.taskId))
      .slice(0, Math.max(1, Math.min(2000, input.limit ?? 200))));
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
    });
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
    });
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
    });
  }

  async listHandoffs(input: { runId?: string; status?: HandoffStatus; limit?: number } = {}): Promise<AgentHandoff[]> {
    return await this.#read((state) => state.handoffs
      .filter((item) => (!input.runId || item.runId === input.runId) && (!input.status || item.status === input.status))
      .slice(0, Math.max(1, Math.min(1000, input.limit ?? 100))));
  }

  async dashboard(): Promise<{
    runs: Record<AgenticRunStatus, number>;
    handoffs: Record<HandoffStatus, number>;
    evidence: number;
    activeTasks: number;
  }> {
    return await this.#read((state) => ({
      runs: {
        running: state.runs.filter((item) => item.status === "running").length,
        succeeded: state.runs.filter((item) => item.status === "succeeded").length,
        blocked: state.runs.filter((item) => item.status === "blocked").length,
        failed: state.runs.filter((item) => item.status === "failed").length,
        aborted: state.runs.filter((item) => item.status === "aborted").length,
      },
      handoffs: {
        pending: state.handoffs.filter((item) => item.status === "pending").length,
        accepted: state.handoffs.filter((item) => item.status === "accepted").length,
        completed: state.handoffs.filter((item) => item.status === "completed").length,
        blocked: state.handoffs.filter((item) => item.status === "blocked").length,
        failed: state.handoffs.filter((item) => item.status === "failed").length,
        rejected: state.handoffs.filter((item) => item.status === "rejected").length,
      },
      evidence: state.evidence.length,
      activeTasks: state.runs.flatMap((run) => run.tasks).filter((task) => task.status === "pending" || task.status === "running").length,
    }));
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as AgenticState;
      this.#state = parsed && parsed.version === 1 ? parsed : emptyState();
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

  async #mutate<T>(mutation: (state: AgenticState) => T): Promise<T> {
    const operation = this.#queue.then(async () => {
      await this.#ensureLoaded();
      const result = mutation(this.#state);
      await this.#persist();
      return clone(result);
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    return await operation;
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
