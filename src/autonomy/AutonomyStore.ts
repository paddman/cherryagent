import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AutonomyAction =
  | "ignore"
  | "remember"
  | "recheck_later"
  | "act_silently"
  | "act_and_notify"
  | "notify_now"
  | "request_approval";

export type AutonomyScores = {
  urgency: number;
  userRelevance: number;
  expectedValue: number;
  novelty: number;
  confidence: number;
  actionability: number;
  interruptionCost: number;
  repetition: number;
};

export type AutonomyThoughtKind = "open_question" | "follow_up" | "risk" | "opportunity" | "pattern" | "commitment";
export type AutonomyThoughtStatus = "open" | "resolved" | "dismissed";

export type AutonomyThought = {
  id: string;
  kind: AutonomyThoughtKind;
  subject: string;
  thought: string;
  importance: number;
  curiosity: number;
  status: AutonomyThoughtStatus;
  createdAt: string;
  updatedAt: string;
  lastMatchedAt?: string;
  recheckAt?: string;
};

export type AutonomyEventSeverity = "info" | "low" | "medium" | "high" | "critical";

export type AutonomyEvent = {
  id: string;
  source: string;
  type: string;
  summary: string;
  severity: AutonomyEventSeverity;
  createdAt: string;
  data?: unknown;
  processedAt?: string;
  decisionId?: string;
};

export type AutonomyDecision = {
  id: string;
  action: AutonomyAction;
  topic: string;
  reason: string;
  evidence: string[];
  scores: AutonomyScores;
  score: number;
  createdAt: string;
  trigger: string;
  goal?: string;
  message?: string;
  outcome?: string;
  runId?: string;
  notifiedAt?: string;
};

export type AutonomyThoughtInput = {
  kind: AutonomyThoughtKind;
  subject: string;
  thought: string;
  importance: number;
  curiosity: number;
  recheckAfterMinutes?: number;
};

type AutonomyData = {
  version: 1;
  thoughts: AutonomyThought[];
  events: AutonomyEvent[];
  decisions: AutonomyDecision[];
};

