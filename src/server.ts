import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import Busboy from "busboy";
import { createRuntime } from "./bootstrap.js";
import { AuthService, type AuthIdentity } from "./auth/AuthService.js";
import { config } from "./config.js";
import type { AgentRole } from "./agentic/AgenticStateStore.js";
import type { TenantPlan } from "./tenancy/constants.js";
import { getAuditLogger, AuditLogger } from "./audit/AuditLogger.js";
import type { EngineerLoopStatus, EngineerPhase } from "./engineer/EngineerLoopEngine.js";
import type { PlanPriority, PlanStatus } from "./planner/PlannerStore.js";
import type { NotificationChannel, ScheduleSpec } from "./planner/schedule.js";
import type { PendingApproval } from "./safety/ApprovalGate.js";
import type { ReportMapping, ReportTemplate } from "./reports/types.js";
import type { RiskLevel } from "./core/types.js";
import type { McpHttpConfig, McpStdioConfig } from "./mcp/McpServerStore.js";

const publicRoot = resolve(process.cwd(), "public");
const { agent, tools, approvalGate, usage, officeInbox, reports, chatLogs, chatSessions, nodes, mcp, skills, linuxSsh, connectors, planner, engineer, scheduler, channelGateway, orchestrator, agenticStore } = await createRuntime();
const auth = new AuthService(config.auth);
if (config.auth.enabled) await auth.initialize();

// ============================================================================
// Audit logger singleton — ping ที่ boot เพื่อเช็คว่า PG พร้อม
// ถ้า PG ล่ม จะ fail-soft (warn ครั้งเดียว + drop events) เพื่อไม่ให้ audit พัง app
// ============================================================================
const audit: AuditLogger = getAuditLogger();
await audit.ping();

const planStatuses: PlanStatus[] = ["inbox", "planned", "doing", "waiting", "done", "cancelled"];
const priorities: PlanPriority[] = ["low", "normal", "high", "urgent"];
const notificationChannels: NotificationChannel[] = ["in_app", "browser", "email", "line", "slack", "webhook"];
const engineerStatuses: EngineerLoopStatus[] = ["running", "blocked", "succeeded", "failed", "aborted"];
const engineerPhases: EngineerPhase[] = ["plan", "execute", "observe", "diagnose", "patch", "test", "verify", "learn"];
const orchestrationRoles: AgentRole[] = ["office", "planner", "infra", "market", "research", "database", "engineer", "general"];
const reportTemplates: ReportTemplate[] = ["auto", "general", "sales", "finance", "operations"];

async function orchestrationSnapshot(runId: string): Promise<{
  run: Awaited<ReturnType<typeof orchestrator.getRun>>;
  handoffs: Awaited<ReturnType<typeof agenticStore.listHandoffs>>;
  evidence: Awaited<ReturnType<typeof agenticStore.listEvidence>>;
  logs: Awaited<ReturnType<typeof agenticStore.listLogs>>;
}> {
  const [run, handoffs, evidence, logs] = await Promise.all([
    orchestrator.getRun(runId),
    agenticStore.listHandoffs({ runId, limit: 500 }),
    agenticStore.listEvidence({ runId, limit: 500 }),
    agenticStore.listLogs({ runId, limit: 1000 }),
  ]);
  return { run, handoffs, evidence, logs };
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
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

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function nodeToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = header.match(/^Node\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

async function readReportUpload(req: IncomingMessage): Promise<{
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  template?: ReportTemplate;
  title?: string;
}> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new Error("Report upload must use multipart/form-data");
  }

  return await new Promise((resolveUpload, rejectUpload) => {
    let settled = false;
    let fileName = "";
    let mimeType = "";
    let fileSeen = false;
    let fileTooLarge = false;
    let template: ReportTemplate | undefined;
    let title: string | undefined;
    const chunks: Buffer[] = [];

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectUpload(error instanceof Error ? error : new Error(String(error)));
    };

    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: config.reports.maxBytes, fields: 5, fieldSize: 10_000, parts: 6 },
      });
    } catch (error) {
      fail(error);
      return;
    }

    parser.on("file", (fieldName, stream, info) => {
      if (fieldName !== "file" || fileSeen) {
        stream.resume();
        return;
      }
      fileSeen = true;
      fileName = info.filename;
      mimeType = info.mimeType;
      stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on("limit", () => { fileTooLarge = true; });
      stream.on("error", fail);
    });
    parser.on("field", (name, value) => {
      if (name === "template" && value.trim()) {
        if (!reportTemplates.includes(value.trim() as ReportTemplate)) {
          fail(new Error(`template must be one of: ${reportTemplates.join(", ")}`));
          return;
        }
        template = value.trim() as ReportTemplate;
      }
      if (name === "title" && value.trim()) title = value.trim().slice(0, 160);
    });
    parser.on("filesLimit", () => fail(new Error("Only one report file can be uploaded")));
    parser.on("partsLimit", () => fail(new Error("Report upload contains too many parts")));
    parser.on("error", fail);
    parser.on("finish", () => {
      if (settled) return;
      if (fileTooLarge) return fail(new Error(`File exceeds ${Math.round(config.reports.maxBytes / 1_000_000)} MB limit`));
      if (!fileSeen || !fileName || !chunks.length) return fail(new Error("file is required"));
      settled = true;
      resolveUpload({
        buffer: Buffer.concat(chunks),
        fileName,
        mimeType,
        ...(template ? { template } : {}),
        ...(title ? { title } : {}),
      });
    });
    req.on("aborted", () => fail(new Error("Report upload was aborted")));
    req.pipe(parser);
  });
}

function parseReportTemplate(value: unknown): ReportTemplate | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !reportTemplates.includes(value as ReportTemplate)) {
    throw new Error(`template must be one of: ${reportTemplates.join(", ")}`);
  }
  return value as ReportTemplate;
}

function parseReportMapping(value: unknown): ReportMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mapping must be an object");
  const input = value as Record<string, unknown>;
  const metrics = stringArray(input.metrics);
  const dimensions = stringArray(input.dimensions);
  if (!metrics) throw new Error("mapping.metrics must be an array");
  if (!dimensions) throw new Error("mapping.dimensions must be an array");
  const dateColumn = optionalString(input, "dateColumn");
  return { ...(dateColumn ? { dateColumn } : {}), metrics, dimensions };
}

function requestHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(",");
  }
  return headers;
}

function requestQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
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

function chatIdValue(value: unknown, fallback = crypto.randomUUID()): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error("chatId must be a string");
  const chatId = value.trim();
  if (!chatId) return fallback;
  if (chatId.length > 160 || /[\u0000-\u001f\u007f]/.test(chatId)) {
    throw new Error("chatId must be a short printable identifier");
  }
  return chatId;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected string array");
  return value.map((item) => item.trim()).filter(Boolean);
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string" || !item.trim())) throw new Error(`${label} values must be environment variable names`);
  return Object.fromEntries(entries.map(([key, item]) => [key, (item as string).trim()]));
}

