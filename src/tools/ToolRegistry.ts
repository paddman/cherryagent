import type { AgentTool, ToolContext, ToolDefinition } from "../core/types.js";
import type { ApprovalGate } from "../safety/ApprovalGate.js";
import { getAuditLogger, AuditLogger } from "../audit/AuditLogger.js";

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
  readonly #audit: AuditLogger;

  constructor(
    private readonly approvalGate: ApprovalGate,
    audit?: AuditLogger,
  ) {
    // ถ้าไม่ส่ง audit มา ใช้ singleton (default — ทำให้ backward-compatible)
    this.#audit = audit ?? getAuditLogger();
  }

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
      this.#audit.log({
        action: "tool_call",
        userId: context.userId,
        sessionId: context.sessionId,
        tool: name,
        args,
        resultStatus: "error",
        error: `Unknown tool: ${name}`,
      });
      return { ok: false, tool: name, error: `Unknown tool: ${name}` };
    }

    const approval = await this.approvalGate.authorize(tool, args, context);
    if (!approval.approved) {
      // audit: tool ถูก block — รอ approval หรือ deny
      this.#audit.log({
        action: "tool_pending",
        userId: context.userId,
        sessionId: context.sessionId,
        tool: name,
        risk: tool.risk,
        args,
        resultStatus: approval.approvalId ? "pending" : "denied",
        metadata: approval.approvalId ? { approvalId: approval.approvalId } : { reason: approval.reason },
      });
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
      this.#audit.log({
        action: "tool_call",
        userId: context.userId,
        sessionId: context.sessionId,
        tool: name,
        args,
        resultStatus: "error",
        error: `Unknown tool: ${name}`,
      });
      return { ok: false, tool: name, error: `Unknown tool: ${name}` };
    }

    // audit: tool ถูก approve แล้ว (จาก human ผ่าน /approvals/:id/approve)
    this.#audit.log({
      action: "tool_approve",
      userId: context.userId,
      sessionId: context.sessionId,
      tool: name,
      risk: tool.risk,
      args,
      resultStatus: "ok",
    });
    return this.executeTool(tool, args, context);
  }

  private async executeTool(
    tool: AgentTool,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const output = await tool.execute(args, context);
      this.#audit.log({
        action: "tool_call",
        userId: context.userId,
        sessionId: context.sessionId,
        tool: tool.name,
        risk: tool.risk,
        args,
        resultStatus: "ok",
        durationMs: Date.now() - start,
      });
      return { ok: true, tool: tool.name, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#audit.log({
        action: "tool_call",
        userId: context.userId,
        sessionId: context.sessionId,
        tool: tool.name,
        risk: tool.risk,
        args,
        resultStatus: "error",
        durationMs: Date.now() - start,
        error: message,
      });
      return { ok: false, tool: tool.name, error: message };
    }
  }
}