const emptyData = (): AutonomyData => ({ version: 1, thoughts: [], events: [], decisions: [] });

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function clean(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function thoughtKey(subject: string): string {
  return subject.trim().toLocaleLowerCase();
}

export class AutonomyStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<AutonomyData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AutonomyData>;
      return {
        version: 1,
        thoughts: Array.isArray(parsed.thoughts) ? parsed.thoughts : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw error;
    }
  }

  async context(input: { thoughtLimit?: number; decisionLimit?: number; eventLimit?: number } = {}): Promise<{
    openThoughts: AutonomyThought[];
    recentDecisions: AutonomyDecision[];
    pendingEvents: AutonomyEvent[];
  }> {
    const data = await this.read();
    const thoughtLimit = Math.min(100, Math.max(1, input.thoughtLimit ?? 20));
    const decisionLimit = Math.min(100, Math.max(1, input.decisionLimit ?? 20));
    const eventLimit = Math.min(100, Math.max(1, input.eventLimit ?? 30));
    return {
      openThoughts: data.thoughts
        .filter((item) => item.status === "open")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, thoughtLimit),
      recentDecisions: data.decisions.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, decisionLimit),
      pendingEvents: data.events
        .filter((item) => !item.processedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, eventLimit),
    };
  }

  async addEvent(input: {
    source: string;
    type: string;
    summary: string;
    severity?: AutonomyEventSeverity;
    data?: unknown;
  }): Promise<AutonomyEvent> {
    return this.#mutate((data) => {
      const event: AutonomyEvent = {
        id: crypto.randomUUID(),
        source: clean(input.source, "unknown"),
        type: clean(input.type, "event"),
        summary: clean(input.summary, "New event"),
        severity: input.severity ?? "info",
        createdAt: new Date().toISOString(),
        ...(input.data !== undefined ? { data: input.data } : {}),
      };
      data.events.unshift(event);
      if (data.events.length > 5000) data.events.length = 5000;
      return event;
    });
  }

  async markEventsProcessed(ids: string[], decisionId: string): Promise<number> {
    if (!ids.length) return 0;
    return this.#mutate((data) => {
      const wanted = new Set(ids);
      const now = new Date().toISOString();
      let updated = 0;
      for (const event of data.events) {
        if (!wanted.has(event.id) || event.processedAt) continue;
        event.processedAt = now;
        event.decisionId = decisionId;
        updated += 1;
      }
      return updated;
    });
  }

  async upsertThoughts(inputs: AutonomyThoughtInput[]): Promise<AutonomyThought[]> {
    if (!inputs.length) return [];
    return this.#mutate((data) => {
      const now = new Date();
      const updated: AutonomyThought[] = [];
      for (const input of inputs.slice(0, 20)) {
        const subject = clean(input.subject, "Untitled thought");
        const thought = clean(input.thought, subject);
        const existing = data.thoughts.find((item) => item.status === "open" && thoughtKey(item.subject) === thoughtKey(subject));
        const recheckAt = input.recheckAfterMinutes !== undefined
          ? new Date(now.getTime() + Math.max(1, input.recheckAfterMinutes) * 60_000).toISOString()
          : undefined;
        if (existing) {
          existing.kind = input.kind;
          existing.thought = thought;
          existing.importance = clamp01(input.importance);
          existing.curiosity = clamp01(input.curiosity);
          existing.updatedAt = now.toISOString();
          existing.lastMatchedAt = now.toISOString();
          if (recheckAt) existing.recheckAt = recheckAt;
          updated.push(existing);
          continue;
        }
        const created: AutonomyThought = {
          id: crypto.randomUUID(),
          kind: input.kind,
          subject,
          thought,
          importance: clamp01(input.importance),
          curiosity: clamp01(input.curiosity),
          status: "open",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          ...(recheckAt ? { recheckAt } : {}),
        };
        data.thoughts.unshift(created);
        updated.push(created);
      }
      if (data.thoughts.length > 2000) data.thoughts.length = 2000;
      return updated;
    });
  }

  async resolveThought(id: string, status: Extract<AutonomyThoughtStatus, "resolved" | "dismissed">): Promise<AutonomyThought> {
    return this.#mutate((data) => {
      const thought = data.thoughts.find((item) => item.id === id);
      if (!thought) throw new Error(`Autonomy thought not found: ${id}`);
      thought.status = status;
      thought.updatedAt = new Date().toISOString();
      return thought;
    });
  }

  async recordDecision(input: Omit<AutonomyDecision, "id" | "createdAt">): Promise<AutonomyDecision> {
    return this.#mutate((data) => {
      const decision: AutonomyDecision = {
        id: crypto.randomUUID(),
        action: input.action,
        topic: clean(input.topic, "general"),
        reason: clean(input.reason, "No reason recorded"),
        evidence: [...new Set(input.evidence.map((item) => item.trim()).filter(Boolean))].slice(0, 30),
        scores: {
          urgency: clamp01(input.scores.urgency),
          userRelevance: clamp01(input.scores.userRelevance),
          expectedValue: clamp01(input.scores.expectedValue),
          novelty: clamp01(input.scores.novelty),
          confidence: clamp01(input.scores.confidence),
          actionability: clamp01(input.scores.actionability),
          interruptionCost: clamp01(input.scores.interruptionCost),
          repetition: clamp01(input.scores.repetition),
        },
        score: clamp01(input.score),
        createdAt: new Date().toISOString(),
        trigger: clean(input.trigger, "heartbeat"),
        ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
        ...(input.message?.trim() ? { message: input.message.trim() } : {}),
        ...(input.outcome?.trim() ? { outcome: input.outcome.trim() } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.notifiedAt ? { notifiedAt: input.notifiedAt } : {}),
      };
      data.decisions.unshift(decision);
      if (data.decisions.length > 5000) data.decisions.length = 5000;
      return decision;
    });
  }

  async updateDecision(
    id: string,
    patch: Partial<Pick<AutonomyDecision, "outcome" | "runId" | "notifiedAt" | "message">>,
  ): Promise<AutonomyDecision> {
    return this.#mutate((data) => {
      const decision = data.decisions.find((item) => item.id === id);
      if (!decision) throw new Error(`Autonomy decision not found: ${id}`);
      if (patch.outcome !== undefined) decision.outcome = patch.outcome;
      if (patch.runId !== undefined) decision.runId = patch.runId;
      if (patch.notifiedAt !== undefined) decision.notifiedAt = patch.notifiedAt;
      if (patch.message !== undefined) decision.message = patch.message;
      return decision;
    });
  }

  async listThoughts(status?: AutonomyThoughtStatus, limit = 100): Promise<AutonomyThought[]> {
    const data = await this.read();
    return data.thoughts
      .filter((item) => !status || item.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.min(500, Math.max(1, limit)));
  }

  async listDecisions(limit = 100): Promise<AutonomyDecision[]> {
    const data = await this.read();
    return data.decisions
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(500, Math.max(1, limit)));
  }

  async countActionsSince(since: Date): Promise<number> {
    const data = await this.read();
    const threshold = since.getTime();
    return data.decisions.filter((item) =>
      ["act_silently", "act_and_notify", "notify_now", "request_approval"].includes(item.action)
      && new Date(item.createdAt).getTime() >= threshold,
    ).length;
  }

  async countNotificationsSince(since: Date): Promise<number> {
    const data = await this.read();
    const threshold = since.getTime();
    return data.decisions.filter((item) => item.notifiedAt && new Date(item.notifiedAt).getTime() >= threshold).length;
  }

  async findRecentTopicDecision(topic: string, since: Date): Promise<AutonomyDecision | undefined> {
    const data = await this.read();
    const key = thoughtKey(topic);
    const threshold = since.getTime();
    return data.decisions.find((item) => thoughtKey(item.topic) === key && new Date(item.createdAt).getTime() >= threshold);
  }

  async stats(): Promise<{
    openThoughts: number;
    pendingEvents: number;
    decisions: number;
    proactiveMessages: number;
    autonomousActions: number;
  }> {
    const data = await this.read();
    return {
      openThoughts: data.thoughts.filter((item) => item.status === "open").length,
      pendingEvents: data.events.filter((item) => !item.processedAt).length,
      decisions: data.decisions.length,
      proactiveMessages: data.decisions.filter((item) => item.notifiedAt).length,
      autonomousActions: data.decisions.filter((item) => ["act_silently", "act_and_notify"].includes(item.action)).length,
    };
  }

  async #mutate<T>(mutation: (data: AutonomyData) => T): Promise<T> {
    let result!: T;
    const operation = this.#queue.then(async () => {
      const data = await this.read();
      result = mutation(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, JSON.stringify(data, null, 2) + "\n", "utf8");
      await rename(temp, this.filePath);
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
    return structuredClone(result);
  }
}
