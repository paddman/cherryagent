import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CognitiveGoalStatus = "proposed" | "active" | "blocked" | "succeeded" | "failed" | "cancelled";
export type CognitivePriority = "low" | "normal" | "high" | "critical";
export type EpisodeOutcome = "succeeded" | "partial" | "blocked" | "failed";
export type SkillStatus = "candidate" | "active" | "deprecated";
export type BeliefStatus = "active" | "contested" | "retracted";

export type CognitiveGoal = {
  id: string;
  objective: string;
  successCriteria: string[];
  priority: CognitivePriority;
  status: CognitiveGoalStatus;
  confidence: number;
  assumptions: string[];
  hypotheses: string[];
  plan: string[];
  unknowns: string[];
  verification: string[];
  stopConditions: string[];
  evidence: string[];
  blockers: string[];
  createdAt: string;
  updatedAt: string;
  parentGoalId?: string;
  nextAction?: string;
  runId?: string;
  outcome?: string;
};

export type CognitiveEpisode = {
  id: string;
  objective: string;
  outcome: EpisodeOutcome;
  summary: string;
  evidence: string[];
  lessons: string[];
  surprises: string[];
  utility: number;
  confidence: number;
  createdAt: string;
  goalId?: string;
  runId?: string;
};

export type CognitiveSkill = {
  id: string;
  name: string;
  description: string;
  triggerPatterns: string[];
  procedure: string[];
  verification: string[];
  failureModes: string[];
  status: SkillStatus;
  confidence: number;
  successCount: number;
  failureCount: number;
  sourceEpisodeIds: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

export type CognitiveBelief = {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  evidence: string[];
  status: BeliefStatus;
  contradictions: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};

export type CognitiveEvaluation = {
  id: string;
  name: string;
  score: number;
  maxScore: number;
  dimensions: Record<string, number>;
  notes: string[];
  createdAt: string;
};

export type CognitiveWorkspace = {
  generatedAt: string;
  activeGoals: CognitiveGoal[];
  blockedGoals: CognitiveGoal[];
  recentEpisodes: CognitiveEpisode[];
  activeSkills: CognitiveSkill[];
  contestedBeliefs: CognitiveBelief[];
  recentEvaluations: CognitiveEvaluation[];
};

type CognitiveData = {
  version: 1;
  goals: CognitiveGoal[];
  episodes: CognitiveEpisode[];
  skills: CognitiveSkill[];
  beliefs: CognitiveBelief[];
  evaluations: CognitiveEvaluation[];
};

const emptyData = (): CognitiveData => ({
  version: 1,
  goals: [],
  episodes: [],
  skills: [],
  beliefs: [],
  evaluations: [],
});

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function clean(value: string, fallback: string): string {
  const text = value.trim();
  return text || fallback;
}

function uniqueStrings(values: readonly string[], limit = 100): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function tokens(value: string): Set<string> {
  return new Set(value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 1));
}

function overlapScore(query: Set<string>, text: string): number {
  if (!query.size) return 0;
  const target = tokens(text);
  let hits = 0;
  for (const token of query) if (target.has(token)) hits += 1;
  return hits / query.size;
}

