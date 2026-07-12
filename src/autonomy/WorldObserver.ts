import type { AgenticStateStore } from "../agentic/AgenticStateStore.js";
import type { ConversationStore } from "../conversation/ConversationStore.js";
import type { EngineerLoopEngine } from "../engineer/EngineerLoopEngine.js";
import type { PlannerStore } from "../planner/PlannerStore.js";
import type { ApprovalGate } from "../safety/ApprovalGate.js";
import type { AutonomyStore } from "./AutonomyStore.js";

export type WorldState = {
  generatedAt: string;
  userActivity: {
    lastConversationActivityAt?: string;
    minutesSinceConversationActivity?: number;
  };
  conversations: Array<{
    id: string;
    title: string;
    updatedAt: string;
    messageCount: number;
    lastMessage?: string;
  }>;
  planner: {
    stats: Awaited<ReturnType<PlannerStore["getDashboard"]>>["stats"];
    overdue: Array<{ id: string; title: string; priority: string; dueAt?: string; updatedAt: string }>;
    doing: Array<{ id: string; title: string; priority: string; updatedAt: string }>;
    waiting: Array<{ id: string; title: string; priority: string; updatedAt: string }>;
    unreadAlerts: Array<{ id: string; title: string; message: string; createdAt: string }>;
  };
  engineer: {
    stats: Awaited<ReturnType<EngineerLoopEngine["getDashboard"]>>["stats"];
    active: Array<{
      id: string;
      objective: string;
      status: string;
      phase: string;
      updatedAt: string;
      stopReason?: string;
    }>;
  };
  agentic: Awaited<ReturnType<AgenticStateStore["dashboard"]>>;
  approvals: Array<{
    id: string;
    tool: string;
    risk: string;
    createdAt: string;
  }>;
  pendingEvents: Awaited<ReturnType<AutonomyStore["context"]>>["pendingEvents"];
  openThoughts: Awaited<ReturnType<AutonomyStore["context"]>>["openThoughts"];
  recentDecisions: Awaited<ReturnType<AutonomyStore["context"]>>["recentDecisions"];
  connectors: unknown;
};

export class WorldObserver {
  constructor(private readonly dependencies: {
    conversation: ConversationStore;
    planner: PlannerStore;
    engineer: EngineerLoopEngine;
    agenticStore: AgenticStateStore;
    approvalGate: ApprovalGate;
    autonomyStore: AutonomyStore;
    connectors: () => unknown;
  }) {}

  async observe(now = new Date()): Promise<WorldState> {
    const [conversations, planner, engineer, agentic, autonomyContext] = await Promise.all([
      this.dependencies.conversation.list({ limit: 12 }),
      this.dependencies.planner.getDashboard(now),
      this.dependencies.engineer.getDashboard(),
      this.dependencies.agenticStore.dashboard(),
      this.dependencies.autonomyStore.context({ thoughtLimit: 20, decisionLimit: 12, eventLimit: 30 }),
    ]);

    const latestConversation = conversations.at(0);
    const latestAt = latestConversation?.updatedAt;
    const minutesSinceConversationActivity = latestAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(latestAt).getTime()) / 60_000))
      : undefined;

    return {
      generatedAt: now.toISOString(),
      userActivity: {
        ...(latestAt ? { lastConversationActivityAt: latestAt } : {}),
        ...(minutesSinceConversationActivity !== undefined ? { minutesSinceConversationActivity } : {}),
      },
      conversations: conversations.map((item) => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updatedAt,
        messageCount: item.messageCount,
        ...(item.lastMessage ? { lastMessage: item.lastMessage } : {}),
      })),
      planner: {
        stats: planner.stats,
        overdue: planner.overdue.slice(0, 12).map((item) => ({
          id: item.id,
          title: item.title,
          priority: item.priority,
          updatedAt: item.updatedAt,
          ...(item.dueAt ? { dueAt: item.dueAt } : {}),
        })),
        doing: planner.flow.doing.slice(0, 12).map((item) => ({
          id: item.id,
          title: item.title,
          priority: item.priority,
          updatedAt: item.updatedAt,
        })),
        waiting: planner.flow.waiting.slice(0, 12).map((item) => ({
          id: item.id,
          title: item.title,
          priority: item.priority,
          updatedAt: item.updatedAt,
        })),
        unreadAlerts: planner.alerts.slice(0, 20).map((item) => ({
          id: item.id,
          title: item.title,
          message: item.message,
          createdAt: item.createdAt,
        })),
      },
      engineer: {
        stats: engineer.stats,
        active: engineer.active.slice(0, 12).map((item) => ({
          id: item.id,
          objective: item.objective,
          status: item.status,
          phase: item.phase,
          updatedAt: item.updatedAt,
          ...(item.stopReason ? { stopReason: item.stopReason } : {}),
        })),
      },
      agentic,
      approvals: this.dependencies.approvalGate.list("pending").slice(0, 20).map((item) => ({
        id: item.id,
        tool: item.tool,
        risk: item.risk,
        createdAt: item.createdAt,
      })),
      pendingEvents: autonomyContext.pendingEvents,
      openThoughts: autonomyContext.openThoughts,
      recentDecisions: autonomyContext.recentDecisions,
      connectors: this.dependencies.connectors(),
    };
  }
}
