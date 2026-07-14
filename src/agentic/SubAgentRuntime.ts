import type { ChatMessage, LlmProvider, ToolContext, ToolDefinition } from "../core/types.js";
import type { ToolExecutionResult, ToolRegistry } from "../tools/ToolRegistry.js";
import { getAgentDirectory } from "./AgentDirectory.js";
import type { AgentRole } from "./AgenticStateStore.js";
import { SharedEvidenceBus } from "./SharedEvidenceBus.js";

export type SubAgentTraceEvent = {
  step: number;
  type: "assistant" | "tool" | "error";
  name?: string;
  detail: unknown;
};

export type SubAgentResult = {
  workerId: string;
  workerName: string;
  role: AgentRole;
  answer: string;
  steps: number;
  trace: SubAgentTraceEvent[];
  evidenceIds: string[];
  blocked: boolean;
  failed: boolean;
};

const ROLE_PREFIXES: Record<AgentRole, string[]> = {
  orchestrator: [],
  office: ["office_", "gmail_", "calendar_", "drive_", "planner_", "memory_", "system_", "files_"],
  planner: ["planner_", "office_", "calendar_", "gmail_", "system_", "memory_"],
  infra: ["proxmox_", "vsphere_", "engineer_", "system_", "files_", "db_"],
  market: ["market_", "trade_", "planner_", "system_"],
  research: ["market_", "drive_", "files_", "memory_", "system_"],
  database: ["db_", "engineer_", "files_", "system_"],
  engineer: ["engineer_", "proxmox_", "vsphere_", "db_", "files_", "system_", "market_"],
  critic: [],
  verifier: [],
  general: [],
};

const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  orchestrator: "decomposes goals and coordinates specialist agents",
  office: "handles office work, email, calendar, drive, notes, and follow-up",
  planner: "turns goals into plans, dependencies, schedules, reminders, and work queues",
  infra: "investigates and operates Proxmox, vSphere, VM, host, storage, and infrastructure systems",
  market: "handles crypto exchanges, stocks, market data, analysis, and approval-gated trading",
  research: "collects and synthesizes news, financials, market research, files, and evidence",
  database: "inspects and operates PostgreSQL, MySQL, SQLite, and Redis under strict risk controls",
  engineer: "solves technical problems through evidence, testing, verification, and reusable runbooks",
  critic: "searches for contradictions, missing evidence, uncompleted requirements, and hidden risks",
  verifier: "checks whether final claims are supported by observable evidence",
  general: "handles cross-domain tasks that do not fit one specialist",
};

function parseToolArguments(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}

function compact(value: unknown, maxChars = 50_000): unknown {
  try {
    const json = JSON.stringify(value);
    if (json.length <= maxChars) return value;
    return `${json.slice(0, maxChars)}…[truncated]`;
  } catch {
    return String(value).slice(0, maxChars);
  }
}

function evidenceClaim(workerName: string, result: ToolExecutionResult): string {
  if (result.ok) return `${workerName}: ${result.tool} completed and returned observable output.`;
  if (result.blocked) return `${workerName}: ${result.tool} was blocked pending approval or policy clearance.`;
  return `${workerName}: ${result.tool} failed: ${result.error ?? "unknown error"}`;
}

function roleAllowsTool(role: AgentRole, name: string): boolean {
  if (name.startsWith("orchestrator_") || name.startsWith("agent_")) return false;
  if (role === "general") return true;
  return ROLE_PREFIXES[role].some((prefix) => name.startsWith(prefix));
}

export class SubAgentRuntime {
  constructor(
    private readonly provider: LlmProvider,
    private readonly tools: ToolRegistry,
    private readonly evidence: SharedEvidenceBus,
    private readonly maxSteps: number,
  ) {}

  async run(input: {
    runId: string;
    taskId: string;
    role: AgentRole;
    objective: string;
    sharedEvidence: string;
    context: ToolContext;
  }): Promise<SubAgentResult> {
    const role = input.role;
    const worker = await getAgentDirectory().selectForRole(role);
    const allowedTools = this.tools.list().filter((tool) => roleAllowsTool(role, tool.name));
    const allowedNames = new Set(allowedTools.map((tool) => tool.name));
    const definitions: ToolDefinition[] = allowedTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    const system = `You are ${worker.name}, one of Cherry's specialist sub-agents.
Worker ID: ${worker.id}
Role: ${role}
Mission: ${worker.mission}
Role specialty: ${ROLE_DESCRIPTIONS[role]}.
${worker.instructions ? `Additional worker instructions: ${worker.instructions}\n` : ""}Complete the delegated objective through tools and observable evidence.
Rules:
- You work for Cherry Orchestrator and own the delegated objective until completion, block, or verified failure.
- Use only the tools provided to you.
- Read each tool result before choosing the next step.
- Never claim an action succeeded without supporting tool evidence.
- When a tool is blocked by approval, state the exact blocker and do not pretend execution occurred.
- When errors occur, inspect them and adapt only when safe.
- Keep the final answer concise and operational: outcome, evidence, blockers, and next action.
- Do not expose hidden chain-of-thought.`;

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      {
        role: "user",
        content: `Delegated objective:\n${input.objective}\n\nShared evidence from the run:\n${input.sharedEvidence}`,
      },
    ];

    const trace: SubAgentTraceEvent[] = [];
    const evidenceIds: string[] = [];
    let blocked = false;
    let hadFailure = false;

    for (let step = 1; step <= Math.max(1, this.maxSteps); step += 1) {
      const completion = await this.provider.complete({ messages, tools: definitions });
      messages.push(completion.message);
      trace.push({ step, type: "assistant", detail: completion.message });
      const calls = completion.message.tool_calls ?? [];

      if (!calls.length) {
        return {
          workerId: worker.id,
          workerName: worker.name,
          role,
          answer: `[${worker.name} · ${role}] ${completion.message.content?.trim() || "Task completed without a textual result."}`,
          steps: step,
          trace,
          evidenceIds,
          blocked,
          failed: hadFailure && !evidenceIds.length,
        };
      }

      for (const call of calls) {
        let result: ToolExecutionResult;
        try {
          if (!allowedNames.has(call.function.name)) {
            result = { ok: false, tool: call.function.name, error: `Tool is not allowed for ${worker.name} (${role}) sub-agent` };
          } else {
            const args = parseToolArguments(call.function.arguments);
            result = await this.tools.execute(call.function.name, args, input.context);
          }
        } catch (error) {
          result = {
            ok: false,
            tool: call.function.name,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        blocked ||= Boolean(result.blocked);
        hadFailure ||= !result.ok && !result.blocked;
        trace.push({
          step,
          type: result.ok ? "tool" : "error",
          name: call.function.name,
          detail: result,
        });

        const record = await this.evidence.publish({
          runId: input.runId,
          taskId: input.taskId,
          agent: role,
          kind: result.ok ? "tool_result" : result.blocked ? "observation" : "error",
          claim: evidenceClaim(worker.name, result),
          data: compact({ workerId: worker.id, workerName: worker.name, output: result.output ?? result.error }),
          sourceTool: result.tool,
          confidence: result.ok ? 1 : 0.95,
        });
        evidenceIds.push(record.id);

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result),
        });
      }
    }

    return {
      workerId: worker.id,
      workerName: worker.name,
      role,
      answer: `[${worker.name} · ${role}] Stopped after ${this.maxSteps} sub-agent steps before a final answer was produced.`,
      steps: this.maxSteps,
      trace,
      evidenceIds,
      blocked,
      failed: true,
    };
  }
}
