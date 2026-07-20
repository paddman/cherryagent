import type { GoogleWorkspaceClient } from "../connectors/google/GoogleWorkspaceClient.js";
import type { PlannerStore, PlanItem } from "../planner/PlannerStore.js";
import { OfficeInboxStore, type OfficeInboxItem, type OfficeInboxStatus } from "./OfficeInboxStore.js";

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

export class OfficeInboxService {
  constructor(
    private readonly store: OfficeInboxStore,
    private readonly google: GoogleWorkspaceClient,
    private readonly planner: PlannerStore,
  ) {}

  async list(tenantId: string, status?: OfficeInboxStatus): Promise<OfficeInboxItem[]> {
    return this.store.list(tenantId, status);
  }

  async sync(input: { tenantId: string; query?: string; maxResults?: number }): Promise<{ count: number; items: OfficeInboxItem[] }> {
    const result = await this.google.gmailSearch(input.query ?? "in:inbox", input.maxResults ?? 25) as {
      messages?: Array<Record<string, unknown>>;
    };
    const now = new Date().toISOString();
    const items: OfficeInboxItem[] = (result.messages ?? []).map((message) => ({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      source: "gmail" as const,
      externalId: text(message.id),
      ...(text(message.threadId) ? { threadId: text(message.threadId) } : {}),
      subject: text(message.subject) || "(no subject)",
      from: text(message.from),
      ...(text(message.to) ? { to: text(message.to) } : {}),
      ...(text(message.date) ? { date: text(message.date) } : {}),
      snippet: text(message.snippet),
      status: "new" as const,
      createdAt: now,
      updatedAt: now,
    })).filter((item) => item.externalId);
    return { count: items.length, items: await this.store.upsertMany(items) };
  }

  async triage(input: {
    tenantId: string;
    inboxId: string;
    title?: string;
    description?: string;
    dueAt?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    tags?: string[];
  }): Promise<{ inbox: OfficeInboxItem; item: PlanItem }> {
    const inbox = (await this.store.list(input.tenantId)).find((item) => item.id === input.inboxId);
    if (!inbox) throw new Error(`Office inbox item not found: ${input.inboxId}`);
    const item = await this.planner.createItem({
      tenantId: input.tenantId,
      title: input.title?.trim() || inbox.subject,
      description: input.description?.trim() || `${inbox.from}\n${inbox.snippet}`,
      status: "inbox",
      priority: input.priority ?? "normal",
      tags: [...(input.tags ?? []), "office-inbox", `source:${inbox.source}`],
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
    });
    return { inbox: await this.store.update(input.inboxId, input.tenantId, { status: "triaged", planItemId: item.id }), item };
  }

  async ignore(id: string, tenantId: string): Promise<OfficeInboxItem> {
    return this.store.update(id, tenantId, { status: "ignored" });
  }
}
