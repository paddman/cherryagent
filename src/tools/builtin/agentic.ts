import type { AgentTool } from "../../core/types.js";
import { getAgentDirectory } from "../../agentic/AgentDirectory.js";
import {
  AgenticStateStore,
  type AgentRole,
  type EvidenceKind,
  type HandoffStatus,
} from "../../agentic/AgenticStateStore.js";
import { AgentHandoffProtocol } from "../../agentic/AgentHandoffProtocol.js";
import { AgentOrchestrator } from "../../agentic/AgentOrchestrator.js";
import { SharedEvidenceBus } from "../../agentic/SharedEvidenceBus.js";

const roles: AgentRole[] = [
  "orchestrator", "office", "planner", "infra", "market", "research", "database", "engineer", "critic", "verifier", "general",
];
const workerRoles = roles.filter((role) => role !== "orchestrator");
const handoffStatuses: HandoffStatus[] = ["pending", "accepted", "completed", "blocked", "failed", "rejected"];
const evidenceKinds: EvidenceKind[] = ["observation", "tool_result", "fact", "decision", "error", "verification"];

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected integer between ${min} and ${max}`);
  return parsed;
}

function parseRole(value: unknown): AgentRole {
  if (typeof value !== "string" || !roles.includes(value as AgentRole)) throw new Error(`role must be one of: ${roles.join(", ")}`);
  return value as AgentRole;
}

function parseWorkerRole(value: unknown): AgentRole {
  const role = parseRole(value);
  if (role === "orchestrator") throw new Error("Cherry is the orchestrator; workers must use a specialist role");
  return role;
}

function parseHandoffStatus(value: unknown): HandoffStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !handoffStatuses.includes(value as HandoffStatus)) throw new Error(`status must be one of: ${handoffStatuses.join(", ")}`);
  return value as HandoffStatus;
}

function parseEvidenceKind(value: unknown): EvidenceKind {
  if (typeof value !== "string" || !evidenceKinds.includes(value as EvidenceKind)) throw new Error(`kind must be one of: ${evidenceKinds.join(", ")}`);
  return value as EvidenceKind;
}

export function createAgenticTools(input: {
  orchestrator: AgentOrchestrator;
  store: AgenticStateStore;
  evidence: SharedEvidenceBus;
  handoffs: AgentHandoffProtocol;
}): AgentTool[] {
  const directory = getAgentDirectory();
  return [
    {
      name: "agent_list_workers",
      description: "List Cherry's named sub-agent roster, including the 10 built-in workers and any custom workers added later.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: workerRoles },
          enabledOnly: { type: "boolean" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const role = args.role === undefined ? undefined : parseWorkerRole(args.role);
        return directory.list({
          ...(role ? { role } : {}),
          enabledOnly: args.enabledOnly === true,
        });
      },
    },
    {
      name: "agent_get_worker",
      description: "Get one named Cherry sub-agent profile by worker id.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { workerId: { type: "string" } },
        required: ["workerId"],
        additionalProperties: false,
      },
      execute: async (args) => directory.get(requiredString(args, "workerId")),
    },
    {
      name: "agent_add_worker",
      description: "Add a persistent custom named sub-agent to Cherry's worker roster. The worker inherits tool access from its specialist role and can be selected by the orchestration runtime.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          role: { type: "string", enum: workerRoles },
          mission: { type: "string" },
          instructions: { type: "string" },
        },
        required: ["name", "role", "mission"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const id = optionalString(args, "id");
        const instructions = optionalString(args, "instructions");
        return directory.add({
          name: requiredString(args, "name"),
          role: parseWorkerRole(args.role),
          mission: requiredString(args, "mission"),
          ...(id ? { id } : {}),
          ...(instructions ? { instructions } : {}),
        });
      },
    },
    {
      name: "agent_set_worker_enabled",
      description: "Enable or disable a custom named sub-agent. Built-in workers remain protected as the default operational roster.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          workerId: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["workerId", "enabled"],
        additionalProperties: false,
      },
      execute: async (args) => {
        if (typeof args.enabled !== "boolean") throw new Error("enabled must be a boolean");
        return directory.setEnabled(requiredString(args, "workerId"), args.enabled);
      },
    },
    {
      name: "orchestrator_run_goal",
      description: "Give Cherry Orchestrator a complex multi-step or multi-domain goal. It decomposes the goal into a dependency graph, delegates to named specialist sub-agents, records agent-to-agent handoffs, shares evidence, runs critic repair rounds, synthesizes, and verifies the final answer.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string" },
          preferredRoles: { type: "array", items: { type: "string", enum: roles } },
        },
        required: ["goal"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const preferred = stringArray(args.preferredRoles, "preferredRoles")?.map(parseRole);
        return input.orchestrator.runGoal({
          goal: requiredString(args, "goal"),
          ...(preferred?.length ? { preferredRoles: preferred } : {}),
        }, context);
      },
    },
    {
      name: "orchestrator_get_run",
      description: "Get one persistent agentic run with goal, rounds, dependency tasks, named sub-agent results, critique, verification, and final synthesis.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
        additionalProperties: false,
      },
      execute: async (args) => input.orchestrator.getRun(requiredString(args, "runId")),
    },
    {
      name: "orchestrator_list_runs",
      description: "List recent persistent multi-agent orchestration runs.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", minimum: 1, maximum: 500 } },
        additionalProperties: false,
      },
      execute: async (args) => input.orchestrator.listRuns(optionalInteger(args.limit, 50, 1, 500)),
    },
    {
      name: "orchestrator_get_dashboard",
      description: "Get aggregate counts for agentic runs, handoffs, shared evidence, and active delegated tasks.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => input.orchestrator.dashboard(),
    },
    {
      name: "agent_create_handoff",
      description: "Create a persistent agent-to-agent handoff for an existing orchestration run, including objective, context, evidence references, and expected output.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
          taskId: { type: "string" },
          fromAgent: { type: "string", enum: roles },
          toAgent: { type: "string", enum: roles },
          objective: { type: "string" },
          context: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          expectedOutput: { type: "string" },
        },
        required: ["runId", "fromAgent", "toAgent", "objective"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const evidenceIds = stringArray(args.evidenceIds, "evidenceIds");
        const taskId = optionalString(args, "taskId");
        const context = optionalString(args, "context");
        const expectedOutput = optionalString(args, "expectedOutput");
        return input.handoffs.create({
          runId: requiredString(args, "runId"),
          fromAgent: parseRole(args.fromAgent),
          toAgent: parseRole(args.toAgent),
          objective: requiredString(args, "objective"),
          ...(taskId ? { taskId } : {}),
          ...(context ? { context } : {}),
          ...(evidenceIds ? { evidenceIds } : {}),
          ...(expectedOutput ? { expectedOutput } : {}),
        });
      },
    },
    {
      name: "agent_accept_handoff",
      description: "Mark a pending agent-to-agent handoff as accepted by the receiving agent.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { handoffId: { type: "string" } },
        required: ["handoffId"],
        additionalProperties: false,
      },
      execute: async (args) => input.handoffs.accept(requiredString(args, "handoffId")),
    },
    {
      name: "agent_finish_handoff",
      description: "Complete, block, fail, or reject an agent-to-agent handoff and attach result/error plus shared evidence IDs.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          handoffId: { type: "string" },
          status: { type: "string", enum: ["completed", "blocked", "failed", "rejected"] },
          result: { type: "string" },
          error: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
        required: ["handoffId", "status"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const id = requiredString(args, "handoffId");
        const status = requiredString(args, "status");
        const evidenceIds = stringArray(args.evidenceIds, "evidenceIds") ?? [];
        if (status === "completed") return input.handoffs.complete(id, optionalString(args, "result") ?? "Completed", evidenceIds);
        if (status === "blocked") return input.handoffs.block(id, optionalString(args, "error") ?? "Blocked", evidenceIds);
        if (status === "failed") return input.handoffs.fail(id, optionalString(args, "error") ?? "Failed", evidenceIds);
        if (status === "rejected") return input.handoffs.reject(id, optionalString(args, "error") ?? "Rejected");
        throw new Error("status must be completed, blocked, failed, or rejected");
      },
    },
    {
      name: "agent_list_handoffs",
      description: "List agent-to-agent handoffs, optionally filtered by run and status.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
          status: { type: "string", enum: handoffStatuses },
          limit: { type: "number", minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const runId = optionalString(args, "runId");
        const status = parseHandoffStatus(args.status);
        return input.handoffs.list({
          ...(runId ? { runId } : {}),
          ...(status ? { status } : {}),
          limit: optionalInteger(args.limit, 100, 1, 1000),
        });
      },
    },
    {
      name: "agent_publish_evidence",
      description: "Publish a structured claim or observation to the Shared Evidence Bus for other agents in an existing run.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
          taskId: { type: "string" },
          agent: { type: "string", enum: roles },
          kind: { type: "string", enum: evidenceKinds },
          claim: { type: "string" },
          data: {},
          sourceTool: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["runId", "agent", "kind", "claim"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const taskId = optionalString(args, "taskId");
        const sourceTool = optionalString(args, "sourceTool");
        return input.evidence.publish({
          runId: requiredString(args, "runId"),
          agent: parseRole(args.agent),
          kind: parseEvidenceKind(args.kind),
          claim: requiredString(args, "claim"),
          ...(taskId ? { taskId } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
          ...(sourceTool ? { sourceTool } : {}),
          ...(typeof args.confidence === "number" ? { confidence: args.confidence } : {}),
        });
      },
    },
    {
      name: "agent_get_evidence",
      description: "Read Shared Evidence Bus records, optionally scoped by orchestration run or delegated task.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string" },
          taskId: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 2000 },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const runId = optionalString(args, "runId");
        const taskId = optionalString(args, "taskId");
        return input.evidence.list({
          ...(runId ? { runId } : {}),
          ...(taskId ? { taskId } : {}),
          limit: optionalInteger(args.limit, 200, 1, 2000),
        });
      },
    },
  ];
}
