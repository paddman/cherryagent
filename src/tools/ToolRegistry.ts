import type { AgentTool, ToolContext, ToolDefinition } from "../core/types.js";
import type { ApprovalGate } from "../safety/ApprovalGate.js";

export type ToolExecutionResult = {
  ok: boolean;
  tool: string;
  output?: unknown;
  error?: string;
  blocked?: boolean;
  approvalId?: string;
};

export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool>();

  constructor(private readonly approvalGate: ApprovalGate) {}

  register(tool: AgentTool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  list(): AgentTool[] {
    return [...this.#tools.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { ok: false, tool: name, error: `Unknown tool: ${name}` };
    }

    const approval = await this.approvalGate.authorize(tool, args, context);
    if (!approval.approved) {
      return {
        ok: false,
        tool: name,
        blocked: true,
        ...(approval.approvalId ? { approvalId: approval.approvalId } : {}),
        error: approval.reason ?? `Tool ${name} requires approval`,
      };
    }

    return this.executeTool(tool, args, context);
  }

  async executeApproved(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { ok: false, tool: name, error: `Unknown tool: ${name}` };
    }
    return this.executeTool(tool, args, context);
  }

  private async executeTool(
    tool: AgentTool,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    try {
      const output = await tool.execute(args, context);
      return { ok: true, tool: tool.name, output };
    } catch (error) {
      return {
        ok: false,
        tool: tool.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