function riskValue(value: unknown, fallback: RiskLevel = "external"): RiskLevel {
  return typeof value === "string" && ["safe", "write", "external", "dangerous"].includes(value)
    ? value as RiskLevel
    : fallback;
}

function riskRecord(value: unknown): Record<string, RiskLevel> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("toolRisks must be an object");
  const result: Record<string, RiskLevel> = {};
  for (const [name, risk] of Object.entries(value as Record<string, unknown>)) {
    if (typeof risk !== "string" || !["safe", "write", "external", "dangerous"].includes(risk)) {
      throw new Error(`Invalid risk for MCP tool '${name}'`);
    }
    result[name] = risk as RiskLevel;
  }
  return result;
}

function mcpConnection(body: Record<string, unknown>): McpStdioConfig | McpHttpConfig {
  const transport = requiredString(body, "transport");
  if (transport === "stdio") {
    const args = stringArray(body.args);
    const cwd = optionalString(body, "cwd");
    const envFrom = stringRecord(body.envFrom, "envFrom");
    return {
      transport,
      command: requiredString(body, "command"),
      ...(args ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(envFrom ? { envFrom } : {}),
    };
  }
  if (transport === "streamable-http") {
    const url = requiredString(body, "url");
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("MCP URL must use http or https");
    const headersFrom = stringRecord(body.headersFrom, "headersFrom");
    return { transport, url, ...(headersFrom ? { headersFrom } : {}) };
  }
  throw new Error("transport must be stdio or streamable-http");
}

function parseStatus(value: unknown): PlanStatus | undefined {
  return typeof value === "string" && planStatuses.includes(value as PlanStatus) ? value as PlanStatus : undefined;
}

function parsePriority(value: unknown): PlanPriority | undefined {
  return typeof value === "string" && priorities.includes(value as PlanPriority) ? value as PlanPriority : undefined;
}

function parseEngineerStatus(value: unknown): EngineerLoopStatus | undefined {
  return typeof value === "string" && engineerStatuses.includes(value as EngineerLoopStatus)
    ? value as EngineerLoopStatus
    : undefined;
}

function parseEngineerPhase(value: unknown): EngineerPhase {
  if (typeof value !== "string" || !engineerPhases.includes(value as EngineerPhase)) {
    throw new Error(`phase must be one of: ${engineerPhases.join(", ")}`);
  }
  return value as EngineerPhase;
}

function parseOptionalEngineerPhase(value: unknown): EngineerPhase | undefined {
  return value === undefined ? undefined : parseEngineerPhase(value);
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

function parseOrchestrationRoles(value: unknown): AgentRole[] | undefined {
  const roles = stringArray(value);
  if (roles === undefined) return undefined;
  for (const role of roles) {
    if (!orchestrationRoles.includes(role as AgentRole)) {
      throw new Error(`Unknown orchestration role: ${role}`);
    }
  }
  return roles as AgentRole[];
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
    const isDocument = target.endsWith(".html");
    res.writeHead(200, {
      "content-type": contentTypes[extname(target)] ?? "application/octet-stream",
      "cache-control": target.endsWith("sw.js") || isDocument ? "no-cache" : "public, max-age=300",
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
  // ===== HTTP audit: จับ method/path/status/duration ของทุก request =====
  const requestStart = Date.now();
  const traceId = AuditLogger.newTraceId();
  const fwdFor = req.headers["x-forwarded-for"];
  const cfIp = req.headers["cf-connecting-ip"];
  const fwdForStr = typeof fwdFor === "string" ? (fwdFor.split(",")[0] ?? "").trim() : undefined;
  const cfIpStr = typeof cfIp === "string" ? cfIp : undefined;
  const clientIp: string | undefined = fwdForStr || cfIpStr || req.socket.remoteAddress || undefined;
  let requestIdentity: AuthIdentity | undefined;
  // attach traceId เพื่อให้ tool_call audit สามารถ correlate กับ http_request ได้
  (req as IncomingMessage & { traceId?: string }).traceId = traceId;

  // wrap res.end เพื่อจับ status code (call original ก่อน, แล้ว audit หลัง response)
  const originalEnd = res.end.bind(res);
  let responseStatus = 0;
  const wrappedEnd: typeof res.end = (chunk?: any, encoding?: any, callback?: any) => {
    responseStatus = res.statusCode;
    // call original first แล้วค่อย audit (non-blocking)
    const result = encoding === undefined && callback === undefined
      ? (originalEnd as any)(chunk)
      : (originalEnd as any)(chunk, encoding, callback);
    return result;
  };
  res.end = wrappedEnd as typeof res.end;

  // hook 'close' event — audit ทุก request หลัง response ปิด (ทั้งปกติและ abort)
  res.on("close", () => {
    // skip noise: OPTIONS preflight (static assets ยัง log เพื่อ debug)
    if (req.method === "OPTIONS") return;
    const isStaticAsset =
      req.method === "GET" &&
      /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|map)$/i.test(req.url ?? "");

    // build event object แบบ conditional (exactOptionalPropertyTypes compliant)
    const event: import("./audit/AuditLogger.js").AuditEvent = {
      action: "http_request",
      traceId,
      method: req.method ?? "UNKNOWN",
      path: (req.url ?? "/").split("?")[0] ?? "/",
      resultStatus: String(responseStatus || "unknown"),
      durationMs: Date.now() - requestStart,
      metadata: isStaticAsset ? { static: true } : {},
    };
    if (clientIp) event.ip = clientIp;
    if (requestIdentity) {
      event.userId = requestIdentity.user.id;
      event.sessionId = requestIdentity.sessionId;
    }

    audit.log(event);
  });

  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,authorization,x-line-signature",
      });
      res.end();
      return;
    }

    if (req.method === "POST" && pathname === "/auth/login") {
      if (!config.auth.enabled) {
        json(res, 400, { ok: false, error: "Authentication is disabled" });
        return;
      }

      try {
        const body = await readJson(req);
        const result = await auth.login(requiredString(body, "email"), requiredString(body, "password"));
        requestIdentity = result;
        const event: import("./audit/AuditLogger.js").AuditEvent = {
          action: "login",
          userId: result.user.id,
          sessionId: result.sessionId,
          resultStatus: "ok",
        };
        if (clientIp) event.ip = clientIp;
        audit.log(event);
        json(res, 200, {
          ok: true,
          token: result.token,
          user: result.user,
          expiresAt: result.expiresAt,
        });
      } catch (error) {
        const event: import("./audit/AuditLogger.js").AuditEvent = { action: "login_failed", resultStatus: "error" };
        if (clientIp) event.ip = clientIp;
        audit.log(event);
        json(res, 401, { ok: false, error: "Invalid email or password" });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/auth/logout") {
      if (config.auth.enabled) {
        requestIdentity = auth.authenticate(bearerToken(req));
        if (!requestIdentity) {
          json(res, 401, { ok: false, error: "Authentication required" });
          return;
        }
        await auth.logout(bearerToken(req));
        const event: import("./audit/AuditLogger.js").AuditEvent = {
          action: "logout",
          userId: requestIdentity.user.id,
          sessionId: requestIdentity.sessionId,
          resultStatus: "ok",
        };
        if (clientIp) event.ip = clientIp;
        audit.log(event);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/auth/me") {
      if (!config.auth.enabled) {
        json(res, 200, { ok: true, authEnabled: false, user: null });
        return;
      }
      requestIdentity = auth.authenticate(bearerToken(req));
      if (!requestIdentity) {
        json(res, 401, { ok: false, error: "Authentication required" });
        return;
      }
      json(res, 200, { ok: true, authEnabled: true, user: requestIdentity.user, expiresAt: requestIdentity.expiresAt });
      return;
    }

    if (req.method === "GET" && pathname === "/workspace/context") {
      if (!requestIdentity && config.auth.enabled) {
        requestIdentity = auth.authenticate(bearerToken(req));
      }
      if (config.auth.enabled && !requestIdentity) {
        json(res, 401, { ok: false, error: "Authentication required" });
        return;
      }
      const tenantId = requestIdentity?.user.tenantId ?? "org-default";
      const organization = auth.getOrganization(tenantId);
      json(res, 200, {
        ok: true,
        organization: organization ?? { id: tenantId, name: "Cherry Workspace", slug: "cherry-workspace", plan: "shared", enabled: true },
        user: requestIdentity?.user ?? null,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/organizations") {
      if (!requestIdentity && config.auth.enabled) requestIdentity = auth.authenticate(bearerToken(req));
      if (!requestIdentity || requestIdentity.user.role !== "admin") {
        json(res, 403, { ok: false, error: "Organization administration requires admin role" });
        return;
      }
      json(res, 200, { ok: true, organizations: auth.listOrganizations() });
      return;
    }

    if (req.method === "POST" && pathname === "/organizations") {
      if (!requestIdentity && config.auth.enabled) requestIdentity = auth.authenticate(bearerToken(req));
      if (!requestIdentity || requestIdentity.user.role !== "admin") {
        json(res, 403, { ok: false, error: "Organization administration requires admin role" });
        return;
      }
      const body = await readJson(req);
      const rawPlan = optionalString(body, "plan");
      const slug = optionalString(body, "slug");
      const plans: TenantPlan[] = ["pilot", "shared", "enterprise", "dedicated"];
      if (rawPlan && !plans.includes(rawPlan as TenantPlan)) throw new Error(`plan must be one of: ${plans.join(", ")}`);
      const organization = await auth.createOrganization({
        name: requiredString(body, "name"),
        ...(slug ? { slug } : {}),
        ...(rawPlan ? { plan: rawPlan as TenantPlan } : {}),
      });
      json(res, 201, { ok: true, organization });
      return;
    }

    const organizationMemberMatch = pathname.match(/^\/organizations\/([^/]+)\/members$/);
    if (req.method === "POST" && organizationMemberMatch) {
      if (!requestIdentity && config.auth.enabled) requestIdentity = auth.authenticate(bearerToken(req));
      if (!requestIdentity || requestIdentity.user.role !== "admin") {
        json(res, 403, { ok: false, error: "Organization administration requires admin role" });
        return;
      }
      const body = await readJson(req);
      const role = optionalString(body, "role") as AuthIdentity["user"]["role"] | undefined;
      if (role && !["admin", "user", "viewer"].includes(role)) throw new Error("role must be admin, user, or viewer");
      const member = await auth.createMember({
        tenantId: decodeURIComponent(organizationMemberMatch[1] ?? ""),
        email: requiredString(body, "email"),
        name: requiredString(body, "name"),
        password: requiredString(body, "password"),
        ...(role ? { role } : {}),
      });
      json(res, 201, { ok: true, member });
      return;
    }

    // Login assets remain public. Every application API below this point requires a valid session.
    if (await serveStatic(req, res)) return;

    const channelWebhookMatch = pathname.match(/^\/channels\/([^/]+)\/webhook$/);
    const isNodeAgentApi = req.method === "POST" && (
      pathname === "/nodes/pair"
      || pathname === "/nodes/agent/poll"
      || /^\/nodes\/agent\/tasks\/[^/]+\/complete$/.test(pathname)
    );
    const isPublicApi = (req.method === "GET" && pathname === "/health")
      || (req.method === "POST" && Boolean(channelWebhookMatch))
      || isNodeAgentApi;

    if (config.auth.enabled && !isPublicApi) {
      requestIdentity = auth.authenticate(bearerToken(req));
      if (!requestIdentity) {
        json(res, 401, { ok: false, error: "Authentication required" });
        return;
      }

      if (requestIdentity.user.role === "viewer" && req.method !== "GET") {
        const event: import("./audit/AuditLogger.js").AuditEvent = {
          action: "rbac_deny",
          userId: requestIdentity.user.id,
          sessionId: requestIdentity.sessionId,
          path: pathname,
          method: req.method ?? "UNKNOWN",
          resultStatus: "denied",
          metadata: { role: requestIdentity.user.role },
        };
        if (clientIp) event.ip = clientIp;
        audit.log(event);
        json(res, 403, { ok: false, error: "Your role is read-only" });
        return;
      }
    }

    const tenantId = requestIdentity?.user.tenantId ?? "org-default";

    if (req.method === "POST" && pathname === "/nodes/pair") {
      const body = await readJson(req);
      const capabilities = stringArray(body.capabilities) ?? [];
      const workspace = optionalString(body, "workspace");
      const result = await nodes.pair({
        code: requiredString(body, "code"),
        name: requiredString(body, "name"),
        platform: requiredString(body, "platform"),
        arch: requiredString(body, "arch"),
        version: requiredString(body, "version"),
        capabilities,
        ...(workspace ? { workspace } : {}),
      });
      audit.log({
        action: "node_pair",
        traceId,
        resultStatus: "ok",
        metadata: { nodeId: result.node.id, tenantId: result.node.tenantId, name: result.node.name, capabilities },
      });
      json(res, 201, { ok: true, ...result });
      return;
    }

    if (req.method === "POST" && pathname === "/nodes/agent/poll") {
      const node = await nodes.authenticate(nodeToken(req) ?? "");
      if (!node) {
        json(res, 401, { ok: false, error: "Cherry Node authentication failed" });
        return;
      }
      const task = await nodes.poll(node.id);
      json(res, 200, { ok: true, task: task ?? null });
      return;
    }

    const nodeCompleteMatch = pathname.match(/^\/nodes\/agent\/tasks\/([^/]+)\/complete$/);
    if (req.method === "POST" && nodeCompleteMatch) {
      const node = await nodes.authenticate(nodeToken(req) ?? "");
      if (!node) {
        json(res, 401, { ok: false, error: "Cherry Node authentication failed" });
        return;
      }
      const body = await readJson(req);
      if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) throw new Error("result must be an object");
      const rawResult = body.result as Record<string, unknown>;
      const task = await nodes.complete(node.id, decodeURIComponent(nodeCompleteMatch[1] ?? ""), {
        ok: rawResult.ok === true,
        ...(rawResult.output !== undefined ? { output: rawResult.output } : {}),
        ...(typeof rawResult.error === "string" ? { error: rawResult.error } : {}),
      });
      json(res, 200, { ok: true, taskId: task.id, status: task.status });
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      const [dashboard, engineerDashboard] = await Promise.all([
        planner.getDashboard(new Date(), tenantId),
        engineer.getDashboard(tenantId),
      ]);
      const linuxSshStatus = linuxSsh.status();
      json(res, 200, {
        ok: true,
        name: "CherryAgent",
        model: config.llm.model,
        tools: tools.list().length,
        connectors,
        linuxSsh: { configured: linuxSshStatus.configured, ready: linuxSshStatus.ready },
        nodes: { paired: (await nodes.listNodes(tenantId)).length },
        mcp: { servers: mcp.statuses(tenantId).length, connected: mcp.statuses(tenantId).filter((item) => item.status === "connected").length },
        auth: { enabled: config.auth.enabled },
        pendingApprovals: approvalGate.list("pending").filter((item) => item.context.tenantId === tenantId).length,
        planner: {
          schedulerRunning: scheduler.running,
          schedulerIntervalMs: config.scheduler.intervalMs,
          activeReminders: dashboard.stats.activeReminders,
          unreadAlerts: dashboard.stats.unreadAlerts,
        },
        engineer: engineerDashboard.stats,
        time: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/tools") {
      json(res, 200, tools.list().map(({ name, description, risk, parameters }) => ({ name, description, risk, parameters })));
      return;
    }

    if (req.method === "GET" && pathname === "/skills") {
      json(res, 200, { ok: true, skills: (await skills.list()).map(({ name, description }) => ({ name, description })) });
      return;
    }

    if (req.method === "GET" && pathname === "/nodes") {
      json(res, 200, { ok: true, nodes: await nodes.listNodes(tenantId) });
      return;
    }

    if (req.method === "POST" && pathname === "/nodes/pairing-codes") {
      if (config.auth.enabled && requestIdentity?.user.role !== "admin") {
        json(res, 403, { ok: false, error: "Node pairing requires admin role" });
        return;
      }
      const body = await readJson(req);
      const ttlMinutes = typeof body.ttlMinutes === "number" ? body.ttlMinutes : 10;
      const name = optionalString(body, "name");
      const pairing = await nodes.createPairingCode({
        tenantId,
        ...(name ? { name } : {}),
        ttlMs: ttlMinutes * 60_000,
      });
      json(res, 201, { ok: true, pairing });
      return;
    }

    if (req.method === "POST" && pathname === "/nodes/bind") {
      const body = await readJson(req);
      const binding = await nodes.bind(tenantId, chatIdValue(body.chatId), requiredString(body, "nodeId"));
      json(res, 200, { ok: true, binding });
      return;
    }

    if (req.method === "GET" && pathname === "/nodes/binding") {
      const chatId = chatIdValue(url.searchParams.get("chatId"));
      json(res, 200, { ok: true, chatId, ...(await nodes.binding(tenantId, chatId)) });
      return;
    }

    if (req.method === "GET" && pathname === "/mcp/servers") {
      json(res, 200, { ok: true, servers: mcp.statuses(tenantId) });
      return;
    }

    if (req.method === "POST" && pathname === "/mcp/servers") {
      if (config.auth.enabled && requestIdentity?.user.role !== "admin") {
        json(res, 403, { ok: false, error: "MCP server registration requires admin role" });
        return;
      }
      const body = await readJson(req);
      const toolRisks = riskRecord(body.toolRisks);
      const serverStatus = await mcp.add({
        tenantId,
        name: requiredString(body, "name"),
        enabled: body.enabled !== false,
        risk: riskValue(body.risk),
        ...(toolRisks ? { toolRisks } : {}),
        connection: mcpConnection(body),
      });
      json(res, 201, { ok: true, server: serverStatus });
      return;
    }

    const mcpReconnectMatch = pathname.match(/^\/mcp\/servers\/([^/]+)\/reconnect$/);
    if (req.method === "POST" && mcpReconnectMatch) {
      if (config.auth.enabled && requestIdentity?.user.role !== "admin") {
        json(res, 403, { ok: false, error: "MCP server management requires admin role" });
        return;
      }
      const status = await mcp.reconnect(decodeURIComponent(mcpReconnectMatch[1] ?? ""), tenantId);
      json(res, 200, { ok: true, server: status });
      return;
    }

    const mcpServerMatch = pathname.match(/^\/mcp\/servers\/([^/]+)$/);
    if (req.method === "DELETE" && mcpServerMatch) {
      if (config.auth.enabled && requestIdentity?.user.role !== "admin") {
        json(res, 403, { ok: false, error: "MCP server management requires admin role" });
        return;
      }
      const removed = await mcp.remove(decodeURIComponent(mcpServerMatch[1] ?? ""), tenantId);
      json(res, removed ? 200 : 404, { ok: removed });
      return;
    }

    if (req.method === "GET" && pathname === "/linux/ssh") {
      json(res, 200, { ok: true, status: linuxSsh.status() });
      return;
    }

    if (req.method === "POST" && pathname === "/linux/ssh/scan") {
      if (config.auth.enabled && requestIdentity?.user.role !== "admin") {
        json(res, 403, { ok: false, error: "SSH login configuration requires admin role" });
        return;
      }
      const body = await readJson(req);
      const port = body.port === undefined ? undefined : Number(body.port);
      const hostKey = await linuxSsh.scanHostKey(requiredString(body, "host"), port);
      audit.log({
        action: "ssh_host_key_scan",
        ...(requestIdentity ? { userId: requestIdentity.user.id, sessionId: requestIdentity.sessionId } : {}),
        traceId,
        resultStatus: "ok",
        metadata: { host: hostKey.host, port: hostKey.port, keyType: hostKey.keyType, fingerprint: hostKey.fingerprint },
      });
      json(res, 200, { ok: true, hostKey });
      return;
    }

    if (req.method === "POST" && pathname === "/linux/ssh/connect") {
      if (config.auth.enabled && requestIdentity?.user.role !== "admin") {
        json(res, 403, { ok: false, error: "SSH login configuration requires admin role" });
        return;
      }
      const body = await readJson(req);
      const authentication = requiredString(body, "authentication");
      if (!["private-key", "password", "ssh-agent"].includes(authentication)) {
        throw new Error("authentication must be private-key, password, or ssh-agent");
      }
      const result = await linuxSsh.configureAndConnect({
        host: requiredString(body, "host"),
        username: requiredString(body, "username"),
        ...(body.port !== undefined ? { port: Number(body.port) } : {}),
        authentication: authentication as "private-key" | "password" | "ssh-agent",
        ...(typeof body.privateKey === "string" ? { privateKey: body.privateKey } : {}),
        ...(typeof body.password === "string" ? { password: body.password } : {}),
        hostKey: requiredString(body, "hostKey"),
        expectedFingerprint: requiredString(body, "expectedFingerprint"),
      });
      audit.log({
        action: "ssh_profile_connect",
        ...(requestIdentity ? { userId: requestIdentity.user.id, sessionId: requestIdentity.sessionId } : {}),
        traceId,
        resultStatus: "ok",
        metadata: {
          host: result.status.host,
          username: result.status.username,
          port: result.status.port,
          authentication: result.status.authentication,
          fingerprint: result.status.fingerprint,
        },
      });
      json(res, 200, { ok: true, status: result.status, probe: result.probe });
      return;
    }

    if (req.method === "POST" && pathname === "/linux/ssh/login") {
      const result = await linuxSsh.probe();
      json(res, 200, { ok: true, status: result.status, probe: result.probe });
      return;
    }

    if (req.method === "GET" && pathname === "/usage/dashboard") {
      json(res, 200, { ok: true, usage: await usage.dashboard(tenantId) });
      return;
    }

    if (req.method === "GET" && pathname === "/usage/events") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      json(res, 200, { ok: true, events: await usage.listEvents(tenantId, Number.isFinite(limit) ? limit : 100) });
      return;
    }

    if (req.method === "POST" && pathname === "/reports") {
      const upload = await readReportUpload(req);
      reports.validateUpload(upload.fileName, upload.mimeType, upload.buffer);
      const quota = await usage.tryConsume({
        tenantId,
        userId: requestIdentity?.user.id ?? "web-user",
        kind: "report_run",
        units: 20,
        metadata: { feature: "report_upload", fileName: upload.fileName },
      });
      if (!quota.allowed) {
        json(res, 429, { ok: false, error: quota.reason, usage: quota });
        return;
      }
      const record = await reports.create({ tenantId, ...upload });
      json(res, 202, { ok: true, reportId: record.id, runId: record.runId, report: await reports.get(record.id, tenantId) });
      return;
    }

    if (req.method === "POST" && pathname === "/reports/sample") {
      const body = await readJson(req);
      parseReportTemplate(body.template);
      const quota = await usage.tryConsume({
        tenantId,
        userId: requestIdentity?.user.id ?? "web-user",
        kind: "report_run",
        units: 20,
        metadata: { feature: "report_sample" },
      });
      if (!quota.allowed) {
        json(res, 429, { ok: false, error: quota.reason, usage: quota });
        return;
      }
      const record = await reports.createSample(tenantId);
      json(res, 202, { ok: true, reportId: record.id, runId: record.runId, report: await reports.get(record.id, tenantId) });
      return;
    }

    if (req.method === "GET" && pathname === "/reports") {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      json(res, 200, { ok: true, reports: await reports.list(tenantId, Number.isFinite(limit) ? limit : 50) });
      return;
    }

    const reportEventsMatch = pathname.match(/^\/reports\/([^/]+)\/events$/);
    if (req.method === "GET" && reportEventsMatch) {
      const reportId = decodeURIComponent(reportEventsMatch[1] ?? "");
      const report = await reports.get(reportId, tenantId);
      const currentRun = await agenticStore.getRun(report.runId, tenantId);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      let closed = false;
      const send = (event: string, payload: unknown): void => {
        if (closed || res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      send("snapshot", { report, ...(await orchestrationSnapshot(report.runId)) });
      if (currentRun.status !== "running") {
        send("complete", { report });
        res.end();
        return;
      }
      const unsubscribe = agenticStore.subscribe(report.runId, (event) => {
        send("update", event);
        const payload = event.payload as { status?: string } | undefined;
        if (event.type === "run.updated" && payload?.status && payload.status !== "running") {
          setTimeout(async () => {
            if (closed) return;
            try { send("complete", { report: await reports.get(reportId, tenantId) }); } catch { /* connection may have closed */ }
            cleanup();
            res.end();
          }, 50);
        }
      });
      const heartbeat = setInterval(() => send("heartbeat", { at: new Date().toISOString() }), 15_000);
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      return;
    }

    const reportPdfMatch = pathname.match(/^\/reports\/([^/]+)\/pdf$/);
    if (req.method === "GET" && reportPdfMatch) {
      const reportId = decodeURIComponent(reportPdfMatch[1] ?? "");
      const pdf = await reports.pdfPath(reportId, tenantId);
      const body = await readFile(pdf.path);
      const encodedName = encodeURIComponent(pdf.fileName);
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": body.length,
        "content-disposition": `attachment; filename="cherry-report.pdf"; filename*=UTF-8''${encodedName}`,
        "cache-control": "private, no-store",
      });
      res.end(body);
      return;
    }

    const reportMappingMatch = pathname.match(/^\/reports\/([^/]+)\/mapping$/);
    if (req.method === "PATCH" && reportMappingMatch) {
      const reportId = decodeURIComponent(reportMappingMatch[1] ?? "");
      await reports.get(reportId, tenantId);
      const body = await readJson(req);
      const mapping = parseReportMapping(body.mapping ?? body);
      const quota = await usage.tryConsume({
        tenantId,
        userId: requestIdentity?.user.id ?? "web-user",
        kind: "report_run",
        units: 10,
        metadata: { feature: "report_regenerate", reportId },
      });
      if (!quota.allowed) {
        json(res, 429, { ok: false, error: quota.reason, usage: quota });
        return;
      }
      const record = await reports.regenerate(reportId, tenantId, mapping);
      json(res, 202, { ok: true, reportId: record.id, runId: record.runId, report: await reports.get(record.id, tenantId) });
      return;
    }

    const reportMatch = pathname.match(/^\/reports\/([^/]+)$/);
    if (req.method === "GET" && reportMatch) {
      json(res, 200, { ok: true, report: await reports.get(decodeURIComponent(reportMatch[1] ?? ""), tenantId) });
      return;
    }
    if (req.method === "DELETE" && reportMatch) {
      await reports.remove(decodeURIComponent(reportMatch[1] ?? ""), tenantId);
      res.writeHead(204, { "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end();
      return;
    }

    if (req.method === "POST" && pathname === "/usage/budget") {
      if (requestIdentity?.user.role !== "admin") {
        json(res, 403, { ok: false, error: "Usage budget administration requires admin role" });
        return;
      }
      const body = await readJson(req);
      const monthlyCredits = Number(body.monthlyCredits);
      if (!Number.isFinite(monthlyCredits) || monthlyCredits < 1) throw new Error("monthlyCredits must be a positive number");
      json(res, 200, { ok: true, budget: await usage.setBudget(tenantId, monthlyCredits) });
      return;
    }

    if (req.method === "GET" && pathname === "/office/inbox") {
      const rawStatus = url.searchParams.get("status")?.trim();
      const statuses = ["new", "triaged", "ignored"] as const;
      if (rawStatus && !statuses.includes(rawStatus as typeof statuses[number])) throw new Error(`status must be one of: ${statuses.join(", ")}`);
      json(res, 200, { ok: true, items: await officeInbox.list(tenantId, rawStatus as typeof statuses[number] | undefined) });
      return;
    }

    if (req.method === "POST" && pathname === "/office/inbox/sync") {
      const quota = await usage.tryConsume({ tenantId, userId: requestIdentity?.user.id ?? "web-user", kind: "office_inbox", units: 5, metadata: { feature: "gmail_sync" } });
      if (!quota.allowed) {
        json(res, 429, { ok: false, error: quota.reason, usage: quota });
        return;
      }
      const body = await readJson(req);
      const query = optionalString(body, "query");
      const result = await officeInbox.sync({
        tenantId,
        ...(query ? { query } : {}),
        ...(typeof body.maxResults === "number" ? { maxResults: body.maxResults } : {}),
      });
      json(res, 200, { ok: true, ...result });
      return;
    }

    const officeInboxActionMatch = pathname.match(/^\/office\/inbox\/([^/]+)\/(triage|ignore)$/);
    if (req.method === "POST" && officeInboxActionMatch) {
      const inboxId = decodeURIComponent(officeInboxActionMatch[1] ?? "");
      const action = officeInboxActionMatch[2];
      if (action === "ignore") {
        json(res, 200, { ok: true, item: await officeInbox.ignore(inboxId, tenantId) });
        return;
      }
      const body = await readJson(req);
      const title = optionalString(body, "title");
      const description = optionalString(body, "description");
      const dueAt = optionalString(body, "dueAt");
      const tags = stringArray(body.tags);
      const quota = await usage.tryConsume({ tenantId, userId: requestIdentity?.user.id ?? "web-user", kind: "office_inbox", units: 2, metadata: { feature: "inbox_triage" } });
      if (!quota.allowed) {
        json(res, 429, { ok: false, error: quota.reason, usage: quota });
        return;
      }
      const priority = optionalString(body, "priority");
      const priorities = ["low", "normal", "high", "urgent"] as const;
      if (priority && !priorities.includes(priority as typeof priorities[number])) throw new Error(`priority must be one of: ${priorities.join(", ")}`);
      const result = await officeInbox.triage({
        tenantId,
        inboxId,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(dueAt ? { dueAt } : {}),
        ...(priority ? { priority: priority as typeof priorities[number] } : {}),
        ...(tags ? { tags } : {}),
      });
      json(res, 201, { ok: true, ...result });
      return;
    }

    if (req.method === "POST" && channelWebhookMatch) {
      const channelName = decodeURIComponent(channelWebhookMatch[1] ?? "");
      const rawBody = await readRawBody(req);
      const result = await channelGateway.handleWebhook(channelName, {
        method: req.method,
        headers: requestHeaders(req),
        rawBody,
        query: requestQuery(url),
      });
      json(res, result.ok ? 200 : 207, result);
      return;
    }

    if (req.method === "GET" && pathname === "/engineer/dashboard") {
      json(res, 200, { ok: true, dashboard: await engineer.getDashboard(tenantId) });
      return;
    }

    if (req.method === "POST" && pathname === "/orchestrator/runs") {
      const body = await readJson(req);
      const preferredRoles = parseOrchestrationRoles(body.preferredRoles);
      const tags = stringArray(body.tags);
      const quota = await usage.tryConsume({
        tenantId,
        userId: requestIdentity?.user.id ?? "web-user",
        kind: "workflow_run",
        units: 10,
        metadata: { feature: "deploy_flow" },
      });
      if (!quota.allowed) {
        json(res, 429, { ok: false, error: quota.reason, usage: quota });
        return;
      }
      const run = await orchestrator.startGoal(
        {
          goal: requiredString(body, "goal"),
          tenantId,
          ...(preferredRoles?.length ? { preferredRoles } : {}),
          ...(tags?.length ? { tags } : {}),
          traceId,
        },
        {
          sessionId: requestIdentity?.sessionId ?? crypto.randomUUID(),
          userId: requestIdentity?.user.id ?? "web-user",
          tenantId,
          workspaceRoot: resolve(config.workspaceRoot, tenantId),
        },
      );
      json(res, 202, { ok: true, runId: run.id, run });
      return;
    }

    if (req.method === "GET" && pathname === "/orchestrator/runs") {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      json(res, 200, { ok: true, runs: await orchestrator.listRuns(Number.isFinite(limit) ? limit : 50, tenantId) });
      return;
    }

    const orchestrationStreamMatch = pathname.match(/^\/orchestrator\/runs\/([^/]+)\/events$/);
    if (req.method === "GET" && orchestrationStreamMatch) {
      const runId = decodeURIComponent(orchestrationStreamMatch[1] ?? "");
      await orchestrator.getRun(runId, tenantId);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      let closed = false;
      const send = (event: string, payload: unknown): void => {
        if (closed || res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      send("snapshot", await orchestrationSnapshot(runId));
      const unsubscribe = agenticStore.subscribe(runId, (event) => {
        send("update", event);
        const payload = event.payload as { status?: string } | undefined;
        if (event.type === "run.updated" && payload?.status && payload.status !== "running") {
          setTimeout(() => {
            if (closed) return;
            cleanup();
            res.end();
          }, 25);
        }
      });
      const heartbeat = setInterval(() => send("heartbeat", { at: new Date().toISOString() }), 15_000);
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      return;
    }

    const orchestrationLogsMatch = pathname.match(/^\/orchestrator\/runs\/([^/]+)\/logs$/);
    if (req.method === "GET" && orchestrationLogsMatch) {
      const runId = decodeURIComponent(orchestrationLogsMatch[1] ?? "");
      await orchestrator.getRun(runId, tenantId);
      const limit = Number(url.searchParams.get("limit") ?? "500");
      const since = Number(url.searchParams.get("since") ?? "0");
      const taskId = url.searchParams.get("taskId") || undefined;
      json(res, 200, {
        ok: true,
        logs: await agenticStore.listLogs({
          runId,
          ...(taskId ? { taskId } : {}),
          ...(Number.isFinite(since) && since > 0 ? { since } : {}),
          limit: Number.isFinite(limit) ? limit : 500,
        }),
      });
      return;
    }

    const orchestrationRunMatch = pathname.match(/^\/orchestrator\/runs\/([^/]+)$/);
    if (req.method === "GET" && orchestrationRunMatch) {
      const runId = decodeURIComponent(orchestrationRunMatch[1] ?? "");
      const run = await orchestrator.getRun(runId, tenantId);
      json(res, 200, { ok: true, ...(await orchestrationSnapshot(run.id)) });
      return;
    }

    if (req.method === "GET" && pathname === "/engineer/loops") {
      const status = parseEngineerStatus(url.searchParams.get("status"));
      json(res, 200, { ok: true, loops: await engineer.listLoops(status, tenantId) });
      return;
    }

    if (req.method === "POST" && pathname === "/engineer/loops") {
      const body = await readJson(req);
      const loop = await engineer.startLoop({
        tenantId,
        objective: requiredString(body, "objective"),
        successCriteria: stringArray(body.successCriteria) ?? [],
        ...(typeof body.maxIterations === "number" ? { maxIterations: body.maxIterations } : {}),
        ...(optionalString(body, "planItemId") ? { planItemId: optionalString(body, "planItemId") } : {}),
        ...(optionalString(body, "hypothesis") ? { hypothesis: optionalString(body, "hypothesis") } : {}),
      });
      json(res, 201, { ok: true, loop });
      return;
    }

    const engineerLoopMatch = pathname.match(/^\/engineer\/loops\/([^/]+)$/);
    if (req.method === "GET" && engineerLoopMatch) {
      json(res, 200, { ok: true, loop: await engineer.getLoop(decodeURIComponent(engineerLoopMatch[1] ?? ""), tenantId) });
      return;
    }

    const engineerPhaseMatch = pathname.match(/^\/engineer\/loops\/([^/]+)\/phase$/);
    if (req.method === "POST" && engineerPhaseMatch) {
      const body = await readJson(req);
      const evidence = stringArray(body.evidence);
      const nextPhase = parseOptionalEngineerPhase(body.nextPhase);
      const loop = await engineer.recordPhase({
        loopId: decodeURIComponent(engineerPhaseMatch[1] ?? ""),
        tenantId,
        phase: parseEngineerPhase(body.phase),
        summary: requiredString(body, "summary"),
        ...(evidence ? { evidence } : {}),
        ...(optionalString(body, "tool") ? { tool: optionalString(body, "tool") } : {}),
        ...(optionalString(body, "error") ? { error: optionalString(body, "error") } : {}),
        ...(nextPhase ? { nextPhase } : {}),
      });
      json(res, 200, { ok: true, loop });
      return;
    }

    const engineerIterationMatch = pathname.match(/^\/engineer\/loops\/([^/]+)\/next-iteration$/);
    if (req.method === "POST" && engineerIterationMatch) {
      const body = await readJson(req);
      const loop = await engineer.nextIteration({
        loopId: decodeURIComponent(engineerIterationMatch[1] ?? ""),
        tenantId,
        diagnosis: requiredString(body, "diagnosis"),
        nextAction: requiredString(body, "nextAction"),
      });
      json(res, 200, { ok: true, loop });
      return;
    }

    const engineerActionMatch = pathname.match(/^\/engineer\/loops\/([^/]+)\/(block|resume|fail|abort)$/);
    if (req.method === "POST" && engineerActionMatch) {
      const id = decodeURIComponent(engineerActionMatch[1] ?? "");
      const action = engineerActionMatch[2];
      const body = await readJson(req);
      if (action === "block") {
        json(res, 200, { ok: true, loop: await engineer.blockLoop(id, requiredString(body, "reason"), tenantId) });
        return;
      }
      if (action === "resume") {
        json(res, 200, { ok: true, loop: await engineer.resumeLoop(id, optionalString(body, "note"), tenantId) });
        return;
      }
      if (action === "fail") {
        json(res, 200, { ok: true, loop: await engineer.failLoop(id, requiredString(body, "reason"), tenantId) });
        return;
      }
      json(res, 200, { ok: true, loop: await engineer.abortLoop(id, requiredString(body, "reason"), tenantId) });
      return;
    }

    const engineerCompleteMatch = pathname.match(/^\/engineer\/loops\/([^/]+)\/complete$/);
    if (req.method === "POST" && engineerCompleteMatch) {
      const body = await readJson(req);
      const prevention = stringArray(body.prevention);
      const result = await engineer.completeLoop({
        loopId: decodeURIComponent(engineerCompleteMatch[1] ?? ""),
        tenantId,
        outcome: requiredString(body, "outcome"),
        rootCause: requiredString(body, "rootCause"),
        fix: requiredString(body, "fix"),
        ...(optionalString(body, "rollback") ? { rollback: optionalString(body, "rollback") } : {}),
        ...(prevention ? { prevention } : {}),
        ...(optionalString(body, "runbookTitle") ? { runbookTitle: optionalString(body, "runbookTitle") } : {}),
      });
      json(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "GET" && pathname === "/engineer/runbooks") {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      json(res, 200, { ok: true, runbooks: await engineer.listRunbooks(Number.isFinite(limit) ? limit : 50, tenantId) });
      return;
    }

    if (req.method === "GET" && pathname === "/planner/dashboard") {
      json(res, 200, { ok: true, dashboard: await planner.getDashboard(new Date(), tenantId) });
      return;
    }

    if (req.method === "GET" && pathname === "/planner/items") {
      const status = parseStatus(url.searchParams.get("status"));
      const flowId = url.searchParams.get("flowId")?.trim() || undefined;
      json(res, 200, { ok: true, items: await planner.listItems({ ...(status ? { status } : {}), ...(flowId ? { flowId } : {}), tenantId }) });
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
        tenantId,
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
      }, tenantId);
      json(res, 200, { ok: true, item });
      return;
    }

    const dependencyMatch = pathname.match(/^\/planner\/items\/([^/]+)\/dependencies$/);
    if (req.method === "POST" && dependencyMatch) {
      const body = await readJson(req);
      const item = await planner.addDependency(decodeURIComponent(dependencyMatch[1] ?? ""), requiredString(body, "dependencyId"), tenantId);
      json(res, 200, { ok: true, item });
      return;
    }

    if (req.method === "GET" && pathname === "/planner/reminders") {
      const enabledParam = url.searchParams.get("enabled");
      const enabled = enabledParam === "true" ? true : enabledParam === "false" ? false : undefined;
      json(res, 200, { ok: true, reminders: await planner.listReminders(enabled, tenantId) });
      return;
    }

    if (req.method === "POST" && pathname === "/planner/reminders") {
      const body = await readJson(req);
      const channels = parseChannels(body.channels);
      const reminder = await planner.createReminder({
        title: requiredString(body, "title"),
        tenantId,
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
      const reminder = await planner.setReminderEnabled(decodeURIComponent(reminderEnabledMatch[1] ?? ""), body.enabled, tenantId);
      json(res, 200, { ok: true, reminder });
      return;
    }

    if (req.method === "GET" && pathname === "/planner/alerts") {
      const unreadOnly = url.searchParams.get("unread") === "true";
      const limit = Number(url.searchParams.get("limit") ?? "100");
      json(res, 200, { ok: true, alerts: await planner.listAlerts({ unreadOnly, limit: Number.isFinite(limit) ? limit : 100, tenantId }) });
      return;
    }

    const alertActionMatch = pathname.match(/^\/planner\/alerts\/([^/]+)\/(read|snooze)$/);
    if (req.method === "POST" && alertActionMatch) {
      const id = decodeURIComponent(alertActionMatch[1] ?? "");
      const action = alertActionMatch[2];
      if (action === "read") {
        json(res, 200, { ok: true, alert: await planner.markAlertRead(id, tenantId) });
        return;
      }
      const body = await readJson(req);
      const minutes = Number(body.minutes);
      json(res, 200, { ok: true, alert: await planner.snoozeAlert(id, minutes, tenantId) });
      return;
    }

    if (req.method === "POST" && pathname === "/planner/scheduler/tick") {
      json(res, 200, { ok: true, tick: await scheduler.tick() });
      return;
    }

    if (req.method === "GET" && pathname === "/chat/logs") {
      const rawLimit = Number(url.searchParams.get("limit") ?? "100");
      const requestedChatId = url.searchParams.get("chatId")?.trim() || undefined;
      const entries = await chatLogs.list({
        tenantId,
        ...(requestedChatId ? { chatId: chatIdValue(requestedChatId) } : {}),
        ...(Number.isFinite(rawLimit) ? { limit: rawLimit } : {}),
      });
      json(res, 200, { ok: true, chatId: requestedChatId ?? null, entries });
      return;
    }

    if (req.method === "GET" && pathname === "/chat/history") {
      const chatId = chatIdValue(url.searchParams.get("chatId"));
      json(res, 200, { ok: true, chatId, messages: await chatSessions.history(tenantId, chatId) });
      return;
    }

    if (req.method === "DELETE" && pathname === "/chat/history") {
      const chatId = chatIdValue(url.searchParams.get("chatId"));
      json(res, 200, { ok: true, chatId, removed: await chatSessions.clear(tenantId, chatId) });
      return;
    }

    if (req.method === "GET" && pathname === "/approvals") {
      const approvals = approvalGate.list("pending").filter((item) =>
        item.context.tenantId === tenantId
          && (!requestIdentity || requestIdentity.user.role === "admin" || item.context.userId === requestIdentity.user.id),
      );
      json(res, 200, { ok: true, approvals: approvals.map(publicApproval) });
      return;
    }

    const approvalAction = pathname.match(/^\/approvals\/([^/]+)\/(approve|deny)$/);
    if (req.method === "POST" && approvalAction) {
      const id = decodeURIComponent(approvalAction[1] ?? "");
      const action = approvalAction[2];
      const pending = approvalGate.get(id);
      if (
        !pending
        || pending.context.tenantId !== tenantId
        || (requestIdentity && requestIdentity.user.role !== "admin" && pending.context.userId !== requestIdentity.user.id)
      ) {
        if (requestIdentity) audit.log({
          action: "rbac_deny",
          userId: requestIdentity.user.id,
          sessionId: requestIdentity.sessionId,
          path: pathname,
          method: req.method ?? "UNKNOWN",
          resultStatus: "denied",
          metadata: { resource: "approval", approvalId: id },
        });
        json(res, 403, { ok: false, error: "You cannot manage this approval" });
        return;
      }

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

      const chatId = chatIdValue(body.chatId ?? body.sessionId);
      const sessionId = chatId;
      const userId = requestIdentity?.user.id ?? "web-user";
      const startedAt = Date.now();
      try {
        const result = await agent.run(message, {
          sessionId,
          userId,
          tenantId,
          traceId,
        });
        let logStored = true;
        try {
          await chatLogs.append({
            id: traceId,
            chatId,
            traceId,
            sessionId,
            tenantId,
            userId,
            status: "succeeded",
            createdAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            steps: result.steps,
            correctness: {
              status: result.correctness.status,
              confidence: result.correctness.confidence,
              passes: result.correctness.passes,
            },
          });
        } catch (error) {
          logStored = false;
          console.warn(`[ChatLogStore] failed to persist ${traceId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        json(res, 200, {
          ok: true,
          chatId,
          logId: traceId,
          traceId,
          logStored,
          ...result,
        });
      } catch (error) {
        try {
          await chatLogs.append({
            id: traceId,
            chatId,
            traceId,
            sessionId,
            tenantId,
            userId,
            status: "failed",
            createdAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (logError) {
          console.warn(`[ChatLogStore] failed to persist failed request ${traceId}: ${logError instanceof Error ? logError.message : String(logError)}`);
        }
        throw error;
      }
      return;
    }

    if (await serveStatic(req, res)) return;
    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") || message.startsWith("Unknown channel adapter")
      ? 404
      : message.startsWith("File exceeds")
        ? 413
        : message.startsWith("Only ") || message.startsWith("Legacy ") || message.startsWith("Executable ") || message.startsWith("Macro-enabled ") || message.includes("signature") || message.includes("content type") || message.includes("MIME")
          ? 415
      : message.startsWith("Webhook verification failed")
        ? 401
        : message.startsWith("Channel adapter is not configured")
          ? 503
          : message.startsWith("Unknown approval") || message.includes("cannot be")
            ? 409
            : 400;
    json(res, status, { ok: false, error: message });
  }
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`CherryAgent is running at http://${config.server.host}:${config.server.port}`);
  console.log(`Loaded ${tools.list().length} tools for model ${config.llm.model}`);
  console.log(`Google Workspace configured: ${connectors.google ? "yes" : "no"}`);
  console.log(`Channel adapters: ${connectors.channels.map((channel) => `${channel.name}=${channel.configured ? "ready" : "not-configured"}`).join(", ") || "none"}`);
  console.log(`Planner scheduler interval: ${config.scheduler.intervalMs} ms`);
  console.log(`Engineer Loop Engine state: ${config.engineerFile}`);
});
