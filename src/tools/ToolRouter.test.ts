import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "../core/types.js";
import { routeToolNames } from "./ToolRouter.js";

function tool(name: string): AgentTool {
  return {
    name,
    description: name,
    risk: "safe",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ ok: true }),
  };
}

test("matched intent prefixes are prioritized over registry order", () => {
  const tools = [
    ...Array.from({ length: 100 }, (_value, index) => tool(`system_noise_${index}`)),
    tool("skill_search"),
    tool("skill_read"),
  ];

  const routed = routeToolNames("ค้นหา skill และ runbook ที่เคยเรียนรู้", tools);
  assert.equal(routed.has("skill_search"), true);
  assert.equal(routed.has("skill_read"), true);
  assert.equal(routed.size, 72);
  assert.deepEqual([...routed].slice(0, 2), ["skill_search", "skill_read"]);
});

test("unavailable tool prefixes stay excluded even when they are preferred", () => {
  const routed = routeToolNames(
    "rerank RAG documents",
    [tool("ai_rerank"), tool("skill_search"), tool("system_current_time")],
    ["ai_"],
  );

  assert.equal(routed.has("ai_rerank"), false);
  assert.equal(routed.has("skill_search"), true);
});
