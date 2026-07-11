import { mkdir } from "node:fs/promises";
import { CherryAgent } from "./agent/CherryAgent.js";
import { config } from "./config.js";
import { GoogleAuth } from "./connectors/google/GoogleAuth.js";
import { GoogleWorkspaceClient } from "./connectors/google/GoogleWorkspaceClient.js";
import { MarketIntelligenceClient } from "./connectors/market/MarketIntelligenceClient.js";
import { ProxmoxClient } from "./connectors/proxmox/ProxmoxClient.js";
import { CryptoExchangeHub } from "./connectors/trading/CryptoExchangeHub.js";
import { VsphereClient } from "./connectors/vsphere/VsphereClient.js";
import { EngineerLoopEngine } from "./engineer/EngineerLoopEngine.js";
import { OpenAICompatibleProvider } from "./llm/OpenAICompatibleProvider.js";
import { MemoryStore } from "./memory/MemoryStore.js";
import { NotificationDispatcher } from "./planner/NotificationDispatcher.js";
import { PlannerStore } from "./planner/PlannerStore.js";
import { SchedulerEngine } from "./planner/SchedulerEngine.js";
import { ApprovalGate } from "./safety/ApprovalGate.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { createEngineerTools } from "./tools/builtin/engineer.js";
import { fileTools } from "./tools/builtin/files.js";
import { createGoogleWorkspaceTools } from "./tools/builtin/googleWorkspace.js";
import { createInfraTools } from "./tools/builtin/infra.js";
import { createMarketTools } from "./tools/builtin/markets.js";
import { createOfficeTools } from "./tools/builtin/office.js";
import { createPlannerTools } from "./tools/builtin/planner.js";
import { systemTools } from "./tools/builtin/system.js";

export type RuntimeConnectors = {
  google: boolean;
  infra: {
    proxmox: boolean;
    vsphere: boolean;
  };
  trading: {
    binance: boolean;
    mexc: boolean;
    bitkub: boolean;
    xt: boolean;
  };
  markets: {
    stocks: true;
    news: true;
    financials: true;
    cryptoMarketData: true;
  };
  notifications: {
    inApp: true;
    browser: true;
    email: boolean;
    line: boolean;
    slack: boolean;
    webhook: boolean;
  };
};

