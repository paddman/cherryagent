import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentTraceEvent, CherryAgent } from "../agent/CherryAgent.js";
import type { ChatMessage } from "../core/types.js";
import type { EngineerLoopEngine } from "../engineer/EngineerLoopEngine.js";
import type { PlannerStore } from "../planner/PlannerStore.js";
import type { ApprovalGate, PendingApproval } from "../safety/ApprovalGate.js";
import type { Conversation, ConversationStore } from "./ConversationStore.js";

type ControllerDependencies = {
  agent: CherryAgent;
  conversation: ConversationStore;
  planner: PlannerStore;
  engineer: EngineerLoopEngine;
  approvalGate: ApprovalGate;
};

type ActiveRun = {
  controller: AbortController;
  conversationId: string;
  userId: string;
  startedAt: string;
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB limit");
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(payload));
}

function publicApproval(item: PendingApproval): Record<string, unknown> {
  return {
    id: item.id,
    tool: item.tool,
    risk: item.risk,
    args: item.args,
    createdAt: item.createdAt,
    status: item.status,
    ...(item.resolvedAt ? { resolvedAt: item.resolvedAt } : {}),
    ...(item.result !== undefined ? { result: item.result } : {}),
  };
}

function historyFrom(conversation: Conversation): ChatMessage[] {
  return conversation.messages.slice(-40).map((message) => message.role === "user"
    ? { role: "user", content: message.content }
    : { role: "assistant", content: message.content });
}