export class CognitiveStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<CognitiveData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<CognitiveData>;
      return {
        version: 1,
        goals: Array.isArray(parsed.goals) ? parsed.goals : [],
        episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
        skills: Array.isArray(parsed.skills) ? parsed.skills : [],
        beliefs: Array.isArray(parsed.beliefs) ? parsed.beliefs : [],
        evaluations: Array.isArray(parsed.evaluations) ? parsed.evaluations : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw error;
    }
  }

  async createGoal(input: {
    objective: string;
    successCriteria?: string[];
    priority?: CognitivePriority;
    parentGoalId?: string;
    confidence?: number;
  }): Promise<CognitiveGoal> {
    return await this.#mutate((data) => {
      const now = new Date().toISOString();
      const goal: CognitiveGoal = {
        id: crypto.randomUUID(),
        objective: clean(input.objective, "Untitled goal"),
        successCriteria: uniqueStrings(input.successCriteria ?? []),
        priority: input.priority ?? "normal",
        status: "proposed",
        confidence: clamp01(input.confidence ?? 0.5),
        assumptions: [],
        hypotheses: [],
        plan: [],
        unknowns: [],
        verification: [],
        stopConditions: [],
        evidence: [],
        blockers: [],
        createdAt: now,
        updatedAt: now,
        ...(input.parentGoalId?.trim() ? { parentGoalId: input.parentGoalId.trim() } : {}),
      };
      data.goals.unshift(goal);
      if (data.goals.length > 5000) data.goals.length = 5000;
      return goal;
    });
  }

  async getGoal(id: string): Promise<CognitiveGoal> {
    const data = await this.read();
    const goal = data.goals.find((item) => item.id === id);
    if (!goal) throw new Error(`Cognitive goal not found: ${id}`);
    return structuredClone(goal);
  }

  async listGoals(status?: CognitiveGoalStatus, limit = 100): Promise<CognitiveGoal[]> {
    const data = await this.read();
    return structuredClone(data.goals
      .filter((item) => !status || item.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.min(500, Math.max(1, limit))));
  }

  async updateGoal(
    id: string,
    patch: Partial<Pick<CognitiveGoal,
      "status" | "confidence" | "assumptions" | "hypotheses" | "plan" | "unknowns" |
      "verification" | "stopConditions" | "evidence" | "blockers" | "nextAction" | "runId" | "outcome"
    >>,
  ): Promise<CognitiveGoal> {
    return await this.#mutate((data) => {
      const goal = data.goals.find((item) => item.id === id);
      if (!goal) throw new Error(`Cognitive goal not found: ${id}`);
      if (patch.status !== undefined) goal.status = patch.status;
      if (patch.confidence !== undefined) goal.confidence = clamp01(patch.confidence);
      if (patch.assumptions !== undefined) goal.assumptions = uniqueStrings(patch.assumptions);
      if (patch.hypotheses !== undefined) goal.hypotheses = uniqueStrings(patch.hypotheses);
      if (patch.plan !== undefined) goal.plan = uniqueStrings(patch.plan);
      if (patch.unknowns !== undefined) goal.unknowns = uniqueStrings(patch.unknowns);
      if (patch.verification !== undefined) goal.verification = uniqueStrings(patch.verification);
      if (patch.stopConditions !== undefined) goal.stopConditions = uniqueStrings(patch.stopConditions);
      if (patch.evidence !== undefined) goal.evidence = uniqueStrings(patch.evidence, 300);
      if (patch.blockers !== undefined) goal.blockers = uniqueStrings(patch.blockers);
      if (patch.nextAction !== undefined) goal.nextAction = patch.nextAction.trim();
      if (patch.runId !== undefined) goal.runId = patch.runId;
      if (patch.outcome !== undefined) goal.outcome = patch.outcome;
      goal.updatedAt = new Date().toISOString();
      return goal;
    });
  }

  async recordEpisode(input: {
    objective: string;
    outcome: EpisodeOutcome;
    summary: string;
    evidence?: string[];
    lessons?: string[];
    surprises?: string[];
    utility?: number;
    confidence?: number;
    goalId?: string;
    runId?: string;
  }): Promise<CognitiveEpisode> {
    return await this.#mutate((data) => {
      const episode: CognitiveEpisode = {
        id: crypto.randomUUID(),
        objective: clean(input.objective, "Untitled episode"),
        outcome: input.outcome,
        summary: clean(input.summary, "No summary recorded"),
        evidence: uniqueStrings(input.evidence ?? [], 300),
        lessons: uniqueStrings(input.lessons ?? []),
        surprises: uniqueStrings(input.surprises ?? []),
        utility: clamp01(input.utility ?? 0.5),
        confidence: clamp01(input.confidence ?? 0.5),
        createdAt: new Date().toISOString(),
        ...(input.goalId ? { goalId: input.goalId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
      };
      data.episodes.unshift(episode);
      if (data.episodes.length > 10000) data.episodes.length = 10000;
      return episode;
    });
  }

  async recallEpisodes(query: string, limit = 10): Promise<Array<CognitiveEpisode & { relevance: number }>> {
    const data = await this.read();
    const queryTokens = tokens(query);
    return data.episodes
      .map((episode) => ({
        ...episode,
        relevance: overlapScore(queryTokens, [
          episode.objective,
          episode.summary,
          ...episode.lessons,
          ...episode.surprises,
        ].join(" ")),
      }))
      .filter((episode) => episode.relevance > 0 || !queryTokens.size)
      .sort((a, b) => b.relevance - a.relevance || b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(100, Math.max(1, limit)));
  }

  async upsertSkill(input: {
    name: string;
    description: string;
    triggerPatterns?: string[];
    procedure: string[];
    verification?: string[];
    failureModes?: string[];
    status?: SkillStatus;
    confidence?: number;
    sourceEpisodeId?: string;
    successfulUse?: boolean;
  }): Promise<CognitiveSkill> {
    return await this.#mutate((data) => {
      const now = new Date().toISOString();
      const name = clean(input.name, "Untitled skill");
      const existing = data.skills.find((item) => normalizeKey(item.name) === normalizeKey(name));
      if (existing) {
        existing.description = clean(input.description, existing.description);
        existing.triggerPatterns = uniqueStrings([...existing.triggerPatterns, ...(input.triggerPatterns ?? [])]);
        existing.procedure = uniqueStrings(input.procedure);
        existing.verification = uniqueStrings(input.verification ?? existing.verification);
        existing.failureModes = uniqueStrings([...existing.failureModes, ...(input.failureModes ?? [])]);
        if (input.status !== undefined) existing.status = input.status;
        if (input.confidence !== undefined) existing.confidence = clamp01(input.confidence);
        if (input.sourceEpisodeId) existing.sourceEpisodeIds = uniqueStrings([...existing.sourceEpisodeIds, input.sourceEpisodeId]);
        if (input.successfulUse === true) existing.successCount += 1;
        if (input.successfulUse === false) existing.failureCount += 1;
        existing.updatedAt = now;
        existing.lastUsedAt = now;
        return existing;
      }
      const skill: CognitiveSkill = {
        id: crypto.randomUUID(),
        name,
        description: clean(input.description, name),
        triggerPatterns: uniqueStrings(input.triggerPatterns ?? []),
        procedure: uniqueStrings(input.procedure),
        verification: uniqueStrings(input.verification ?? []),
        failureModes: uniqueStrings(input.failureModes ?? []),
        status: input.status ?? "candidate",
        confidence: clamp01(input.confidence ?? 0.5),
        successCount: input.successfulUse === true ? 1 : 0,
        failureCount: input.successfulUse === false ? 1 : 0,
        sourceEpisodeIds: input.sourceEpisodeId ? [input.sourceEpisodeId] : [],
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
      };
      data.skills.unshift(skill);
      if (data.skills.length > 3000) data.skills.length = 3000;
      return skill;
    });
  }

  async listSkills(status?: SkillStatus, limit = 100): Promise<CognitiveSkill[]> {
    const data = await this.read();
    return structuredClone(data.skills
      .filter((item) => !status || item.status === status)
      .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.min(500, Math.max(1, limit))));
  }

  async upsertBelief(input: {
    subject: string;
    predicate: string;
    value: string;
    confidence?: number;
    evidence?: string[];
    expiresAt?: string;
  }): Promise<CognitiveBelief> {
    return await this.#mutate((data) => {
      const now = new Date().toISOString();
      const subject = clean(input.subject, "unknown");
      const predicate = clean(input.predicate, "is");
      const value = clean(input.value, "unknown");
      const key = `${normalizeKey(subject)}::${normalizeKey(predicate)}`;
      const sameKey = data.beliefs.filter((item) => `${normalizeKey(item.subject)}::${normalizeKey(item.predicate)}` === key && item.status !== "retracted");
      const exact = sameKey.find((item) => normalizeKey(item.value) === normalizeKey(value));
      if (exact) {
        exact.confidence = clamp01(Math.max(exact.confidence, input.confidence ?? exact.confidence));
        exact.evidence = uniqueStrings([...exact.evidence, ...(input.evidence ?? [])], 300);
        exact.updatedAt = now;
        if (input.expiresAt) exact.expiresAt = input.expiresAt;
        return exact;
      }

      const contradictions = sameKey.map((item) => `${item.value} (${Math.round(item.confidence * 100)}%)`);
      for (const belief of sameKey) {
        belief.status = "contested";
        belief.contradictions = uniqueStrings([...belief.contradictions, value]);
        belief.confidence = clamp01(belief.confidence * 0.8);
        belief.updatedAt = now;
      }

      const belief: CognitiveBelief = {
        id: crypto.randomUUID(),
        subject,
        predicate,
        value,
        confidence: clamp01(input.confidence ?? 0.5),
        evidence: uniqueStrings(input.evidence ?? [], 300),
        status: contradictions.length ? "contested" : "active",
        contradictions,
        createdAt: now,
        updatedAt: now,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      };
      data.beliefs.unshift(belief);
      if (data.beliefs.length > 10000) data.beliefs.length = 10000;
      return belief;
    });
  }

  async queryBeliefs(query: string, limit = 20): Promise<Array<CognitiveBelief & { relevance: number }>> {
    const data = await this.read();
    const queryTokens = tokens(query);
    const now = Date.now();
    return data.beliefs
      .filter((belief) => belief.status !== "retracted")
      .filter((belief) => !belief.expiresAt || new Date(belief.expiresAt).getTime() > now)
      .map((belief) => ({
        ...belief,
        relevance: overlapScore(queryTokens, `${belief.subject} ${belief.predicate} ${belief.value} ${belief.evidence.join(" ")}`),
      }))
      .filter((belief) => belief.relevance > 0 || !queryTokens.size)
      .sort((a, b) => b.relevance - a.relevance || b.confidence - a.confidence)
      .slice(0, Math.min(100, Math.max(1, limit)));
  }

  async recordEvaluation(input: {
    name: string;
    score: number;
    maxScore: number;
    dimensions?: Record<string, number>;
    notes?: string[];
  }): Promise<CognitiveEvaluation> {
    return await this.#mutate((data) => {
      const maxScore = Math.max(1, Number.isFinite(input.maxScore) ? input.maxScore : 1);
      const evaluation: CognitiveEvaluation = {
        id: crypto.randomUUID(),
        name: clean(input.name, "Cognitive evaluation"),
        score: Math.min(maxScore, Math.max(0, Number.isFinite(input.score) ? input.score : 0)),
        maxScore,
        dimensions: Object.fromEntries(Object.entries(input.dimensions ?? {}).map(([key, value]) => [key, clamp01(value)])),
        notes: uniqueStrings(input.notes ?? []),
        createdAt: new Date().toISOString(),
      };
      data.evaluations.unshift(evaluation);
      if (data.evaluations.length > 2000) data.evaluations.length = 2000;
      return evaluation;
    });
  }

  async workspace(): Promise<CognitiveWorkspace> {
    const data = await this.read();
    return {
      generatedAt: new Date().toISOString(),
      activeGoals: structuredClone(data.goals.filter((item) => item.status === "active" || item.status === "proposed").slice(0, 20)),
      blockedGoals: structuredClone(data.goals.filter((item) => item.status === "blocked").slice(0, 20)),
      recentEpisodes: structuredClone(data.episodes.slice(0, 20)),
      activeSkills: structuredClone(data.skills.filter((item) => item.status === "active").slice(0, 30)),
      contestedBeliefs: structuredClone(data.beliefs.filter((item) => item.status === "contested").slice(0, 30)),
      recentEvaluations: structuredClone(data.evaluations.slice(0, 10)),
    };
  }

  async stats(): Promise<{
    goals: Record<CognitiveGoalStatus, number>;
    episodes: number;
    activeSkills: number;
    candidateSkills: number;
    beliefs: number;
    contestedBeliefs: number;
    evaluations: number;
  }> {
    const data = await this.read();
    const goals: Record<CognitiveGoalStatus, number> = {
      proposed: 0,
      active: 0,
      blocked: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const goal of data.goals) goals[goal.status] += 1;
    return {
      goals,
      episodes: data.episodes.length,
      activeSkills: data.skills.filter((item) => item.status === "active").length,
      candidateSkills: data.skills.filter((item) => item.status === "candidate").length,
      beliefs: data.beliefs.length,
      contestedBeliefs: data.beliefs.filter((item) => item.status === "contested").length,
      evaluations: data.evaluations.length,
    };
  }

  async #mutate<T>(mutation: (data: CognitiveData) => T): Promise<T> {
    let result!: T;
    const operation = this.#queue.then(async () => {
      const data = await this.read();
      result = mutation(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temp, this.filePath);
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
    return structuredClone(result);
  }
}
