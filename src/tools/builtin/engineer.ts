import type { AgentTool } from "../../core/types.js";
import type {
  EngineerLoopEngine,
  EngineerLoopStatus,
  EngineerPhase,
} from "../../engineer/EngineerLoopEngine.js";

const phases: EngineerPhase[] = ["plan", "execute", "observe", "diagnose", "patch", "test", "verify", "learn"];
const statuses: EngineerLoopStatus[] = ["running", "blocked", "succeeded", "failed", "aborted"];

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
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parsePhase(value: unknown): EngineerPhase {
  if (typeof value !== "string" || !phases.includes(value as EngineerPhase)) {
    throw new Error(`phase must be one of: ${phases.join(", ")}`);
  }
  return value as EngineerPhase;
}

function parseOptionalPhase(value: unknown): EngineerPhase | undefined {
  return value === undefined ? undefined : parsePhase(value);
}

function parseOptionalStatus(value: unknown): EngineerLoopStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !statuses.includes(value as EngineerLoopStatus)) {
    throw new Error(`status must be one of: ${statuses.join(", ")}`);
  }
  return value as EngineerLoopStatus;
}

export function createEngineerTools(engine: EngineerLoopEngine): AgentTool[] {
  return [
    {
      name: "engineer_start_loop",
      description: "Start a persistent engineering loop for debugging, incidents, code changes, infrastructure work, self-repair, or any technical task that needs plan-execute-observe-diagnose-patch-test-verify-learn discipline.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "Concrete engineering objective" },
          successCriteria: { type: "array", items: { type: "string" }, description: "Observable conditions that must all be true before success" },
          maxIterations: { type: "number", minimum: 1, maximum: 25 },
          planItemId: { type: "string", description: "Optional linked planner item ID" },
          hypothesis: { type: "string", description: "Optional initial technical hypothesis" },
        },
        required: ["objective", "successCriteria"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const successCriteria = stringArray(args.successCriteria, "successCriteria") ?? [];
        return engine.startLoop({
          objective: requiredString(args, "objective"),
          successCriteria,
          tenantId: context.tenantId,
          ...(typeof args.maxIterations === "number" ? { maxIterations: args.maxIterations } : {}),
          ...(optionalString(args, "planItemId") ? { planItemId: optionalString(args, "planItemId") } : {}),
          ...(optionalString(args, "hypothesis") ? { hypothesis: optionalString(args, "hypothesis") } : {}),
        });
      },
    },
    {
      name: "engineer_get_loop",
      description: "Get one engineering loop with current phase, retry budget, success criteria, evidence, and full execution trace.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (args, context) => engine.getLoop(requiredString(args, "id"), context.tenantId),
    },
    {
      name: "engineer_list_loops",
      description: "List engineering loops, optionally filtered by running, blocked, succeeded, failed, or aborted status.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { status: { type: "string", enum: statuses } },
        additionalProperties: false,
      },
      execute: async (args, context) => engine.listLoops(parseOptionalStatus(args.status), context.tenantId),
    },
    {
      name: "engineer_record_phase",
      description: "Record the current engineering phase with evidence and optionally advance through an allowed transition. The phase must match the loop's expected phase.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          loopId: { type: "string" },
          phase: { type: "string", enum: phases },
          summary: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          tool: { type: "string", description: "Tool or command used in this phase" },
          error: { type: "string", description: "Observed error, when applicable" },
          nextPhase: { type: "string", enum: phases },
        },
        required: ["loopId", "phase", "summary"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const nextPhase = parseOptionalPhase(args.nextPhase);
        const evidence = stringArray(args.evidence, "evidence");
        return engine.recordPhase({
          loopId: requiredString(args, "loopId"),
          tenantId: context.tenantId,
          phase: parsePhase(args.phase),
          summary: requiredString(args, "summary"),
          ...(evidence ? { evidence } : {}),
          ...(optionalString(args, "tool") ? { tool: optionalString(args, "tool") } : {}),
          ...(optionalString(args, "error") ? { error: optionalString(args, "error") } : {}),
          ...(nextPhase ? { nextPhase } : {}),
        });
      },
    },
    {
      name: "engineer_next_iteration",
      description: "Start another bounded engineering iteration after a failed test or verification, preserving diagnosis and consuming retry budget.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          loopId: { type: "string" },
          diagnosis: { type: "string" },
          nextAction: { type: "string" },
        },
        required: ["loopId", "diagnosis", "nextAction"],
        additionalProperties: false,
      },
      execute: async (args, context) => engine.nextIteration({
        loopId: requiredString(args, "loopId"),
        diagnosis: requiredString(args, "diagnosis"),
        nextAction: requiredString(args, "nextAction"),
        tenantId: context.tenantId,
      }),
    },
    {
      name: "engineer_block_loop",
      description: "Pause an engineering loop when blocked by approval, missing access, external dependency, maintenance window, or required human decision.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { loopId: { type: "string" }, reason: { type: "string" } },
        required: ["loopId", "reason"],
        additionalProperties: false,
      },
      execute: async (args, context) => engine.blockLoop(requiredString(args, "loopId"), requiredString(args, "reason"), context.tenantId),
    },
    {
      name: "engineer_resume_loop",
      description: "Resume a blocked engineering loop from its exact previous phase.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { loopId: { type: "string" }, note: { type: "string" } },
        required: ["loopId"],
        additionalProperties: false,
      },
      execute: async (args, context) => engine.resumeLoop(
        requiredString(args, "loopId"),
        optionalString(args, "note"),
        context.tenantId,
      ),
    },
    {
      name: "engineer_complete_loop",
      description: "Complete a verified engineer loop only after the learn phase. Requires verification evidence and automatically creates a reusable runbook with root cause, fix, diagnostics, verification, rollback, and prevention.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          loopId: { type: "string" },
          outcome: { type: "string" },
          rootCause: { type: "string" },
          fix: { type: "string" },
          rollback: { type: "string" },
          prevention: { type: "array", items: { type: "string" } },
          runbookTitle: { type: "string" },
        },
        required: ["loopId", "outcome", "rootCause", "fix"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const prevention = stringArray(args.prevention, "prevention");
        return engine.completeLoop({
          loopId: requiredString(args, "loopId"),
          tenantId: context.tenantId,
          outcome: requiredString(args, "outcome"),
          rootCause: requiredString(args, "rootCause"),
          fix: requiredString(args, "fix"),
          ...(optionalString(args, "rollback") ? { rollback: optionalString(args, "rollback") } : {}),
          ...(prevention ? { prevention } : {}),
          ...(optionalString(args, "runbookTitle") ? { runbookTitle: optionalString(args, "runbookTitle") } : {}),
        });
      },
    },
    {
      name: "engineer_fail_loop",
      description: "Stop an engineering loop as failed when retry budget, safety, or technical constraints prevent verified success.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { loopId: { type: "string" }, reason: { type: "string" } },
        required: ["loopId", "reason"],
        additionalProperties: false,
      },
      execute: async (args, context) => engine.failLoop(requiredString(args, "loopId"), requiredString(args, "reason"), context.tenantId),
    },
    {
      name: "engineer_abort_loop",
      description: "Abort an engineering loop deliberately, recording why it was stopped.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { loopId: { type: "string" }, reason: { type: "string" } },
        required: ["loopId", "reason"],
        additionalProperties: false,
      },
      execute: async (args, context) => engine.abortLoop(requiredString(args, "loopId"), requiredString(args, "reason"), context.tenantId),
    },
    {
      name: "engineer_get_dashboard",
      description: "Get engineering loop statistics, active loops, recent outcomes, and generated runbooks.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, context) => engine.getDashboard(context.tenantId),
    },
    {
      name: "engineer_list_runbooks",
      description: "List reusable runbooks learned from successfully verified engineering loops.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", minimum: 1, maximum: 500 } },
        additionalProperties: false,
      },
      execute: async (args, context) => engine.listRunbooks(typeof args.limit === "number" ? args.limit : 50, context.tenantId),
    },
  ];
}
