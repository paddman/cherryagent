import { mkdir } from "node:fs/promises";
import { CherryAgent } from "./agent/CherryAgent.js";
import { config } from "./config.js";
import { OpenAICompatibleProvider } from "./llm/OpenAICompatibleProvider.js";
import { MemoryStore } from "./memory/MemoryStore.js";
import { ApprovalGate } from "./safety/ApprovalGate.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { fileTools } from "./tools/builtin/files.js";
import { createOfficeTools } from "./tools/builtin/office.js";
import { systemTools } from "./tools/builtin/system.js";

export async function createRuntime(): Promise<{
  agent: CherryAgent;
  tools: ToolRegistry;
  memory: MemoryStore;
}> {
  await mkdir(config.workspaceRoot, { recursive: true });

  const approvalGate = new ApprovalGate(config.agent.autoApprove);
  const tools = new ToolRegistry(approvalGate);
  const memory = new MemoryStore(config.memoryFile);

  for (const tool of [...systemTools, ...fileTools, ...createOfficeTools(memory)]) {
    tools.register(tool);
  }

  const provider = new OpenAICompatibleProvider(config.llm);
  const agent = new CherryAgent(provider, tools, {
    maxSteps: config.agent.maxSteps,
    workspaceRoot: config.workspaceRoot,
  });

  return { agent, tools, memory };
}
