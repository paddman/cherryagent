import type { AutonomyEngine } from "../../autonomy/AutonomyEngine.js";
import {
  type AutonomyEventSeverity,
  type AutonomyStore,
  type AutonomyThoughtKind,
  type AutonomyThoughtStatus,
} from "../../autonomy/AutonomyStore.js";
import type { AgentTool } from "../../core/types.js";

const thoughtKinds: AutonomyThoughtKind[] = ["open_question", "follow_up", "risk", "opportunity", "pattern", "commitment"];
const thoughtStatuses: AutonomyThoughtStatus[] = ["open", "resolved", "dismissed"];
const eventSeverities: AutonomyEventSeverity[] = ["info", "low", "medium", "high", "critical"];

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function clamp01(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Math.min(1, Math.max(0, Number.isFinite(parsed) ? parsed : fallback));
}

export function createAutonomyTools(autonomy: AutonomyEngine, store: AutonomyStore): AgentTool[] {
  return [
    {
      name: "autonomy_get_status",
      description: "Inspect Cherry's autonomy engine status, adaptive heartbeat state, persistent thought/event counts, and latest proactive decision.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ engine: autonomy.status, stats: await store.stats() }),
    },
    {
      name: "autonomy_list_thoughts",
      description: "List Cherry's persistent open questions, follow-ups, risks, opportunities, patterns, and commitments.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: thoughtStatuses },
          limit: { type: "number", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const status = typeof args.status === "string" && thoughtStatuses.includes(args.status as AutonomyThoughtStatus)
          ? args.status as AutonomyThoughtStatus
          : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 100;
        return store.listThoughts(status, limit);
      },
    },
    {
      name: "autonomy_list_decisions",
      description: "Inspect recent autonomous decisions with action, score, evidence, reason, outcome, and notification state.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", minimum: 1, maximum: 500 } },
        additionalProperties: false,
      },
      execute: async (args) => store.listDecisions(typeof args.limit === "number" ? args.limit : 100),
    },
    {
      name: "autonomy_remember_thought",
      description: "Persist a useful open question, follow-up, risk, opportunity, pattern, or commitment for Cherry to revisit in future autonomous reflection.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: thoughtKinds },
          subject: { type: "string" },
          thought: { type: "string" },
          importance: { type: "number", minimum: 0, maximum: 1 },
          curiosity: { type: "number", minimum: 0, maximum: 1 },
          recheckAfterMinutes: { type: "number", minimum: 1 },
        },
        required: ["kind", "subject", "thought"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const kind = requiredString(args, "kind") as AutonomyThoughtKind;
        if (!thoughtKinds.includes(kind)) throw new Error(`Unknown autonomy thought kind: ${kind}`);
        const recheckAfterMinutes = Number(args.recheckAfterMinutes);
        return store.upsertThoughts([{
          kind,
          subject: requiredString(args, "subject"),
          thought: requiredString(args, "thought"),
          importance: clamp01(args.importance, 0.5),
          curiosity: clamp01(args.curiosity, 0.5),
          ...(Number.isFinite(recheckAfterMinutes) && recheckAfterMinutes > 0
            ? { recheckAfterMinutes: Math.round(recheckAfterMinutes) }
            : {}),
        }]);
      },
    },
    {
      name: "autonomy_emit_event",
      description: "Feed a meaningful event into Cherry's autonomy queue and wake the initiative engine for event-driven reflection.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string" },
          type: { type: "string" },
          summary: { type: "string" },
          severity: { type: "string", enum: eventSeverities },
        },
        required: ["source", "type", "summary"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const severity = typeof args.severity === "string" && eventSeverities.includes(args.severity as AutonomyEventSeverity)
          ? args.severity as AutonomyEventSeverity
          : "info";
        return autonomy.ingestEvent({
          source: requiredString(args, "source"),
          type: requiredString(args, "type"),
          summary: requiredString(args, "summary"),
          severity,
        });
      },
    },
  ];
}
