import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createRuntime } from "./bootstrap.js";
import { config } from "./config.js";
import type { PlanPriority, PlanStatus } from "./planner/PlannerStore.js";
import type { NotificationChannel, ScheduleSpec } from "./planner/schedule.js";
import type { PendingApproval } from "./safety/ApprovalGate.js";

const publicRoot = resolve(process.cwd(), "public");
const { agent, tools, approvalGate, connectors, planner, scheduler } = await createRuntime();

const planStatuses: PlanStatus[] = ["inbox", "planned", "doing", "waiting", "done", "cancelled"];
const priorities: PlanPriority[] = ["low", "normal", "high", "urgent"];
const notificationChannels: NotificationChannel[] = ["in_app", "browser", "email", "line", "slack", "webhook"];

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(payload));
}

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

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected string array");
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseStatus(value: unknown): PlanStatus | undefined {
  return typeof value === "string" && planStatuses.includes(value as PlanStatus) ? value as PlanStatus : undefined;
}

function parsePriority(value: unknown): PlanPriority | undefined {
  return typeof value === "string" && priorities.includes(value as PlanPriority) ? value as PlanPriority : undefined;
}

function parseChannels(value: unknown): NotificationChannel[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("channels must be an array");
  return value.map((item) => {
    if (typeof item !== "string" || !notificationChannels.includes(item as NotificationChannel)) {
      throw new Error(`Unknown notification channel: ${String(item)}`);
    }
    return item as NotificationChannel;
  });
}

function parseSchedule(value: unknown): ScheduleSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule must be an object");
  const input = value as Record<string, unknown>;
  const kind = requiredString(input, "kind");
  const timezone = optionalString(input, "timezone");
  switch (kind) {
    case "once": return { kind, at: requiredString(input, "at") };
    case "interval": {
      const everyMinutes = Number(input.everyMinutes);
      if (!Number.isFinite(everyMinutes)) throw new Error("everyMinutes is required");
      const startAt = optionalString(input, "startAt");
      return { kind, everyMinutes, ...(startAt ? { startAt } : {}) };
    }
    case "daily": return { kind, time: requiredString(input, "time"), ...(timezone ? { timezone } : {}) };
    case "weekdays": return { kind, time: requiredString(input, "time"), ...(timezone ? { timezone } : {}) };
    case "weekly": {
      if (!Array.isArray(input.weekdays)) throw new Error("weekdays must be an array");
      return { kind, weekdays: input.weekdays.map(Number), time: requiredString(input, "time"), ...(timezone ? { timezone } : {}) };
    }
    case "monthly": return { kind, day: Number(input.day), time: requiredString(input, "time"), ...(timezone ? { timezone } : {}) };
    case "cron": return { kind, expression: requiredString(input, "expression"), ...(timezone ? { timezone } : {}) };
    default: throw new Error(`Unknown schedule kind: ${kind}`);
  }
}

