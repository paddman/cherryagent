import type { LlmProvider, ToolContext } from "../core/types.js";
import {
  AgenticStateStore,
  type AgenticRun,
  type AgentRole,
  type AgentTask,
  type AgentTaskSpec,
} from "./AgenticStateStore.js";
import { AgentHandoffProtocol } from "./AgentHandoffProtocol.js";
import { SharedEvidenceBus } from "./SharedEvidenceBus.js";
import { SubAgentRuntime } from "./SubAgentRuntime.js";

const DELEGATABLE_ROLES: AgentRole[] = [
  "office",
  "planner",
  "infra",
  "market",
  "research",
  "database",
  "engineer",
  "general",
];

export type AgentOrchestratorOptions = {
  maxTasks: number;
  maxRounds: number;
  concurrency: number;
  subAgentMaxSteps: number;
};

type PlannedTask = AgentTaskSpec;

type CriticReview = {
  verdict: "pass" | "needs_more_work" | "blocked";
  summary: string;
  issues: string[];
  additionalTasks: PlannedTask[];
};

type VerificationReview = {
  verdict: "pass" | "revise";
  confidence: number;
  issues: string[];
  revisedAnswer?: string;
};

function extractJsonObject(text: string): Record<string, unknown> {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Model did not return a JSON object");
  const parsed = JSON.parse(text.slice(first, last + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function parseRole(value: unknown): AgentRole {
  if (typeof value === "string" && DELEGATABLE_ROLES.includes(value as AgentRole)) return value as AgentRole;
  return "general";
}

function sanitizeKey(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return cleaned || fallback;
}

function parsePlannedTasks(payload: Record<string, unknown>, maxTasks: number, keyPrefix = "task"): PlannedTask[] {
  const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const tasks: PlannedTask[] = [];
  const used = new Set<string>();

  for (const [index, raw] of rawTasks.slice(0, maxTasks).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const objective = typeof item.objective === "string" ? item.objective.trim() : "";
    if (!objective) continue;
    let key = sanitizeKey(typeof item.key === "string" ? item.key : `${keyPrefix}-${index + 1}`, `${keyPrefix}-${index + 1}`);
    while (used.has(key)) key = `${key}-${index + 1}`;
    used.add(key);
    tasks.push({
      key,
      role: parseRole(item.role),
      objective,
      dependsOn: stringArray(item.dependsOn),
    });
  }
  return tasks;
}

function inferRole(goal: string): AgentRole {
  const text = goal.toLowerCase();
  if (/(postgres|mysql|sqlite|redis|sql|database|ฐานข้อมูล)/i.test(text)) return "database";
  if (/(proxmox|vmware|vcenter|esxi|vm\b|storage|network|infra|cloud|เซิร์ฟเวอร์|โครงสร้างพื้นฐาน)/i.test(text)) return "infra";
  if (/(binance|mexc|bitkub|\bxt\b|crypto|bitcoin|ethereum|หุ้น|stock|market|เทรด)/i.test(text)) return "market";
  if (/(gmail|email|calendar|drive|เอกสาร|ประชุม|อีเมล)/i.test(text)) return "office";
  if (/(plan|schedule|remind|deadline|วางแผน|เตือน|กำหนดเวลา)/i.test(text)) return "planner";
  if (/(debug|incident|error|bug|fix|แก้ปัญหา|เสีย|ล่ม)/i.test(text)) return "engineer";
  if (/(research|news|financial|ข่าว|งบการเงิน|ค้นคว้า)/i.test(text)) return "research";
  return "general";
}

function compactRun(run: AgenticRun): string {
  return run.tasks.map((task) => {
    const result = task.result ? task.result.slice(0, 6000) : "";
    const error = task.error ? ` error=${task.error}` : "";
    return `${task.key} [${task.role}/${task.status}] ${task.objective}\nresult=${result}${error}`;
  }).join("\n\n");
}

function parseCritic(text: string, maxAdditional: number, keyPrefix: string): CriticReview {
  try {
    const payload = extractJsonObject(text);
    const verdictRaw = typeof payload.verdict === "string" ? payload.verdict : "needs_more_work";
    const verdict: CriticReview["verdict"] = verdictRaw === "pass" || verdictRaw === "blocked" ? verdictRaw : "needs_more_work";
    return {
      verdict,
      summary: typeof payload.summary === "string" ? payload.summary : "Critic review completed.",
      issues: stringArray(payload.issues),
      additionalTasks: parsePlannedTasks(
        { tasks: payload.additionalTasks },
        maxAdditional,
        keyPrefix,
      ),
    };
  } catch {
    return {
      verdict: "needs_more_work",
      summary: text.trim() || "Critic response could not be parsed.",
      issues: ["Critic response was not valid structured JSON."],
      additionalTasks: [],
    };
  }
}

function parseVerification(text: string): VerificationReview {
  try {
    const payload = extractJsonObject(text);
    return {
      verdict: payload.verdict === "pass" ? "pass" : "revise",
      confidence: Math.min(100, Math.max(0, Number(payload.confidence) || 0)),
      issues: stringArray(payload.issues),
      ...(typeof payload.revisedAnswer === "string" && payload.revisedAnswer.trim()
        ? { revisedAnswer: payload.revisedAnswer.trim() }
        : {}),
    };
  } catch {
    return {
      verdict: "revise",
      confidence: 0,
      issues: ["Verifier response was not valid structured JSON."],
    };
  }
}

export class AgentOrchestrator {
  private readonly subAgents: SubAgentRuntime;
  private readonly maxTasks: number;
  private readonly maxRounds: number;
  private readonly concurrency: number;

  constructor(
    private readonly provider: LlmProvider,
    private readonly store: AgenticStateStore,
    private readonly evidence: SharedEvidenceBus,
    private readonly handoffs: AgentHandoffProtocol,
    private readonly tools: import("../tools/ToolRegistry.js").ToolRegistry,
    options: AgentOrchestratorOptions,
  ) {
    this.maxTasks = Math.max(1, Math.min(20, options.maxTasks));
    this.maxRounds = Math.max(1, Math.min(5, options.maxRounds));
    this.concurrency = Math.max(1, Math.min(8, options.concurrency));
    this.subAgents = new SubAgentRuntime(provider, tools, evidence, Math.max(1, options.subAgentMaxSteps));
  }

  async runGoal(input: { goal: string; tenantId?: string; preferredRoles?: AgentRole[]; tags?: string[]; traceId?: string }, context: ToolContext): Promise<AgenticRun> {
    const goal = input.goal.trim();
    if (!goal) throw new Error("Goal is required");
    const run = await this.store.createRun(goal, {
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });

    return await this.executeRun(run.id, input, context);
  }

  async startGoal(input: { goal: string; tenantId?: string; preferredRoles?: AgentRole[]; tags?: string[]; traceId?: string }, context: ToolContext): Promise<AgenticRun> {
    const goal = input.goal.trim();
    if (!goal) throw new Error("Goal is required");
    const run = await this.store.createRun(goal, {
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });
    void this.executeRun(run.id, input, context);
    return run;
  }

  private async executeRun(
    runId: string,
    input: { goal: string; preferredRoles?: AgentRole[] },
    context: ToolContext,
  ): Promise<AgenticRun> {
    const goal = input.goal.trim();

    try {
      const plan = await this.planGoal(goal, input.preferredRoles);
      await this.store.addTasks(runId, plan);

      let finalCritique: CriticReview | undefined;
      for (let round = 1; round <= this.maxRounds; round += 1) {
        await this.store.setRunRound(runId, round);
        await this.executePendingTasks(runId, context);
        const current = await this.store.getRun(runId);
        finalCritique = await this.criticReview(current);
        await this.store.setRunCritique(runId, finalCritique);
        await this.evidence.publish({
          runId,
          agent: "critic",
          kind: "decision",
          claim: `Critic verdict: ${finalCritique.verdict}. ${finalCritique.summary}`,
          data: finalCritique,
          confidence: finalCritique.verdict === "pass" ? 0.95 : 0.85,
        });

        if (finalCritique.verdict === "pass" || finalCritique.verdict === "blocked") break;
        if (round >= this.maxRounds || !finalCritique.additionalTasks.length) break;

        const latest = await this.store.getRun(runId);
        const remaining = Math.max(0, this.maxTasks - latest.tasks.length);
        if (!remaining) break;
        const extra = finalCritique.additionalTasks.slice(0, remaining).map((task, index) => ({
          ...task,
          key: `r${round + 1}-${sanitizeKey(task.key, `task-${index + 1}`)}`,
        }));
        await this.store.addTasks(runId, extra);
      }

      const afterTasks = await this.store.getRun(runId);
      const synthesis = await this.synthesize(afterTasks, finalCritique);
      const verification = await this.verify(afterTasks, synthesis);
      await this.store.setRunVerification(runId, verification);
      await this.evidence.publish({
        runId,
        agent: "verifier",
        kind: "verification",
        claim: `Verifier verdict: ${verification.verdict} at ${verification.confidence.toFixed(0)}% confidence.`,
        data: verification,
        confidence: verification.confidence / 100,
      });

      const finalAnswer = verification.verdict === "revise" && verification.revisedAnswer
        ? verification.revisedAnswer
        : synthesis;
      const latest = await this.store.getRun(runId);
      const blockedTasks = latest.tasks.filter((task) => task.status === "blocked");
      const failedTasks = latest.tasks.filter((task) => task.status === "failed");
      const status = finalCritique?.verdict === "blocked" || blockedTasks.length
        ? "blocked"
        : failedTasks.length && finalCritique?.verdict !== "pass"
          ? "failed"
          : "succeeded";
      const blockedReason = status === "blocked"
        ? finalCritique?.summary ?? blockedTasks.map((task) => task.error ?? task.objective).join(" | ")
        : undefined;
      return await this.store.completeRun(runId, {
        status,
        synthesis: finalAnswer,
        ...(blockedReason ? { blockedReason } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.evidence.publish({
        runId: runId,
        agent: "orchestrator",
        kind: "error",
        claim: `Orchestration failed: ${message}`,
        data: message,
        confidence: 1,
      });
      return await this.store.completeRun(runId, { status: "failed", synthesis: `Orchestration failed: ${message}` });
    }
  }

  getRun(id: string, tenantId?: string): Promise<AgenticRun> {
    return this.store.getRun(id, tenantId);
  }

  listRuns(limit = 50, tenantId?: string): Promise<AgenticRun[]> {
    return this.store.listRuns(undefined, limit, tenantId);
  }

  dashboard(tenantId?: string): ReturnType<AgenticStateStore["dashboard"]> {
    return this.store.dashboard(tenantId);
  }

  private async planGoal(goal: string, preferredRoles?: AgentRole[]): Promise<PlannedTask[]> {
    const allowed = preferredRoles?.filter((role) => DELEGATABLE_ROLES.includes(role)) ?? DELEGATABLE_ROLES;
    const prompt = `You are Cherry Orchestrator. Decompose the user goal into the smallest useful dependency-aware specialist task graph.
Allowed roles: ${allowed.join(", ")}.
Return ONLY JSON in this exact shape:
{"tasks":[{"key":"task-1","role":"infra","objective":"...","dependsOn":[]}]}
Rules:
- 1 to ${this.maxTasks} tasks.
- Use parallel independent tasks when useful.
- Dependencies refer to task keys.
- Separate research, database, infra, office, planning, market, and engineering work when specialists improve quality.
- Do not create ceremonial tasks with no concrete output.
- Real-world actions remain protected by tool approval policies.

Goal: ${goal}`;
    const completion = await this.provider.complete({
      messages: [
        { role: "system", content: "Return compact valid JSON only. Do not expose chain-of-thought." },
        { role: "user", content: prompt },
      ],
      tools: [],
    });
    try {
      const tasks = parsePlannedTasks(extractJsonObject(completion.message.content ?? ""), this.maxTasks);
      if (tasks.length) return tasks;
    } catch {
      // Fall through to one bounded specialist task.
    }
    return [{ key: "task-1", role: inferRole(goal), objective: goal, dependsOn: [] }];
  }

  private async executePendingTasks(runId: string, parentContext: ToolContext): Promise<void> {
    for (;;) {
      const run = await this.store.getRun(runId);
      const byId = new Map(run.tasks.map((task) => [task.id, task]));
      const pending = run.tasks.filter((task) => task.status === "pending");
      if (!pending.length) return;

      let skippedAny = true;
      while (skippedAny) {
        skippedAny = false;
        const current = await this.store.getRun(runId);
        const currentById = new Map(current.tasks.map((task) => [task.id, task]));
        for (const task of current.tasks.filter((item) => item.status === "pending")) {
          const failedDependency = task.dependsOn
            .map((id) => currentById.get(id))
            .find((dependency) => dependency && ["failed", "blocked", "skipped"].includes(dependency.status));
          if (failedDependency) {
            await this.store.updateTask(runId, task.id, {
              status: "skipped",
              error: `Dependency ${failedDependency.key} ended as ${failedDependency.status}`,
              completedAt: new Date().toISOString(),
            });
            skippedAny = true;
          }
        }
      }

      const refreshed = await this.store.getRun(runId);
      const refreshedById = new Map(refreshed.tasks.map((task) => [task.id, task]));
      const ready = refreshed.tasks.filter((task) => task.status === "pending" && task.dependsOn.every((id) => refreshedById.get(id)?.status === "succeeded"));
      if (!ready.length) return;

      for (let index = 0; index < ready.length; index += this.concurrency) {
        const batch = ready.slice(index, index + this.concurrency);
        await Promise.all(batch.map((task) => this.executeTask(runId, task, parentContext)));
      }
    }
  }

  private async executeTask(runId: string, task: AgentTask, parentContext: ToolContext): Promise<void> {
    const existingEvidence = await this.evidence.list({ runId, limit: 100 });
    const handoff = await this.handoffs.create({
      runId,
      taskId: task.id,
      fromAgent: "orchestrator",
      toAgent: task.role,
      objective: task.objective,
      context: `Goal: ${(await this.store.getRun(runId)).goal}`,
      evidenceIds: existingEvidence.map((item) => item.id),
      expectedOutput: "Concise result with observable evidence, blockers, and next action.",
    });
    await this.handoffs.accept(handoff.id);
    await this.store.updateTask(runId, task.id, {
      status: "running",
      handoffId: handoff.id,
      progress: { step: 0, maxSteps: this.subAgents.configuredMaxSteps, phase: "starting" },
      lastActivityAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });

    try {
      const result = await this.subAgents.run({
        runId,
        taskId: task.id,
        role: task.role,
        objective: task.objective,
        sharedEvidence: await this.evidence.summarize(runId, 100),
        context: {
          sessionId: `${parentContext.sessionId}:${runId}:${task.id}`,
          userId: parentContext.userId,
          tenantId: (await this.store.getRun(runId)).tenantId,
          workspaceRoot: parentContext.workspaceRoot,
          traceId: (await this.store.getRun(runId)).traceId,
        },
        onProgress: async (progress) => {
          await this.store.updateTask(runId, task.id, {
            progress,
            lastActivityAt: new Date().toISOString(),
          });
        },
      });
      const status = result.blocked ? "blocked" : result.failed ? "failed" : "succeeded";
      await this.store.updateTask(runId, task.id, {
        status,
        result: result.answer,
        evidenceIds: result.evidenceIds,
        completedAt: new Date().toISOString(),
        ...(result.blocked ? { error: "One or more required actions are blocked by approval or policy." } : {}),
      });
      if (status === "blocked") await this.handoffs.block(handoff.id, "Task blocked by approval or policy.", result.evidenceIds);
      else if (status === "failed") await this.handoffs.fail(handoff.id, result.answer, result.evidenceIds);
      else await this.handoffs.complete(handoff.id, result.answer, result.evidenceIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.updateTask(runId, task.id, {
        status: "failed",
        error: message,
        completedAt: new Date().toISOString(),
      });
      await this.handoffs.fail(handoff.id, message);
      await this.evidence.publish({
        runId,
        taskId: task.id,
        agent: task.role,
        kind: "error",
        claim: `Sub-agent execution failed: ${message}`,
        data: message,
        confidence: 1,
      });
    }
  }

  private async criticReview(run: AgenticRun): Promise<CriticReview> {
    const handoff = await this.handoffs.create({
      runId: run.id,
      fromAgent: "orchestrator",
      toAgent: "critic",
      objective: "Check whether the delegated work fully satisfies the goal with sufficient evidence and no important contradictions.",
      evidenceIds: (await this.evidence.list({ runId: run.id, limit: 200 })).map((item) => item.id),
      expectedOutput: "Structured pass, needs_more_work, or blocked verdict with concrete issues and additional specialist tasks when needed.",
    });
    await this.handoffs.accept(handoff.id);
    const evidenceSummary = await this.evidence.summarize(run.id, 200);
    const completion = await this.provider.complete({
      messages: [
        { role: "system", content: "You are an independent critic agent. Return JSON only. Do not expose chain-of-thought." },
        {
          role: "user",
          content: `Goal:\n${run.goal}\n\nTask results:\n${compactRun(run)}\n\nShared evidence:\n${evidenceSummary}\n\nReturn ONLY JSON:\n{"verdict":"pass|needs_more_work|blocked","summary":"...","issues":["..."],"additionalTasks":[{"key":"...","role":"office|planner|infra|market|research|database|engineer|general","objective":"...","dependsOn":[]}]}`,
        },
      ],
      tools: [],
    });
    const review = parseCritic(completion.message.content ?? "", Math.max(0, this.maxTasks - run.tasks.length), `r${run.round + 1}`);
    await this.handoffs.complete(handoff.id, JSON.stringify(review));
    return review;
  }

  private async synthesize(run: AgenticRun, critique?: CriticReview): Promise<string> {
    const completion = await this.provider.complete({
      messages: [
        { role: "system", content: "You are Cherry Orchestrator final synthesizer. Use only task results and shared evidence. Be concise, honest about blockers, and never invent successful actions." },
        {
          role: "user",
          content: `Original goal:\n${run.goal}\n\nTask results:\n${compactRun(run)}\n\nShared evidence:\n${await this.evidence.summarize(run.id, 200)}\n\nCritic review:\n${JSON.stringify(critique ?? null)}\n\nProduce the final user-facing answer with outcome, evidence, blockers, and next action where relevant.`,
        },
      ],
      tools: [],
    });
    return completion.message.content?.trim() || "The orchestrated run completed without a textual synthesis.";
  }

  private async verify(run: AgenticRun, synthesis: string): Promise<VerificationReview> {
    const evidenceRecords = await this.evidence.list({ runId: run.id, limit: 200 });
    const handoff = await this.handoffs.create({
      runId: run.id,
      fromAgent: "orchestrator",
      toAgent: "verifier",
      objective: "Verify that the final synthesis is supported by task outputs and observable evidence.",
      evidenceIds: evidenceRecords.map((item) => item.id),
      expectedOutput: "Structured pass or revise verdict with confidence and a corrected answer when needed.",
    });
    await this.handoffs.accept(handoff.id);
    const completion = await this.provider.complete({
      messages: [
        { role: "system", content: "You are an independent verifier agent. Check claims against evidence. Return JSON only and do not expose chain-of-thought." },
        {
          role: "user",
          content: `Goal:\n${run.goal}\n\nCandidate synthesis:\n${synthesis}\n\nTask results:\n${compactRun(run)}\n\nEvidence:\n${await this.evidence.summarize(run.id, 200)}\n\nReturn ONLY JSON:\n{"verdict":"pass|revise","confidence":0,"issues":["..."],"revisedAnswer":"required only when revise"}`,
        },
      ],
      tools: [],
    });
    const review = parseVerification(completion.message.content ?? "");
    await this.handoffs.complete(handoff.id, JSON.stringify(review), evidenceRecords.map((item) => item.id));
    return review;
  }
}
