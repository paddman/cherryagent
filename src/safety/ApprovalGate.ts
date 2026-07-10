import type { AgentTool, RiskLevel, ToolContext } from "../core/types.js";

export type ApprovalDecision = {
  approved: boolean;
  reason?: string;
};

export type ApprovalHandler = (
  tool: AgentTool,
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<ApprovalDecision>;

export class ApprovalGate {
  constructor(
    private readonly autoApprove: ReadonlySet<RiskLevel>,
    private readonly handler?: ApprovalHandler,
  ) {}

  async authorize(
    tool: AgentTool,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ApprovalDecision> {
    if (this.autoApprove.has(tool.risk)) return { approved: true };

    if (this.handler) {
      return this.handler(tool, args, context);
    }

    return {
      approved: false,
      reason: `Blocked by approval policy: ${tool.name} has risk level '${tool.risk}'`,
    };
  }
}