export async function createRuntime(): Promise<{
  agent: CherryAgent;
  tools: ToolRegistry;
  memory: MemoryStore;
  planner: PlannerStore;
  engineer: EngineerLoopEngine;
  scheduler: SchedulerEngine;
  approvalGate: ApprovalGate;
  connectors: RuntimeConnectors;
}> {
  await mkdir(config.workspaceRoot, { recursive: true });

  const approvalGate = new ApprovalGate(config.agent.autoApprove);
  const tools = new ToolRegistry(approvalGate);
  const memory = new MemoryStore(config.memoryFile);
  const planner = new PlannerStore(config.plannerFile);
  const engineer = new EngineerLoopEngine(config.engineerFile);

  const googleAuth = new GoogleAuth({
    ...(config.google.accessToken ? { accessToken: config.google.accessToken } : {}),
    ...(config.google.clientId ? { clientId: config.google.clientId } : {}),
    ...(config.google.clientSecret ? { clientSecret: config.google.clientSecret } : {}),
    ...(config.google.refreshToken ? { refreshToken: config.google.refreshToken } : {}),
    tokenEndpoint: config.google.tokenEndpoint,
  });
  const google = new GoogleWorkspaceClient(googleAuth);

  const proxmox = new ProxmoxClient({
    baseUrl: config.infra.proxmox.baseUrl ?? "",
    tokenId: config.infra.proxmox.tokenId ?? "",
    tokenSecret: config.infra.proxmox.tokenSecret ?? "",
    rejectUnauthorized: config.infra.proxmox.rejectUnauthorized,
    timeoutMs: config.infra.timeoutMs,
  });

  const vsphere = new VsphereClient({
    baseUrl: config.infra.vsphere.baseUrl ?? "",
    username: config.infra.vsphere.username ?? "",
    password: config.infra.vsphere.password ?? "",
    rejectUnauthorized: config.infra.vsphere.rejectUnauthorized,
    timeoutMs: config.infra.timeoutMs,
  });

  const market = new MarketIntelligenceClient({
    timeoutMs: config.markets.timeoutMs,
    newsLanguage: config.markets.newsLanguage,
    newsCountry: config.markets.newsCountry,
  });

  const exchanges = new CryptoExchangeHub({
    timeoutMs: config.markets.timeoutMs,
    binance: {
      ...(config.trading.binance.apiKey ? { apiKey: config.trading.binance.apiKey } : {}),
      ...(config.trading.binance.apiSecret ? { apiSecret: config.trading.binance.apiSecret } : {}),
    },
    mexc: {
      ...(config.trading.mexc.apiKey ? { apiKey: config.trading.mexc.apiKey } : {}),
      ...(config.trading.mexc.apiSecret ? { apiSecret: config.trading.mexc.apiSecret } : {}),
    },
    bitkub: {
      ...(config.trading.bitkub.apiKey ? { apiKey: config.trading.bitkub.apiKey } : {}),
      ...(config.trading.bitkub.apiSecret ? { apiSecret: config.trading.bitkub.apiSecret } : {}),
    },
    xt: {
      ...(config.trading.xt.appKey ? { appKey: config.trading.xt.appKey } : {}),
      ...(config.trading.xt.secretKey ? { secretKey: config.trading.xt.secretKey } : {}),
    },
  });

  for (const tool of [
    ...systemTools,
    ...fileTools,
    ...createOfficeTools(memory),
    ...createPlannerTools(planner),
    ...createEngineerTools(engineer),
    ...createInfraTools(proxmox, vsphere),
    ...createMarketTools(exchanges, market),
    ...createGoogleWorkspaceTools(google),
  ]) {
    tools.register(tool);
  }

  const dispatcher = new NotificationDispatcher(google, {
    ...(config.notifications.emailTo ? { emailTo: config.notifications.emailTo } : {}),
    ...(config.notifications.slackWebhookUrl ? { slackWebhookUrl: config.notifications.slackWebhookUrl } : {}),
    ...(config.notifications.webhookUrl ? { webhookUrl: config.notifications.webhookUrl } : {}),
    ...(config.notifications.lineChannelAccessToken ? { lineChannelAccessToken: config.notifications.lineChannelAccessToken } : {}),
    ...(config.notifications.lineTo ? { lineTo: config.notifications.lineTo } : {}),
  });

  const scheduler = new SchedulerEngine(planner, {
    intervalMs: config.scheduler.intervalMs,
    onAlert: async (alert, reminder) => {
      const results = await dispatcher.dispatch(alert, reminder);
      for (const result of results) {
        const state = result.ok ? "ok" : result.skipped ? "skipped" : "failed";
        console.log(`[planner-alert:${result.channel}:${state}] ${alert.title} · ${result.detail}`);
      }
    },
  });
  scheduler.start();

  const provider = new OpenAICompatibleProvider(config.llm);
  const agent = new CherryAgent(provider, tools, {
    maxSteps: config.agent.maxSteps,
    correctnessMaxPasses: config.agent.correctnessMaxPasses,
    workspaceRoot: config.workspaceRoot,
  });

  return {
    agent,
    tools,
    memory,
    planner,
    engineer,
    scheduler,
    approvalGate,
    connectors: {
      google: google.isConfigured(),
      infra: {
        proxmox: proxmox.isConfigured(),
        vsphere: vsphere.isConfigured(),
      },
      trading: exchanges.configured(),
      markets: {
        stocks: true,
        news: true,
        financials: true,
        cryptoMarketData: true,
      },
      notifications: {
        inApp: true,
        browser: true,
        email: google.isConfigured() && Boolean(config.notifications.emailTo),
        line: Boolean(config.notifications.lineChannelAccessToken && config.notifications.lineTo),
        slack: Boolean(config.notifications.slackWebhookUrl),
        webhook: Boolean(config.notifications.webhookUrl),
      },
    },
  };
}
