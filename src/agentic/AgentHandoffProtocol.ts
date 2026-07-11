import {
  AgenticStateStore,
  type AgentHandoff,
  type AgentRole,
  type HandoffStatus,
} from "./AgenticStateStore.js";

export class AgentHandoffProtocol {
  constructor(private readonly store: AgenticStateStore) {}

  create(input: {
    runId: string;
    taskId?: string;
    fromAgent: AgentRole;
    toAgent: AgentRole;
    objective: string;
    context?: string;
    evidenceIds?: string[];
    expectedOutput?: string;
  }): Promise<AgentHandoff> {
    return this.store.createHandoff(input);
  }

  accept(id: string): Promise<AgentHandoff> {
    return this.store.acceptHandoff(id);
  }

  complete(id: string, result: string, evidenceIds: string[] = []): Promise<AgentHandoff> {
    return this.store.finishHandoff(id, { status: "completed", result, evidenceIds });
  }

  block(id: string, error: string, evidenceIds: string[] = []): Promise<AgentHandoff> {
    return this.store.finishHandoff(id, { status: "blocked", error, evidenceIds });
  }

  fail(id: string, error: string, evidenceIds: string[] = []): Promise<AgentHandoff> {
    return this.store.finishHandoff(id, { status: "failed", error, evidenceIds });
  }

  reject(id: string, error: string): Promise<AgentHandoff> {
    return this.store.finishHandoff(id, { status: "rejected", error });
  }

  list(input: { runId?: string; status?: HandoffStatus; limit?: number } = {}): Promise<AgentHandoff[]> {
    return this.store.listHandoffs(input);
  }
}
