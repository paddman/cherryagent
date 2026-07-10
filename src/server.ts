import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createRuntime } from "./bootstrap.js";
import { config } from "./config.js";
import type { PendingApproval } from "./safety/ApprovalGate.js";

const publicRoot = resolve(process.cwd(), "public");
const { agent, tools, approvalGate, connectors } = await createRuntime();

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
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      json(res, 200, {
        ok: true,
        name: "CherryAgent",
        model: config.llm.model,
        tools: tools.list().length,
        connectors,
        pendingApprovals: approvalGate.list("pending").length,
        time: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/tools") {
      json(
        res,
        200,
        tools.list().map(({ name, description, risk, parameters }) => ({ name, description, risk, parameters })),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/approvals") {
      json(res, 200, {
        ok: true,
        approvals: approvalGate.list("pending").map(publicApproval),
      });
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
      json(res, result.ok ? 200 : 502, {
        ok: result.ok,
        approval: publicApproval(completed),
        result,
      });
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
    const status = message.startsWith("Unknown approval") || message.includes("cannot be") ? 409 : 500;
    json(res, status, { ok: false, error: message });
  }
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`CherryAgent is running at http://${config.server.host}:${config.server.port}`);
  console.log(`Loaded ${tools.list().length} tools for model ${config.llm.model}`);
  console.log(`Google Workspace configured: ${connectors.google ? "yes" : "no"}`);
});
