import type { AgenticRun, AgentRole } from "../agentic/AgenticStateStore.js";
import type { AgentOrchestrator } from "../agentic/AgentOrchestrator.js";
import type { LlmProvider, ToolContext } from "../core/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import {
  CognitiveStore,
  type CognitiveBelief,
  type CognitiveEpisode,
  type CognitiveGoal,
  type CognitivePriority,
  type CognitiveSkill,
  type EpisodeOutcome,
} from "./CognitiveStore.js";

export type CognitiveDeliberation = {
  goal: CognitiveGoal;
  assumptions: string[];
  hypotheses: string[];
  plan: string[];
  unknowns: string[];
  verification: string[];
  stopConditions: string[];
  nextAction: string;
  confidence: number;
  preferredRoles: AgentRole[];
  recalledEpisodes: Array<CognitiveEpisode & { relevance: number }>;
  recalledBeliefs: Array<CognitiveBelief & { relevance: number }>;
  relevantSkills: CognitiveSkill[];
};

export type CognitiveExecution = {
  goal: CognitiveGoal;
  run: AgenticRun;
  episode: CognitiveEpisode;
  learnedSkill?: CognitiveSkill;
  updatedBeliefs: CognitiveBelief[];
  verified: boolean;
};

export type CognitiveSelfModel = {
  generatedAt: string;
  identity: string;
  claims: string[];
  boundaries: string[];
  toolCount: number;
  toolRiskCounts: Record<"safe" | "write" | "external" | "dangerous", number>;
  capabilityDomains: Record<string, string[]>;
  cognitiveStats: Awaited<ReturnType<CognitiveStore["stats"]>>;
  maturity: {
    planning: number;
    action: number;
    memory: number;
    learning: number;
    metacognition: number;
    autonomyReadiness: number;
  };
};

export type CognitiveEngineOptions = {
  maxContextEpisodes: number;
  maxContextBeliefs: number;
  maxContextSkills: number;
};

const AGENT_ROLES: AgentRole[] = [
  "office",
  "planner",
  "infra",
  "market",
  "research",
  "database",
  "engineer",
  "general",
];

function clamp01(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Math.min(1, Math.max(0, Number.isFinite(parsed) ? parsed : fallback));
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function stringArray(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, limit);
}

function extractJsonObject(value: string): Record<string, unknown> {
  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Cognitive model did not return a JSON object");
  const parsed = JSON.parse(value.slice(first, last + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cognitive model returned invalid JSON");
  }
  return parsed as Record<string, unknown>;
}

function parseRoles(value: unknown): AgentRole[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is AgentRole =>
    typeof item === "string" && AGENT_ROLES.includes(item as AgentRole),
  ))].slice(0, 8);
}

function verificationReview(run: AgenticRun): { verdict: string; confidence: number; issues: string[] } {
  const value = run.verification;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { verdict: "unknown", confidence: 0, issues: ["No structured verifier result was recorded."] };
  }
  const input = value as Record<string, unknown>;
  return {
    verdict: text(input.verdict, "unknown"),
    confidence: Math.min(100, Math.max(0, Number(input.confidence) || 0)),
    issues: stringArray(input.issues),
  };
}

function compactRun(run: AgenticRun): Record<string, unknown> {
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    round: run.round,
    synthesis: run.synthesis?.slice(0, 12_000),
    blockedReason: run.blockedReason,
    verification: run.verification,
    tasks: run.tasks.map((task) => ({
      key: task.key,
      role: task.role,
      objective: task.objective,
      status: task.status,
      result: task.result?.slice(0, 5000),
      error: task.error,
      evidenceIds: task.evidenceIds,
    })),
  };
}

function evidenceFromRun(run: AgenticRun): string[] {
  const evidence: string[] = [];
  for (const task of run.tasks) {
    if (task.result?.trim()) evidence.push(`${task.key} [${task.role}/${task.status}]: ${task.result.trim().slice(0, 4000)}`);
    if (task.error?.trim()) evidence.push(`${task.key} [${task.role}/${task.status}] error: ${task.error.trim()}`);
    if (task.evidenceIds.length) evidence.push(`${task.key} evidence ids: ${task.evidenceIds.join(", ")}`);
  }
  const verifier = verificationReview(run);
  evidence.push(`Verifier verdict=${verifier.verdict}; confidence=${verifier.confidence}; issues=${verifier.issues.join(" | ") || "none"}`);
  return [...new Set(evidence)].slice(0, 300);
}

