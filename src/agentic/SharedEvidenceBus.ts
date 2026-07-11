import {
  AgenticStateStore,
  type AgentRole,
  type EvidenceKind,
  type EvidenceRecord,
} from "./AgenticStateStore.js";

export class SharedEvidenceBus {
  constructor(private readonly store: AgenticStateStore) {}

  publish(input: {
    runId: string;
    taskId?: string;
    agent: AgentRole;
    kind: EvidenceKind;
    claim: string;
    data?: unknown;
    sourceTool?: string;
    confidence?: number;
  }): Promise<EvidenceRecord> {
    return this.store.publishEvidence(input);
  }

  list(input: { runId?: string; taskId?: string; limit?: number } = {}): Promise<EvidenceRecord[]> {
    return this.store.listEvidence(input);
  }

  async summarize(runId: string, limit = 100): Promise<string> {
    const evidence = await this.list({ runId, limit });
    if (!evidence.length) return "No shared evidence has been published yet.";
    return evidence
      .map((item) => {
        const source = item.sourceTool ? ` via ${item.sourceTool}` : "";
        return `[${item.kind}] ${item.agent}${source}: ${item.claim} (confidence ${(item.confidence * 100).toFixed(0)}%)`;
      })
      .join("\n");
  }
}
