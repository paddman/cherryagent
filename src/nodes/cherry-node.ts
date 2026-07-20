import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch, hostname, homedir, platform, release, totalmem, uptime, userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { NodeTask, NodeTaskResult } from "./CherryNodeGateway.js";

type NodeProfile = {
  gatewayUrl: string;
  token: string;
  nodeId: string;
  nodeName: string;
};

const gatewayUrl = (process.env.CHERRY_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const nodeName = process.env.CHERRY_NODE_NAME?.trim() || hostname();
const workspace = resolve(process.env.CHERRY_NODE_WORKSPACE ?? process.cwd());
const allowSystemPaths = ["1", "true", "yes", "on"].includes((process.env.CHERRY_NODE_ALLOW_SYSTEM_PATHS ?? "false").toLowerCase());
const profileFile = resolve(process.env.CHERRY_NODE_PROFILE_FILE ?? resolve(homedir(), ".cherry-node/profile.json"));
const maxOutputBytes = Math.max(4_096, Number.parseInt(process.env.CHERRY_NODE_MAX_OUTPUT_BYTES ?? "1000000", 10));
const capabilities = ["system_info", "process_list", "read_file", "write_file", "exec"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function nodePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("path is required");
  const target = resolve(workspace, value);
  if (!allowSystemPaths) {
    const rel = relative(workspace, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path is outside Cherry Node workspace: ${value}`);
  }
  return target;
}

async function loadProfile(): Promise<NodeProfile | undefined> {
  try {
    return JSON.parse(await readFile(profileFile, "utf8")) as NodeProfile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveProfile(profile: NodeProfile): Promise<void> {
  await mkdir(dirname(profileFile), { recursive: true, mode: 0o700 });
  const temporaryPath = `${profileFile}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(profile, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, profileFile);
  await chmod(profileFile, 0o600);
}

async function request(path: string, profile: NodeProfile, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${profile.gatewayUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Node ${profile.token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `Gateway returned HTTP ${response.status}`);
  return payload;
}

async function pair(): Promise<NodeProfile> {
  const pairingCode = process.env.CHERRY_NODE_PAIRING_CODE?.trim();
  if (!pairingCode) throw new Error(`No node profile at ${profileFile}. Set CHERRY_NODE_PAIRING_CODE once to pair this machine.`);
  const response = await fetch(`${gatewayUrl}/nodes/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: pairingCode,
      name: nodeName,
      platform: platform(),
      arch: arch(),
      version: "0.1.0",
      capabilities,
      workspace,
    }),
  });
  const payload = await response.json() as { token?: string; node?: { id?: string; name?: string }; error?: string };
  if (!response.ok || !payload.token || !payload.node?.id) throw new Error(payload.error ?? `Pairing failed with HTTP ${response.status}`);
  const profile = { gatewayUrl, token: payload.token, nodeId: payload.node.id, nodeName: payload.node.name ?? nodeName };
  await saveProfile(profile);
  return profile;
}

async function executeCommand(command: string, cwd: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (bytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - bytes;
      const kept = chunk.subarray(0, remaining);
      target.push(kept);
      bytes += kept.byteLength;
      if (kept.byteLength < chunk.byteLength) truncated = true;
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
      });
    });
  });
}

async function executeTask(task: NodeTask): Promise<NodeTaskResult> {
  try {
    const args = task.args;
    switch (task.operation) {
      case "system_info":
        return { ok: true, output: { hostname: hostname(), platform: platform(), release: release(), arch: arch(), user: userInfo().username, uptimeSeconds: Math.floor(uptime()), totalMemoryBytes: totalmem(), workspace, allowSystemPaths } };
      case "process_list": {
        const command = platform() === "win32" ? "tasklist" : "ps -eo pid,ppid,user,stat,etime,command";
        return { ok: true, output: await executeCommand(command, workspace, 15_000) };
      }
      case "read_file": {
        const path = nodePath(args.path);
        const maxBytes = typeof args.maxBytes === "number" ? Math.min(1_000_000, Math.max(1, args.maxBytes)) : maxOutputBytes;
        const data = await readFile(path);
        return { ok: true, output: { path, content: data.subarray(0, maxBytes).toString("utf8"), truncated: data.byteLength > maxBytes, bytes: data.byteLength } };
      }
      case "write_file": {
        const path = nodePath(args.path);
        if (typeof args.content !== "string") throw new Error("content must be a string");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, args.content, "utf8");
        return { ok: true, output: { path, bytes: Buffer.byteLength(args.content, "utf8") } };
      }
      case "exec": {
        if (typeof args.command !== "string" || !args.command.trim()) throw new Error("command is required");
        const cwd = args.cwd === undefined ? workspace : nodePath(args.cwd);
        const timeoutMs = typeof args.timeoutMs === "number" ? Math.min(600_000, Math.max(1_000, args.timeoutMs)) : 60_000;
        return { ok: true, output: await executeCommand(args.command, cwd, timeoutMs) };
      }
      default:
        throw new Error(`Unsupported node operation: ${task.operation}`);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  let profile = await loadProfile();
  if (!profile) profile = await pair();
  console.log(`[cherry-node] connected profile=${profile.nodeName} gateway=${profile.gatewayUrl} workspace=${workspace}`);
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  while (!stopping) {
    try {
      const payload = await request("/nodes/agent/poll", profile, {});
      const task = payload.task as NodeTask | null | undefined;
      if (!task) {
        await sleep(750);
        continue;
      }
      const result = await executeTask(task);
      await request(`/nodes/agent/tasks/${encodeURIComponent(task.id)}/complete`, profile, { result });
    } catch (error) {
      console.error(`[cherry-node] ${error instanceof Error ? error.message : String(error)}`);
      await sleep(2_000);
    }
  }
}

await main();