function sendSse(res: ServerResponse, event: string, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function traceLabel(event: AgentTraceEvent): string {
  if (event.type === "tool") return event.name ? `Tool completed: ${event.name}` : "Tool completed";
  if (event.type === "error") return event.name ? `Error: ${event.name}` : "Agent error";
  if (event.type === "correctness") return "Correctness verification";
  const detail = event.detail as { tool_calls?: Array<{ function?: { name?: string } }> } | undefined;
  const names = detail?.tool_calls?.map((call) => call.function?.name).filter((name): name is string => Boolean(name)) ?? [];
  return names.length ? `Planning tools: ${names.join(", ")}` : "Cherry is thinking";
}

export class ConversationHttpController {
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly deps: ControllerDependencies) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/conversations") {
      const userId = url.searchParams.get("userId")?.trim() || undefined;
      const limitValue = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isFinite(limitValue) ? limitValue : 50;
      json(res, 200, { ok: true, conversations: await this.deps.conversation.list({ ...(userId ? { userId } : {}), limit }) });
      return true;
    }

    if (req.method === "POST" && pathname === "/conversations") {
      const body = await readJson(req);
      const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : "web-user";
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
      const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
      const created = await this.deps.conversation.create({ userId, ...(title ? { title } : {}), ...(sessionId ? { sessionId } : {}) });
      json(res, 201, { ok: true, conversation: created });
      return true;
    }

    const conversationMatch = pathname.match(/^\/conversations\/([^/]+)$/);
    if (conversationMatch && req.method === "GET") {
      json(res, 200, { ok: true, conversation: await this.deps.conversation.get(decodeURIComponent(conversationMatch[1] ?? "")) });
      return true;
    }

    if (conversationMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) throw new Error("title is required");
      json(res, 200, { ok: true, conversation: await this.deps.conversation.rename(decodeURIComponent(conversationMatch[1] ?? ""), title) });
      return true;
    }

    if (conversationMatch && req.method === "DELETE") {
      await this.deps.conversation.delete(decodeURIComponent(conversationMatch[1] ?? ""));
      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === "GET" && pathname === "/agent-inbox") {
      const [planner, engineer] = await Promise.all([
        this.deps.planner.getDashboard(),
        this.deps.engineer.getDashboard(),
      ]);
      const activeRuns = [...this.activeRuns.entries()].map(([runId, run]) => ({
        runId,
        conversationId: run.conversationId,
        userId: run.userId,
        startedAt: run.startedAt,
      }));
      const approvals = this.deps.approvalGate.list("pending").map(publicApproval);
      const loops = engineer.recent ?? [];
      json(res, 200, {
        ok: true,
        activeRuns,
        runningEngineer: loops.filter((loop) => loop.status === "running"),
        blockedEngineer: loops.filter((loop) => loop.status === "blocked"),
        approvals,
        doing: planner.flow?.doing ?? [],
        waiting: planner.flow?.waiting ?? [],
        stats: {
          activeRuns: activeRuns.length,
          runningEngineer: loops.filter((loop) => loop.status === "running").length,
          blockedEngineer: loops.filter((loop) => loop.status === "blocked").length,
          approvals: approvals.length,
          doing: planner.flow?.doing?.length ?? 0,
          waiting: planner.flow?.waiting?.length ?? 0,
        },
      });
      return true;
    }

    const cancelMatch = pathname.match(/^\/runs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const runId = decodeURIComponent(cancelMatch[1] ?? "");
      const active = this.activeRuns.get(runId);
      if (!active) {
        json(res, 404, { ok: false, error: `Active run not found: ${runId}` });
        return true;
      }
      active.controller.abort();
      json(res, 200, { ok: true, runId, status: "cancelling" });
      return true;
    }

    if (req.method === "POST" && pathname === "/chat") {
      const body = await readJson(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        json(res, 400, { ok: false, error: "message is required" });
        return true;
      }

      const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : "web-user";
      const requestedId = typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim() : undefined;
      const existing = requestedId ? await this.deps.conversation.get(requestedId) : await this.deps.conversation.create({ userId });
      const history = historyFrom(existing);
      await this.deps.conversation.appendMessage(existing.id, { role: "user", content: message });
      const result = await this.deps.agent.run(message, { sessionId: existing.sessionId, userId }, {
        history: history.flatMap((item) => item.role === "user" || item.role === "assistant"
          ? [{ role: item.role, content: item.content ?? "" }]
          : []),
      });
      await this.deps.conversation.appendMessage(existing.id, { role: "assistant", content: result.answer, steps: result.steps });
      json(res, 200, { ok: true, conversationId: existing.id, ...result });
      return true;
    }

    if (req.method === "POST" && pathname === "/chat/stream") {
      await this.streamChat(req, res);
      return true;
    }

    return false;
  }

  private async streamChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      json(res, 400, { ok: false, error: "message is required" });
      return;
    }

    const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : "web-user";
    const requestedId = typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim() : undefined;
    const existing = requestedId ? await this.deps.conversation.get(requestedId) : await this.deps.conversation.create({ userId });
    const history = historyFrom(existing);
    await this.deps.conversation.appendMessage(existing.id, { role: "user", content: message });

    const runId = crypto.randomUUID();
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      conversationId: existing.id,
      userId,
      startedAt: new Date().toISOString(),
    };
    this.activeRuns.set(runId, active);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      "x-accel-buffering": "no",
    });
    sendSse(res, "started", { runId, conversationId: existing.id, startedAt: active.startedAt });

    let finished = false;
    res.on("close", () => {
      if (!finished) controller.abort();
    });

    try {
      const result = await this.deps.agent.run(message, { sessionId: existing.sessionId, userId }, {
        history: history.flatMap((item) => item.role === "user" || item.role === "assistant"
          ? [{ role: item.role, content: item.content ?? "" }]
          : []),
        signal: controller.signal,
        onTrace: (event) => {
          sendSse(res, "trace", {
            runId,
            label: traceLabel(event),
            step: event.step,
            type: event.type,
            name: event.name,
            detail: event.detail,
          });
        },
      });

      await this.deps.conversation.appendMessage(existing.id, {
        role: "assistant",
        content: result.answer,
        runId,
        steps: result.steps,
      });
      sendSse(res, "completed", {
        runId,
        conversationId: existing.id,
        answer: result.answer,
        steps: result.steps,
        correctness: result.correctness,
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      sendSse(res, cancelled ? "cancelled" : "error", {
        runId,
        conversationId: existing.id,
        error: cancelled ? "Run cancelled" : error instanceof Error ? error.message : String(error),
      });
    } finally {
      finished = true;
      this.activeRuns.delete(runId);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }
}
