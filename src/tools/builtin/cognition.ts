import type { CognitiveEngine } from "../../cognition/CognitiveEngine.js";
import {
  type CognitiveGoalStatus,
  type CognitivePriority,
  type CognitiveStore,
  type SkillStatus,
} from "../../cognition/CognitiveStore.js";
import type { AgentTool } from "../../core/types.js";

const goalStatuses: CognitiveGoalStatus[] = ["proposed", "active", "blocked", "succeeded", "failed", "cancelled"];
const priorities: CognitivePriority[] = ["low", "normal", "high", "critical"];
const skillStatuses: SkillStatus[] = ["candidate", "active", "deprecated"];

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected an array of strings");
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function boundedLimit(value: unknown, fallback: number, max = 500): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, Math.round(parsed))) : fallback;
}

export function createCognitionTools(engine: CognitiveEngine, store: CognitiveStore): AgentTool[] {
  return [
    {
      name: "cognition_get_status",
      description: "Inspect CherryAgent's persistent cognitive state, self-model, capability domains, active goals, learning statistics, and declared boundaries.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => engine.status(),
    },
    {
      name: "cognition_create_goal",
      description: "Create a persistent goal with observable success criteria and priority for later metacognitive deliberation and execution.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string" },
          successCriteria: { type: "array", items: { type: "string" } },
          priority: { type: "string", enum: priorities },
          parentGoalId: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["objective"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const priority = typeof args.priority === "string" && priorities.includes(args.priority as CognitivePriority)
          ? args.priority as CognitivePriority
          : undefined;
        const successCriteria = strings(args.successCriteria);
        const parentGoalId = optionalString(args, "parentGoalId");
        const confidence = typeof args.confidence === "number" ? args.confidence : undefined;
        return store.createGoal({
          objective: requiredString(args, "objective"),
          ...(successCriteria ? { successCriteria } : {}),
          ...(priority ? { priority } : {}),
          ...(parentGoalId ? { parentGoalId } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
        });
      },
    },
    {
      name: "cognition_list_goals",
      description: "List persistent proposed, active, blocked, succeeded, failed, or cancelled cognitive goals.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: goalStatuses },
          limit: { type: "number", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const status = typeof args.status === "string" && goalStatuses.includes(args.status as CognitiveGoalStatus)
          ? args.status as CognitiveGoalStatus
          : undefined;
        return store.listGoals(status, boundedLimit(args.limit, 100));
      },
    },
    {
      name: "cognition_deliberate",
      description: "Run Cherry's metacognitive planning layer: recall relevant experience and beliefs, expose assumptions and unknowns, produce a falsifiable plan, verification requirements, stop conditions, and calibrated confidence.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string" },
          objective: { type: "string" },
          successCriteria: { type: "array", items: { type: "string" } },
          priority: { type: "string", enum: priorities },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const goalId = optionalString(args, "goalId");
        const objective = optionalString(args, "objective");
        if (!goalId && !objective) throw new Error("goalId or objective is required");
        const successCriteria = strings(args.successCriteria);
        const priority = typeof args.priority === "string" && priorities.includes(args.priority as CognitivePriority)
          ? args.priority as CognitivePriority
          : undefined;
        return engine.deliberate({
          ...(goalId ? { goalId } : {}),
          ...(objective ? { objective } : {}),
          ...(successCriteria ? { successCriteria } : {}),
          ...(priority ? { priority } : {}),
        });
      },
    },
    {
      name: "cognition_execute_goal",
      description: "Execute a deliberated persistent goal through the multi-agent orchestrator, preserve nested tool approvals, verify the result, record an episode, update evidence-backed beliefs, and promote reusable skills only after verified success.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { goalId: { type: "string" } },
        required: ["goalId"],
        additionalProperties: false,
      },
      execute: async (args, context) => engine.executeGoal(requiredString(args, "goalId"), context),
    },
    {
      name: "cognition_global_workspace",
      description: "Build a bounded Global Workspace snapshot of active and blocked goals, recent episodes, active skills, contested beliefs, evaluations, and Cherry's current self-model.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => engine.buildGlobalWorkspace(),
    },
    {
      name: "cognition_recall_experience",
      description: "Retrieve relevant episodic memories by lexical-semantic token overlap, including outcomes, evidence, lessons, surprises, utility, confidence, and relevance score.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) => store.recallEpisodes(requiredString(args, "query"), boundedLimit(args.limit, 10, 100)),
    },
    {
      name: "cognition_list_skills",
      description: "List candidate, active, or deprecated reusable skills with procedures, verification steps, failure modes, confidence, and observed success/failure counts.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: skillStatuses },
          limit: { type: "number", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const status = typeof args.status === "string" && skillStatuses.includes(args.status as SkillStatus)
          ? args.status as SkillStatus
          : undefined;
        return store.listSkills(status, boundedLimit(args.limit, 100));
      },
    },
    {
      name: "cognition_query_beliefs",
      description: "Query Cherry's evidence-backed, confidence-scored world beliefs. Contradictory values are retained and marked contested instead of silently overwritten.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) => store.queryBeliefs(requiredString(args, "query"), boundedLimit(args.limit, 20, 100)),
    },
    {
      name: "cognition_record_belief",
      description: "Record an evidence-backed proposition in the fallible world model. Conflicting values become contested beliefs and reduce prior confidence.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string" },
          predicate: { type: "string" },
          value: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", items: { type: "string" } },
          expiresAt: { type: "string" },
        },
        required: ["subject", "predicate", "value"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const evidence = strings(args.evidence);
        const expiresAt = optionalString(args, "expiresAt");
        return store.upsertBelief({
          subject: requiredString(args, "subject"),
          predicate: requiredString(args, "predicate"),
          value: requiredString(args, "value"),
          ...(typeof args.confidence === "number" ? { confidence: args.confidence } : {}),
          ...(evidence ? { evidence } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        });
      },
    },
    {
      name: "cognition_self_model",
      description: "Inspect Cherry's explicit self-model: available capability domains, tool risks, cognitive maturity estimates, identity claims, and hard limitations.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => engine.selfModel(),
    },
    {
      name: "cognition_run_capability_audit",
      description: "Run and persist a deterministic engineering maturity audit across planning, action, memory, learning, metacognition, and autonomy readiness. This is not an AGI or consciousness test.",
      risk: "write",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => engine.runCapabilityAudit(),
    },
  ];
}
