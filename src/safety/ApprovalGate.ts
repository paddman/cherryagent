import { randomUUID } from "node:crypto";
import type { AgentTool, RiskLevel, ToolContext } from "../core/types.js";

export type ApprovalDecision = {
  approved: boolean;
  reason?: string;
  approvalId?: string;
};

export type ApprovalHandler = (
  tool: AgentTool,
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<ApprovalDecision>;

export type ApprovalStatus = "pending" | "approved" | "denied" | "executing" | "executed" | "failed";

export type PendingApproval = {
  id: string;
  tool: string;
  risk: RiskLevel;
  args: Record<string, unknown>;
  context: ToolContext;
  createdAt: string;
  status: ApprovalStatus;
  resolvedAt?: string;
  result?: unknown;
};

export class ApprovalGate {
  readonly #approvals = new Map<string, PendingApproval>();

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

    const existing = this.findDuplicatePending(tool.name, args, context);
    const approval = existing ?? this.createPending(tool, args, context);

    return {
      approved: false,
      approvalId: approval.id,
      reason: `Approval required for ${tool.name} (${tool.risk}). Approval ID: ${approval.id}`,
    };
  }

  list(status?: ApprovalStatus): PendingApproval[] {
    return [...this.#approvals.values()]
      .filter((item) => !status || item.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => structuredClone(item));
  }

  get(id: string): PendingApproval | undefined {
    const item = this.#approvals.get(id);
    return item ? structuredClone(item) : undefined;
  }

  approve(id: string): PendingApproval {
    const item = this.requireApproval(id);
    if (item.status !== "pending") {
      throw new Error(`Approval ${id} cannot be approved from status '${item.status}'`);
    }
    item.status = "approved";
    item.resolvedAt = new Date().toISOString();
    return structuredClone(item);
  }

  deny(id: string): PendingApproval {
    const item = this.requireApproval(id);
    if (item.status !== "pending") {
      throw new Error(`Approval ${id} cannot be denied from status '${item.status}'`);
    }
    item.status = "denied";
    item.resolvedAt = new Date().toISOString();
    return structuredClone(item);
  }

  consumeApproved(id: string): PendingApproval {
    const item = this.requireApproval(id);
    if (item.status !== "approved") {
      throw new Error(`Approval ${id} is not approved; current status is '${item.status}'`);
    }
    item.status = "executing";
    return structuredClone(item);
  }

  markExecuted(id: string, result: { ok: boolean; [key: string]: unknown }): PendingApproval {
    const item = this.requireApproval(id);
    if (item.status !== "executing") {
      throw new Error(`Approval ${id} is not executing; current status is '${item.status}'`);
    }
    item.status = result.ok ? "executed" : "failed";
    item.result = structuredClone(result);
    item.resolvedAt = new Date().toISOString();
    return structuredClone(item);
  }

  private createPending(
    tool: AgentTool,
    args: Record<string, unknown>,
    context: ToolContext,
  ): PendingApproval {
    this.prune();
    const item: PendingApproval = {
      id: randomUUID(),
      tool: tool.name,
      risk: tool.risk,
      args: structuredClone(args),
      context: structuredClone(context),
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    this.#approvals.set(item.id, item);
    return item;
  }

  private findDuplicatePending(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): PendingApproval | undefined {
    const serializedArgs = JSON.stringify(args);
    return [...this.#approvals.values()].find(
      (item) =>
        item.status === "pending" &&
        item.tool === toolName &&
        item.context.sessionId === context.sessionId &&
        JSON.stringify(item.args) === serializedArgs,
    );
  }

  private requireApproval(id: string): PendingApproval {
    const item = this.#approvals.get(id);
    if (!item) throw new Error(`Unknown approval: ${id}`);
    return item;
  }

  private prune(): void {
    const maxEntries = 500;
    if (this.#approvals.size < maxEntries) return;
    const removable = [...this.#approvals.values()]
      .filter((item) => item.status !== "pending" && item.status !== "approved" && item.status !== "executing")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const item of removable.slice(0, Math.max(1, this.#approvals.size - maxEntries + 1))) {
      this.#approvals.delete(item.id);
    }
  }
}
