import type { LlmProvider } from "../core/types.js";
import {
  type AutonomyAction,
  type AutonomyScores,
  type AutonomyThoughtInput,
  type AutonomyThoughtKind,
} from "./AutonomyStore.js";
import type { WorldState } from "./WorldObserver.js";

export type InitiativeReflection = {
  proposedAction: AutonomyAction;
  topic: string;
  goal?: string;
  message?: string;
  reason: string;
  evidence: string[];
  scores: AutonomyScores;
  thoughts: AutonomyThoughtInput[];
};

const actions: AutonomyAction[] = [
  "ignore",
  "remember",
  "recheck_later",
  "act_silently",
  "act_and_notify",
  "notify_now",
  "request_approval",
];

const thoughtKinds: AutonomyThoughtKind[] = [
  "open_question",
  "follow_up",
  "risk",
  "opportunity",
  "pattern",
  "commitment",
];

function clamp01(value: unknown): number {
  const parsed = Number(value);
  return Math.min(1, Math.max(0, Number.isFinite(parsed) ? parsed : 0));
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function strings(value: unknown, limit = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, limit);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Initiative reasoner did not return a JSON object");
  const parsed = JSON.parse(value.slice(first, last + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Initiative reasoner returned invalid JSON");
  return parsed as Record<string, unknown>;
}

function parseScores(value: unknown): AutonomyScores {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    urgency: clamp01(input.urgency),
    userRelevance: clamp01(input.userRelevance),
    expectedValue: clamp01(input.expectedValue),
    novelty: clamp01(input.novelty),
    confidence: clamp01(input.confidence),
    actionability: clamp01(input.actionability),
    interruptionCost: clamp01(input.interruptionCost),
    repetition: clamp01(input.repetition),
  };
}

function parseThoughts(value: unknown): AutonomyThoughtInput[] {
  if (!Array.isArray(value)) return [];
  const result: AutonomyThoughtInput[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const input = item as Record<string, unknown>;
    const subject = text(input.subject);
    const thought = text(input.thought);
    if (!subject || !thought) continue;
    const kind = typeof input.kind === "string" && thoughtKinds.includes(input.kind as AutonomyThoughtKind)
      ? input.kind as AutonomyThoughtKind
      : "open_question";
    const recheckAfterMinutes = Number(input.recheckAfterMinutes);
    result.push({
      kind,
      subject,
      thought,
      importance: clamp01(input.importance),
      curiosity: clamp01(input.curiosity),
      ...(Number.isFinite(recheckAfterMinutes) && recheckAfterMinutes > 0
        ? { recheckAfterMinutes: Math.round(recheckAfterMinutes) }
        : {}),
    });
  }
  return result;
}

function safeFallback(reason: string): InitiativeReflection {
  return {
    proposedAction: "ignore",
    topic: "autonomy-runtime",
    reason,
    evidence: [],
    scores: {
      urgency: 0,
      userRelevance: 0,
      expectedValue: 0,
      novelty: 0,
      confidence: 0,
      actionability: 0,
      interruptionCost: 1,
      repetition: 0,
    },
    thoughts: [],
  };
}

export class InitiativeReasoner {
  constructor(private readonly provider: LlmProvider) {}

  async reflect(world: WorldState, trigger: string): Promise<InitiativeReflection> {
    const prompt = `You are Cherry's initiative reasoner. Your job is to decide whether Cherry should proactively do something without waiting for a direct user command.

Core drives:
- protect systems and notice meaningful anomalies
- help the user with active goals and current context
- finish commitments and unblock stalled work
- reduce future work through useful automation or learning
- find genuinely valuable opportunities
- avoid interrupting the user unnecessarily

Important rules:
- Silence is a valid and often best decision.
- Do not invent events, incidents, metrics, user preferences, or evidence.
- Base every non-ignore decision on evidence present in WORLD_STATE.
- Prefer safe read-only investigation over external or destructive action.
- Consequential tool actions remain protected by the existing approval gate.
- Do not notify merely because the heartbeat fired.
- Avoid repeating the same topic when nothing meaningfully changed.
- A pending event may justify immediate attention; stale ordinary state often does not.
- Keep user-facing proactive messages brief and concrete.

Return ONLY compact JSON in this exact shape:
{
  "proposedAction":"ignore|remember|recheck_later|act_silently|act_and_notify|notify_now|request_approval",
  "topic":"stable short topic key",
  "goal":"optional concrete autonomous goal",
  "message":"optional concise user-facing message",
  "reason":"why this decision is justified",
  "evidence":["specific evidence from world state"],
  "scores":{
    "urgency":0.0,
    "userRelevance":0.0,
    "expectedValue":0.0,
    "novelty":0.0,
    "confidence":0.0,
    "actionability":0.0,
    "interruptionCost":0.0,
    "repetition":0.0
  },
  "thoughts":[{
    "kind":"open_question|follow_up|risk|opportunity|pattern|commitment",
    "subject":"short subject",
    "thought":"what Cherry wants to remember or revisit",
    "importance":0.0,
    "curiosity":0.0,
    "recheckAfterMinutes":60
  }]
}

Decision guidance:
- ignore: nothing useful now
- remember: worth retaining, but no action yet
- recheck_later: revisit when more evidence may exist
- act_silently: useful safe work can be done without interrupting user
- act_and_notify: perform useful work, then report result
- notify_now: user should know now; no autonomous goal is necessary first
- request_approval: the useful next step is consequential and should be surfaced for user approval

TRIGGER:
${trigger}

WORLD_STATE:
${JSON.stringify(world)}`;

    try {
      const completion = await this.provider.complete({
        messages: [
          { role: "system", content: "Return valid compact JSON only. Do not expose hidden reasoning." },
          { role: "user", content: prompt },
        ],
        tools: [],
      });
      const payload = parseJsonObject(completion.message.content ?? "");
      const proposedAction = typeof payload.proposedAction === "string" && actions.includes(payload.proposedAction as AutonomyAction)
        ? payload.proposedAction as AutonomyAction
        : "ignore";
      const topic = text(payload.topic, "general");
      const goal = text(payload.goal);
      const message = text(payload.message);
      return {
        proposedAction,
        topic,
        reason: text(payload.reason, "No useful autonomous initiative identified."),
        evidence: strings(payload.evidence),
        scores: parseScores(payload.scores),
        thoughts: parseThoughts(payload.thoughts),
        ...(goal ? { goal } : {}),
        ...(message ? { message } : {}),
      };
    } catch (error) {
      return safeFallback(`Initiative reasoning failed safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
