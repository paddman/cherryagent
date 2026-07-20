import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentSessionStore } from "../src/chat/AgentSessionStore.js";
import { McpServerStore } from "../src/mcp/McpServerStore.js";
import { McpToolHub } from "../src/mcp/McpToolHub.js";
import { CherryNodeGateway } from "../src/nodes/CherryNodeGateway.js";
import { ApprovalGate } from "../src/safety/ApprovalGate.js";
import { AgentSkillLoader } from "../src/skills/AgentSkillLoader.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cherry-gateway-test-"));
}

test("Chat ID history persists bounded redacted turns", async () => {
  const directory = await temporaryDirectory();
  try {
    const path = join(directory, "sessions.json");
    const store = new AgentSessionStore(path, 4, 4_000);
    await store.appendTurn({
      tenantId: "tenant-a",
      chatId: "chat-a",
      userId: "user-a",
      userMessage: "deploy with password=hunter2",
      assistantMessage: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    });
    await store.appendTurn({
      tenantId: "tenant-a",
      chatId: "chat-a",
      userId: "user-a",
      userMessage: "verify it",
      assistantMessage: "verified",
    });

    const history = await store.history("tenant-a", "chat-a");
    assert.equal(history.length, 4);
    assert.match(history[0]?.content ?? "", /password=\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(history), /hunter2|abcdefghijklmnopqrstuvwxyz/);
    assert.equal((await new AgentSessionStore(path).history("tenant-a", "chat-a")).length, 4);
    assert.match(await readFile(path, "utf8"), /\[REDACTED\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired Cherry Node receives a Chat ID task and returns evidence", async () => {
  const directory = await temporaryDirectory();
  try {
    const gateway = new CherryNodeGateway(join(directory, "nodes.json"), 30_000, 5_000);
    const pairing = await gateway.createPairingCode({ tenantId: "tenant-a", name: "test-node" });
    const paired = await gateway.pair({
      code: pairing.code,
      name: "reported-name",
      platform: "linux",
      arch: "x64",
      version: "test",
      capabilities: ["system_info"],
    });

    const dispatched = gateway.dispatch({
      tenantId: "tenant-a",
      chatId: "chat-a",
      operation: "system_info",
      capability: "system_info",
      args: {},
    });

    let task;
    for (let attempt = 0; attempt < 30 && !task; attempt += 1) {
      task = await gateway.poll(paired.node.id);
      if (!task) await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.ok(task);
    await gateway.complete(paired.node.id, task.id, { ok: true, output: { hostname: "fixture" } });
    const result = await dispatched;
    assert.deepEqual(result.result.output, { hostname: "fixture" });
    assert.equal((await gateway.binding("tenant-a", "chat-a")).node?.id, paired.node.id);
    assert.equal((await gateway.authenticate(paired.token))?.id, paired.node.id);
    await assert.rejects(() => gateway.pair({
      code: pairing.code,
      name: "replay",
      platform: "linux",
      arch: "x64",
      version: "test",
      capabilities: [],
    }), /invalid or expired/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP stdio server becomes a namespaced Cherry tool", async () => {
  const directory = await temporaryDirectory();
  const tools = new ToolRegistry(new ApprovalGate(new Set(["safe", "write", "external", "dangerous"])));
  const hub = new McpToolHub(new McpServerStore(join(directory, "mcp.json")), tools);
  try {
    const status = await hub.add({
      tenantId: "tenant-a",
      name: "echo-test",
      risk: "external",
      connection: {
        transport: "stdio",
        command: process.execPath,
        args: [resolve("tests/fixtures/mcp-echo-server.mjs")],
      },
    });
    assert.equal(status.status, "connected");
    assert.equal(status.tools.length, 1);
    const toolName = status.tools[0];
    assert.ok(toolName?.startsWith("mcp_echo-test_"));
    const result = await tools.execute(toolName ?? "", { value: "hello Cherry" }, {
      tenantId: "tenant-a",
      sessionId: "chat-a",
      userId: "user-a",
      workspaceRoot: directory,
    });
    assert.equal(result.ok, true);
    assert.match(JSON.stringify(result.output), /hello Cherry/);
  } finally {
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime skill loader selects Cherry node operations skill", async () => {
  const loader = new AgentSkillLoader(resolve("skills"));
  const prompt = await loader.promptFor("เชื่อมต่อเซิร์ฟเวอร์แล้วตรวจ process ผ่าน Cherry Node");
  assert.match(prompt ?? "", /cherry-node-operator/);
  assert.match(prompt ?? "", /node_process_list/);
});