function goalOutcome(run: AgenticRun, verified: boolean): EpisodeOutcome {
  if (run.status === "blocked") return "blocked";
  if (run.status === "failed" || run.status === "aborted") return "failed";
  if (run.status === "succeeded" && verified) return "succeeded";
  return "partial";
}

function toolsByDomain(tools: ToolRegistry): Record<string, string[]> {
  const domains: Record<string, string[]> = {};
  for (const tool of tools.list()) {
    const prefix = tool.name.includes("_") ? tool.name.split("_")[0] ?? "general" : "general";
    (domains[prefix] ??= []).push(tool.name);
  }
  for (const names of Object.values(domains)) names.sort();
  return domains;
}

export class CognitiveEngine {
  constructor(
    private readonly provider: LlmProvider,
    private readonly orchestrator: AgentOrchestrator,
    private readonly tools: ToolRegistry,
    private readonly store: CognitiveStore,
    private readonly options: CognitiveEngineOptions,
  ) {}

  async deliberate(input: {
    goalId?: string;
    objective?: string;
    successCriteria?: string[];
    priority?: CognitivePriority;
  }): Promise<CognitiveDeliberation> {
    let goal: CognitiveGoal;
    if (input.goalId) {
      goal = await this.store.getGoal(input.goalId);
    } else {
      const objective = input.objective?.trim();
      if (!objective) throw new Error("objective or goalId is required");
      goal = await this.store.createGoal({
        objective,
        ...(input.successCriteria ? { successCriteria: input.successCriteria } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      });
    }

    const [workspace, episodes, beliefs, skills] = await Promise.all([
      this.store.workspace(),
      this.store.recallEpisodes(goal.objective, this.options.maxContextEpisodes),
      this.store.queryBeliefs(goal.objective, this.options.maxContextBeliefs),
      this.store.listSkills(undefined, this.options.maxContextSkills),
    ]);

    const availableTools = this.tools.list().map((tool) => ({
      name: tool.name,
      risk: tool.risk,
      description: tool.description,
    }));

    const prompt = `You are Cherry's metacognitive deliberation layer. Convert a goal into an evidence-seeking, falsifiable execution strategy.

Do not reveal hidden chain-of-thought. Return only compact JSON containing conclusions and operational artifacts.
Never claim a capability that is absent from AVAILABLE_TOOLS.
Treat memories and beliefs as fallible context, not guaranteed truth.
Identify assumptions, unknowns, ways the plan can fail, verification evidence, and explicit stop conditions.
Prefer reversible read-only investigation before consequential action. Existing tool approval policies remain mandatory.

Return exactly:
{
  "assumptions":["..."],
  "hypotheses":["..."],
  "plan":["ordered observable action"],
  "unknowns":["..."],
  "verification":["observable evidence required before success"],
  "stopConditions":["condition that should block or stop execution"],
  "nextAction":"single best next action",
  "confidence":0.0,
  "preferredRoles":["research","engineer"]
}

GOAL:
${JSON.stringify(goal)}

GLOBAL_WORKSPACE:
${JSON.stringify(workspace)}

RECALLED_EPISODES:
${JSON.stringify(episodes)}

RECALLED_BELIEFS:
${JSON.stringify(beliefs)}

AVAILABLE_SKILLS:
${JSON.stringify(skills)}

AVAILABLE_TOOLS:
${JSON.stringify(availableTools)}`;

    let payload: Record<string, unknown>;
    try {
      const completion = await this.provider.complete({
        messages: [
          { role: "system", content: "Return valid compact JSON only. Do not expose private chain-of-thought." },
          { role: "user", content: prompt },
        ],
        tools: [],
      });
      payload = extractJsonObject(completion.message.content ?? "");
    } catch (error) {
      payload = {
        assumptions: [],
        hypotheses: [],
        plan: [goal.objective],
        unknowns: ["Metacognitive deliberation was unavailable; execution should start with safe observation."],
        verification: goal.successCriteria,
        stopConditions: ["Required access, evidence, or approval is unavailable."],
        nextAction: goal.objective,
        confidence: 0.25,
        preferredRoles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const assumptions = stringArray(payload.assumptions);
    const hypotheses = stringArray(payload.hypotheses);
    const plan = stringArray(payload.plan);
    const unknowns = stringArray(payload.unknowns);
    const verification = stringArray(payload.verification);
    const stopConditions = stringArray(payload.stopConditions);
    const nextAction = text(payload.nextAction, plan[0] ?? goal.objective);
    const confidence = clamp01(payload.confidence, 0.25);
    const preferredRoles = parseRoles(payload.preferredRoles);

    goal = await this.store.updateGoal(goal.id, {
      status: "active",
      assumptions,
      hypotheses,
      plan: plan.length ? plan : [goal.objective],
      unknowns,
      verification: verification.length ? verification : goal.successCriteria,
      stopConditions,
      nextAction,
      confidence,
    });

    const skillTokens = new Set(goal.objective.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const relevantSkills = skills
      .map((skill) => ({
        skill,
        score: skill.triggerPatterns.filter((pattern) =>
          [...skillTokens].some((token) => pattern.toLocaleLowerCase().includes(token)),
        ).length,
      }))
      .filter((item) => item.score > 0 || item.skill.status === "active")
      .sort((a, b) => b.score - a.score || b.skill.confidence - a.skill.confidence)
      .slice(0, this.options.maxContextSkills)
      .map((item) => item.skill);

    return {
      goal,
      assumptions,
      hypotheses,
      plan: goal.plan,
      unknowns,
      verification: goal.verification,
      stopConditions,
      nextAction,
      confidence,
      preferredRoles,
      recalledEpisodes: episodes,
      recalledBeliefs: beliefs,
      relevantSkills,
    };
  }

  async executeGoal(goalId: string, context: ToolContext): Promise<CognitiveExecution> {
    let goal = await this.store.getGoal(goalId);
    let preferredRoles: AgentRole[] = [];
    if (!goal.plan.length) {
      const deliberation = await this.deliberate({ goalId });
      goal = deliberation.goal;
      preferredRoles = deliberation.preferredRoles;
    }

    const executionGoal = [
      `Objective: ${goal.objective}`,
      goal.successCriteria.length ? `Success criteria:\n- ${goal.successCriteria.join("\n- ")}` : "",
      goal.plan.length ? `Metacognitive plan:\n1. ${goal.plan.join("\n2. ")}` : "",
      goal.assumptions.length ? `Assumptions to test:\n- ${goal.assumptions.join("\n- ")}` : "",
      goal.unknowns.length ? `Known unknowns:\n- ${goal.unknowns.join("\n- ")}` : "",
      goal.verification.length ? `Required verification:\n- ${goal.verification.join("\n- ")}` : "",
      goal.stopConditions.length ? `Stop/block conditions:\n- ${goal.stopConditions.join("\n- ")}` : "",
      "Do not claim completion without observable evidence. Keep consequential actions behind approval gates.",
    ].filter(Boolean).join("\n\n");

    const run = await this.orchestrator.runGoal({
      goal: executionGoal,
      ...(preferredRoles.length ? { preferredRoles } : {}),
    }, context);

    const verifier = verificationReview(run);
    const verified = run.status === "succeeded" && verifier.verdict === "pass" && verifier.confidence >= 70;
    const evidence = evidenceFromRun(run);
    const blockers = run.tasks
      .filter((task) => task.status === "blocked" || task.status === "failed")
      .map((task) => task.error ?? `${task.key}: ${task.objective}`);

    goal = await this.store.updateGoal(goal.id, {
      status: run.status === "blocked" ? "blocked" : run.status === "succeeded" ? "succeeded" : "failed",
      runId: run.id,
      evidence,
      blockers,
      outcome: run.synthesis ?? run.blockedReason ?? `Run completed with status ${run.status}`,
      confidence: verified ? Math.max(goal.confidence, verifier.confidence / 100) : Math.min(goal.confidence, 0.65),
    });

    const reflection = await this.reflect(goal, run, evidence, verified);
    return {
      goal,
      run,
      episode: reflection.episode,
      updatedBeliefs: reflection.updatedBeliefs,
      verified,
      ...(reflection.learnedSkill ? { learnedSkill: reflection.learnedSkill } : {}),
    };
  }

  async buildGlobalWorkspace(): Promise<{
    workspace: Awaited<ReturnType<CognitiveStore["workspace"]>>;
    selfModel: CognitiveSelfModel;
  }> {
    const [workspace, selfModel] = await Promise.all([this.store.workspace(), this.selfModel()]);
    return { workspace, selfModel };
  }

  async selfModel(): Promise<CognitiveSelfModel> {
    const [stats, skills] = await Promise.all([
      this.store.stats(),
      this.store.listSkills("active", 100),
    ]);
    const toolList = this.tools.list();
    const riskCounts: CognitiveSelfModel["toolRiskCounts"] = { safe: 0, write: 0, external: 0, dangerous: 0 };
    for (const tool of toolList) riskCounts[tool.risk] += 1;
    const domains = toolsByDomain(this.tools);

    const planning = Math.min(1, (domains.agentic?.length ?? 0) / 5 + (domains.planner?.length ?? 0) / 10);
    const action = Math.min(1, (riskCounts.write + riskCounts.external + riskCounts.dangerous) / 30);
    const memory = Math.min(1, (stats.episodes + stats.beliefs) / 100);
    const learning = Math.min(1, (stats.activeSkills * 2 + stats.candidateSkills + stats.episodes) / 50);
    const metacognition = Math.min(1, 0.45 + stats.evaluations * 0.05 + stats.contestedBeliefs * 0.02);
    const autonomyReadiness = Math.min(1, (planning + action + memory + learning + metacognition) / 5 * 0.8);

    return {
      generatedAt: new Date().toISOString(),
      identity: "CherryAgent cognitive runtime: a bounded tool-using software agent, not verified AGI or consciousness.",
      claims: [
        "Can deliberate over explicit goals and uncertainty.",
        "Can delegate work to specialist agents and use registered tools.",
        "Can retain episodic lessons, evidence-backed beliefs, and reusable skills.",
        "Can audit its available capabilities and confidence boundaries.",
      ],
      boundaries: [
        "No claim of sentience, consciousness, or human-equivalent general intelligence.",
        "No unrestricted self-modification or unbounded autonomous execution.",
        "External and dangerous actions remain subject to approval policy.",
        "Memories and beliefs may be wrong and must be checked against current evidence.",
        "Skill promotion requires verified success evidence.",
      ],
      toolCount: toolList.length,
      toolRiskCounts: riskCounts,
      capabilityDomains: domains,
      cognitiveStats: stats,
      maturity: { planning, action, memory, learning, metacognition, autonomyReadiness },
    };
  }

  async runCapabilityAudit(): Promise<Awaited<ReturnType<CognitiveStore["recordEvaluation"]>>> {
    const model = await this.selfModel();
    const dimensions = model.maturity;
    const values = Object.values(dimensions);
    const score = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length) * 100;
    const notes = [
      `Registered tools: ${model.toolCount}.`,
      `Active reusable skills: ${model.cognitiveStats.activeSkills}.`,
      `Recorded episodes: ${model.cognitiveStats.episodes}.`,
      `Evidence beliefs: ${model.cognitiveStats.beliefs}; contested: ${model.cognitiveStats.contestedBeliefs}.`,
      "This is an engineering maturity audit, not an AGI benchmark or consciousness test.",
    ];
    return await this.store.recordEvaluation({
      name: "CherryAgent cognitive maturity audit",
      score,
      maxScore: 100,
      dimensions,
      notes,
    });
  }

  async status(): Promise<{
    stats: Awaited<ReturnType<CognitiveStore["stats"]>>;
    selfModel: CognitiveSelfModel;
  }> {
    const [stats, selfModel] = await Promise.all([this.store.stats(), this.selfModel()]);
    return { stats, selfModel };
  }

  private async reflect(
    goal: CognitiveGoal,
    run: AgenticRun,
    evidence: string[],
    verified: boolean,
  ): Promise<{
    episode: CognitiveEpisode;
    learnedSkill?: CognitiveSkill;
    updatedBeliefs: CognitiveBelief[];
  }> {
    const prompt = `You are Cherry's post-action learning layer. Extract concise reusable lessons from the completed run.
Do not reveal hidden chain-of-thought. Return only operational JSON.
Do not convert an unverified or failed run into an active skill.
Belief updates must be factual propositions supported by evidence in RUN.

Return exactly:
{
  "summary":"what happened",
  "lessons":["reusable lesson"],
  "surprises":["prediction error or unexpected observation"],
  "utility":0.0,
  "confidence":0.0,
  "beliefUpdates":[{"subject":"...","predicate":"...","value":"...","confidence":0.0,"evidence":["..."]}],
  "skillCandidate":{"name":"...","description":"...","triggerPatterns":["..."],"procedure":["..."],"verification":["..."],"failureModes":["..."]}
}

GOAL:
${JSON.stringify(goal)}

VERIFIED_SUCCESS:
${verified}

RUN:
${JSON.stringify(compactRun(run))}`;

    let payload: Record<string, unknown> = {};
    try {
      const completion = await this.provider.complete({
        messages: [
          { role: "system", content: "Return valid compact JSON only. Never invent evidence." },
          { role: "user", content: prompt },
        ],
        tools: [],
      });
      payload = extractJsonObject(completion.message.content ?? "");
    } catch {
      payload = {};
    }

    const outcome = goalOutcome(run, verified);
    const episode = await this.store.recordEpisode({
      objective: goal.objective,
      outcome,
      summary: text(payload.summary, run.synthesis ?? run.blockedReason ?? `Run ${run.status}`),
      evidence,
      lessons: stringArray(payload.lessons),
      surprises: stringArray(payload.surprises),
      utility: clamp01(payload.utility, outcome === "succeeded" ? 0.8 : 0.35),
      confidence: clamp01(payload.confidence, verified ? 0.8 : 0.4),
      goalId: goal.id,
      runId: run.id,
    });

    const updatedBeliefs: CognitiveBelief[] = [];
    if (Array.isArray(payload.beliefUpdates)) {
      for (const raw of payload.beliefUpdates.slice(0, 20)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        const subject = text(item.subject);
        const predicate = text(item.predicate);
        const value = text(item.value);
        if (!subject || !predicate || !value) continue;
        updatedBeliefs.push(await this.store.upsertBelief({
          subject,
          predicate,
          value,
          confidence: clamp01(item.confidence, 0.5),
          evidence: stringArray(item.evidence).length ? stringArray(item.evidence) : evidence.slice(0, 10),
        }));
      }
    }

    let learnedSkill: CognitiveSkill | undefined;
    const rawSkill = payload.skillCandidate;
    if (rawSkill && typeof rawSkill === "object" && !Array.isArray(rawSkill)) {
      const item = rawSkill as Record<string, unknown>;
      const name = text(item.name);
      const procedure = stringArray(item.procedure);
      if (name && procedure.length && evidence.length) {
        learnedSkill = await this.store.upsertSkill({
          name,
          description: text(item.description, name),
          triggerPatterns: stringArray(item.triggerPatterns),
          procedure,
          verification: stringArray(item.verification),
          failureModes: stringArray(item.failureModes),
          status: verified ? "active" : "candidate",
          confidence: verified ? Math.max(0.7, episode.confidence) : Math.min(0.55, episode.confidence),
          sourceEpisodeId: episode.id,
          successfulUse: verified,
        });
      }
    }

    return {
      episode,
      updatedBeliefs,
      ...(learnedSkill ? { learnedSkill } : {}),
    };
  }
}
