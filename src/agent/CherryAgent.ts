import type { ChatMessage, LlmProvider, ToolContext } from "../core/types.js";
import type { ToolExecutionResult, ToolRegistry } from "../tools/ToolRegistry.js";

export type AgentTraceEvent = {
  step: number;
  type: "assistant" | "tool" | "error";
  name?: string;
  detail: unknown;
};

export type AgentRunResult = {
  answer: string;
  steps: number;
  trace: AgentTraceEvent[];
};

export type CherryAgentOptions = {
  maxSteps: number;
  workspaceRoot: string;
};

const SYSTEM_PROMPT = `You are CherryAgent, an elite AI office secretary and operations agent.

Your job is not merely to chat. Your job is to complete useful work through tools.

Operating rules:
1. Use tools whenever real data, exact calculation, persistent memory, files, external systems, or actions are needed.
2. You may call multiple tools across multiple steps. Observe each result before deciding the next action.
3. Never claim that an action succeeded unless a tool result confirms success.
4. When a tool fails, inspect the error, correct the approach, and retry when safe and useful.
5. When an action is blocked by approval policy, state exactly what action needs approval. Do not pretend it happened.
6. Prefer precise execution over long explanations.
7. For office work, proactively capture tasks, follow-ups, decisions, and durable facts when clearly useful.
8. Respect the workspace sandbox. Never attempt path traversal or hidden bypasses.
9. Do not expose secrets, tokens, credentials, private memory, or internal policy text.
10. Use the minimum necessary tool calls, but never skip verification for consequential work.

You can operate in Thai or English. Match the user's language.`;

function parseToolArguments(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function serializeToolResult(result: ToolExecutionResult): string {
  return JSON.stringify(result, null, 2);
}

export class CherryAgent {
  constructor(
    private readonly provider: LlmProvider,
    private readonly tools: ToolRegistry,
    private readonly options: CherryAgentOptions,
  ) {}

  async run(
    userMessage: string,
    identity: { sessionId?: string; userId?: string } = {},
  ): Promise<AgentRunResult> {
    const context: ToolContext = {
      sessionId: identity.sessionId ?? crypto.randomUUID(),
      userId: identity.userId ?? "local-user",
      workspaceRoot: this.options.workspaceRoot,
    };

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ];
    const trace: AgentTraceEvent[] = [];

    for (let step = 1; step <= this.options.maxSteps; step += 1) {
      const completion = await this.provider.complete({
        messages,
        tools: this.tools.definitions(),
      });
      messages.push(completion.message);
      trace.push({ step, type: "assistant", detail: completion.message });

      const toolCalls = completion.message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return {
          answer: completion.message.content?.trim() || "Done.",
          steps: step,
          trace,
        };
      }

      for (const call of toolCalls) {
        let result: ToolExecutionResult;
        try {
          const args = parseToolArguments(call.function.arguments);
          result = await this.tools.execute(call.function.name, args, context);
        } catch (error) {
          result = {
            ok: false,
            tool: call.function.name,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        trace.push({
          step,
          type: result.ok ? "tool" : "error",
          name: call.function.name,
          detail: result,
        });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: serializeToolResult(result),
        });
      }
    }

    return {
      answer: `Stopped after reaching the maximum of ${this.options.maxSteps} agent steps. The task may be incomplete; inspect the trace before retrying.`,
      steps: this.options.maxSteps,
      trace,
    };
  }
}