function safePublicPath(urlPath: string): string | null {
  const pathname = decodeURIComponent(urlPath.split("?")[0] || "/");
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(publicRoot, requested);
  if (target !== publicRoot && !target.startsWith(publicRoot + sep)) return null;
  return target;
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET") return false;
  const target = safePublicPath(req.url ?? "/");
  if (!target) return false;

  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": contentTypes[extname(target)] ?? "application/octet-stream",
      "cache-control": target.endsWith("sw.js") ? "no-cache" : "public, max-age=300",
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      const dashboard = await planner.getDashboard();
      json(res, 200, {
        ok: true,
        name: "CherryAgent",
        model: config.llm.model,
        tools: tools.list().length,
        connectors,
        pendingApprovals: approvalGate.list("pending").length,
        planner: {
          schedulerRunning: scheduler.running,
          schedulerIntervalMs: config.scheduler.intervalMs,
          activeReminders: dashboard.stats.activeReminders,
          unreadAlerts: dashboard.stats.unreadAlerts,
        },
        time: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/tools") {
      json(res, 200, tools.list().map(({ name, description, risk, parameters }) => ({ name, description, risk, parameters })));
      return;
    }

    if (req.method === "GET" && pathname === "/planner/dashboard") {
      json(res, 200, { ok: true, dashboard: await planner.getDashboard() });
      return;
    }

    if (req.method === "GET" && pathname === "/planner/items") {
      const status = parseStatus(url.searchParams.get("status"));
      const flowId = url.searchParams.get("flowId")?.trim() || undefined;
      json(res, 200, { ok: true, items: await planner.listItems({ ...(status ? { status } : {}), ...(flowId ? { flowId } : {}) }) });
      return;
    }

    if (req.method === "POST" && pathname === "/planner/items") {
      const body = await readJson(req);
      const status = parseStatus(body.status);
      const priority = parsePriority(body.priority);
      const tags = stringArray(body.tags);
      const dependsOn = stringArray(body.dependsOn);
      const item = await planner.createItem({
        title: requiredString(body, "title"),
        ...(optionalString(body, "description") ? { description: optionalString(body, "description") } : {}),
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
        ...(optionalString(body, "flowId") ? { flowId: optionalString(body, "flowId") } : {}),
        ...(tags ? { tags } : {}),
        ...(optionalString(body, "startAt") ? { startAt: optionalString(body, "startAt") } : {}),
        ...(optionalString(body, "dueAt") ? { dueAt: optionalString(body, "dueAt") } : {}),
        ...(typeof body.durationMinutes === "number" ? { durationMinutes: body.durationMinutes } : {}),
        ...(optionalString(body, "timezone") ? { timezone: optionalString(body, "timezone") } : {}),
        ...(dependsOn ? { dependsOn } : {}),
      });
      json(res, 201, { ok: true, item });
      return;
    }

    const itemMatch = pathname.match(/^\/planner\/items\/([^/]+)$/);
    if (req.method === "PATCH" && itemMatch) {
      const id = decodeURIComponent(itemMatch[1] ?? "");
      const body = await readJson(req);
      const status = parseStatus(body.status);
      const priority = parsePriority(body.priority);
      const tags = stringArray(body.tags);
      const item = await planner.updateItem(id, {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
        ...(typeof body.flowId === "string" ? { flowId: body.flowId } : {}),
        ...(tags ? { tags } : {}),
        ...(body.startAt === null || typeof body.startAt === "string" ? { startAt: body.startAt } : {}),
        ...(body.dueAt === null || typeof body.dueAt === "string" ? { dueAt: body.dueAt } : {}),
        ...(body.durationMinutes === null || typeof body.durationMinutes === "number" ? { durationMinutes: body.durationMinutes } : {}),
        ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
      });
      json(res, 200, { ok: true, item });
      return;
    }

    const dependencyMatch = pathname.match(/^\/planner\/items\/([^/]+)\/dependencies$/);
    if (req.method === "POST" && dependencyMatch) {
      const body = await readJson(req);
      const item = await planner.addDependency(decodeURIComponent(dependencyMatch[1] ?? ""), requiredString(body, "dependencyId"));
      json(res, 200, { ok: true, item });
      return;
    }

    if (req.method === "GET" && pathname === "/planner/reminders") {
      const enabledParam = url.searchParams.get("enabled");
      const enabled = enabledParam === "true" ? true : enabledParam === "false" ? false : undefined;
      json(res, 200, { ok: true, reminders: await planner.listReminders(enabled) });
      return;
    }

    if (req.method === "POST" && pathname === "/planner/reminders") {
      const body = await readJson(req);
      const channels = parseChannels(body.channels);
      const reminder = await planner.createReminder({
        title: requiredString(body, "title"),
        schedule: parseSchedule(body.schedule),
        ...(optionalString(body, "message") ? { message: optionalString(body, "message") } : {}),
        ...(optionalString(body, "itemId") ? { itemId: optionalString(body, "itemId") } : {}),
        ...(channels ? { channels } : {}),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      });
      json(res, 201, { ok: true, reminder });
      return;
    }

    const reminderEnabledMatch = pathname.match(/^\/planner\/reminders\/([^/]+)\/enabled$/);
    if (req.method === "POST" && reminderEnabledMatch) {
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") throw new Error("enabled must be boolean");
      const reminder = await planner.setReminderEnabled(decodeURIComponent(reminderEnabledMatch[1] ?? ""), body.enabled);
      json(res, 200, { ok: true, reminder });
      return;
    }

    if (req.method === "GET" && pathname === "/planner/alerts") {
      const unreadOnly = url.searchParams.get("unread") === "true";
      const limit = Number(url.searchParams.get("limit") ?? "100");
      json(res, 200, { ok: true, alerts: await planner.listAlerts({ unreadOnly, limit: Number.isFinite(limit) ? limit : 100 }) });
      return;
    }

    const alertActionMatch = pathname.match(/^\/planner\/alerts\/([^/]+)\/(read|snooze)$/);
    if (req.method === "POST" && alertActionMatch) {
      const id = decodeURIComponent(alertActionMatch[1] ?? "");
      const action = alertActionMatch[2];
      if (action === "read") {
        json(res, 200, { ok: true, alert: await planner.markAlertRead(id) });
        return;
      }
      const body = await readJson(req);
      const minutes = Number(body.minutes);
      json(res, 200, { ok: true, alert: await planner.snoozeAlert(id, minutes) });
      return;
    }

    if (req.method === "POST" && pathname === "/planner/scheduler/tick") {
      json(res, 200, { ok: true, tick: await scheduler.tick() });
      return;
    }

    if (req.method === "GET" && pathname === "/approvals") {
      json(res, 200, { ok: true, approvals: approvalGate.list("pending").map(publicApproval) });
      return;
    }

    const approvalAction = pathname.match(/^\/approvals\/([^/]+)\/(approve|deny)$/);
    if (req.method === "POST" && approvalAction) {
      const id = decodeURIComponent(approvalAction[1] ?? "");
      const action = approvalAction[2];

      if (action === "deny") {
        const denied = approvalGate.deny(id);
        json(res, 200, { ok: true, approval: publicApproval(denied) });
        return;
      }

      approvalGate.approve(id);
      const approved = approvalGate.consumeApproved(id);
      const result = await tools.executeApproved(approved.tool, approved.args, approved.context);
      const completed = approvalGate.markExecuted(id, { ...result });
      json(res, result.ok ? 200 : 502, { ok: result.ok, approval: publicApproval(completed), result });
      return;
    }

    if (req.method === "POST" && pathname === "/chat") {
      const body = await readJson(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        json(res, 400, { ok: false, error: "message is required" });
        return;
      }

      const sessionId = typeof body.sessionId === "string" ? body.sessionId : crypto.randomUUID();
      const userId = typeof body.userId === "string" ? body.userId : "web-user";
      const result = await agent.run(message, { sessionId, userId });
      json(res, 200, { ok: true, ...result });
      return;
    }

    if (await serveStatic(req, res)) return;
    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : message.startsWith("Unknown approval") || message.includes("cannot be") ? 409 : 400;
    json(res, status, { ok: false, error: message });
  }
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`CherryAgent is running at http://${config.server.host}:${config.server.port}`);
  console.log(`Loaded ${tools.list().length} tools for model ${config.llm.model}`);
  console.log(`Google Workspace configured: ${connectors.google ? "yes" : "no"}`);
  console.log(`Planner scheduler interval: ${config.scheduler.intervalMs} ms`);
});
