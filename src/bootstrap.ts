import { mkdir } from "node:fs/promises";
import { CherryAgent } from "./agent/CherryAgent.js";
import { config } from "./config.js";
import { GoogleAuth } from "./connectors/google/GoogleAuth.js";
import { GoogleWorkspaceClient } from "./connectors/google/GoogleWorkspaceClient.js";
import { OpenAICompatibleProvider } from "./llm/OpenAICompatibleProvider.js";
import { MemoryStore } from "./memory/MemoryStore.js";
import { PlannerStore } from "./planner/PlannerStore.js";
import { SchedulerEngine } from "./planner/SchedulerEngine.js";
import { ApprovalGate } from "./safety/ApprovalGate.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { fileTools } from "./tools/builtin/files.js";
import { createGoogleWorkspaceTools } from "./tools/builtin/googleWorkspace.js";
import { createOfficeTools } from "./tools/builtin/office.js";
import { createPlannerTools } from "./tools/builtin/planner.js";
import { systemTools } from "./tools/builtin/system.js";

export async function createRuntime(): Promise<{
  agent: CherryAgent;
  tools: ToolRegistry;
  memory: MemoryStore;
  planner: PlannerStore;
  scheduler: SchedulerEngine;
  approvalGate: ApprovalGate;
  connectors: { google: boolean };
}> {
  await mkdir(config.workspaceRoot, { recursive: true });

  const approvalGate = new ApprovalGate(config.agent.autoApprove);
  const tools = new ToolRegistry(approvalGate);
  const memory = new MemoryStore(config.memoryFile);
  const planner = new PlannerStore(config.plannerFile);

  const googleAuth = new GoogleAuth({
    ...(config.google.accessToken ? { accessToken: config.google.accessToken } : {}),
    ...(config.google.clientId ? { clientId: config.google.clientId } : {}),
    ...(config.google.clientSecret ? { clientSecret: config.google.clientSecret } : {}),
    ...(config.google.refreshToken ? { refreshToken: config.google.refreshToken } : {}),
    tokenEndpoint: config.google.tokenEndpoint,
  });
  const google = new GoogleWorkspaceClient(googleAuth);

  for (const tool of [
    ...systemTools,
    ...fileTools,
    ...createOfficeTools(memory),
    ...createPlannerTools(planner),
    ...createGoogleWorkspaceTools(google),
  ]) {
    tools.register(tool);
  }

  const scheduler = new SchedulerEngine(planner, {
    intervalMs: config.scheduler.intervalMs,
    onAlert: (alert) => {
      console.log(`[planner-alert] ${alert.title}: ${alert.message}`);
    },
  });
  scheduler.start();

  const provider = new OpenAICompatibleProvider(config.llm);
  const agent = new CherryAgent(provider, tools, {
    maxSteps: config.agent.maxSteps,
    workspaceRoot: config.workspaceRoot,
  });

  return {
    agent,
    tools,
    memory,
    planner,
    scheduler,
    approvalGate,
    connectors: { google: google.isConfigured() },
  };
}
