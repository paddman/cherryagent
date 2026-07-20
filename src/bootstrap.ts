import { mkdir } from "node:fs/promises";
import { CherryAgent } from "./agent/CherryAgent.js";
import { AgentHandoffProtocol } from "./agentic/AgentHandoffProtocol.js";
import { AgentOrchestrator } from "./agentic/AgentOrchestrator.js";
import { AgenticStateStore } from "./agentic/AgenticStateStore.js";
import { SharedEvidenceBus } from "./agentic/SharedEvidenceBus.js";
import { ChannelGateway } from "./channels/ChannelGateway.js";
import { LineAdapter } from "./channels/line/LineAdapter.js";
import type { ChannelAdapterStatus } from "./channels/types.js";
import { ChatLogStore } from "./chat/ChatLogStore.js";
import { CognitiveEngine } from "./cognition/CognitiveEngine.js";
import { CognitiveStore } from "./cognition/CognitiveStore.js";
import { config } from "./config.js";
import { DatabaseCliHub } from "./connectors/database/DatabaseCliHub.js";
import { BidPilotEngine } from "./connectors/documents/BidPilotEngine.js";
import { bidPilotConfig } from "./connectors/documents/config.js";
import { GoogleAuth } from "./connectors/google/GoogleAuth.js";
import { GoogleWorkspaceClient } from "./connectors/google/GoogleWorkspaceClient.js";
import { MarketIntelligenceClient } from "./connectors/market/MarketIntelligenceClient.js";
import { ProxmoxClient } from "./connectors/proxmox/ProxmoxClient.js";
import { CryptoExchangeHub } from "./connectors/trading/CryptoExchangeHub.js";
import { VsphereClient } from "./connectors/vsphere/VsphereClient.js";
import { EngineerLoopEngine } from "./engineer/EngineerLoopEngine.js";
import { getLinuxRuntimeProfiles, initializeLinuxRuntime } from "./linuxRuntime.js";
import { OpenAICompatibleProvider } from "./llm/OpenAICompatibleProvider.js";
import { MemoryStore } from "./memory/MemoryStore.js";
import { NotificationDispatcher } from "./planner/NotificationDispatcher.js";
import { PlannerStore } from "./planner/PlannerStore.js";
import { SchedulerEngine } from "./planner/SchedulerEngine.js";
import { ApprovalGate } from "./safety/ApprovalGate.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { UsageStore } from "./usage/UsageStore.js";
import { OfficeInboxStore } from "./office/OfficeInboxStore.js";
import { OfficeInboxService } from "./office/OfficeInboxService.js";
import { ReportStore } from "./reports/ReportStore.js";
import { ReportStudioService } from "./reports/ReportStudioService.js";
import { createAgenticTools } from "./tools/builtin/agentic.js";
import { createBidPilotTools } from "./tools/builtin/bidpilot.js";
import { createCognitionTools } from "./tools/builtin/cognition.js";
import { createDatabaseTools } from "./tools/builtin/database.js";
import { createEngineerTools } from "./tools/builtin/engineer.js";
import { fileTools } from "./tools/builtin/files.js";
import { createGoogleWorkspaceTools } from "./tools/builtin/googleWorkspace.js";
import { createInfraTools } from "./tools/builtin/infra.js";
import { createMarketTools } from "./tools/builtin/markets.js";
import { createOfficeTools } from "./tools/builtin/office.js";
import { createPlannerTools } from "./tools/builtin/planner.js";
import { createReportTools } from "./tools/builtin/reports.js";
import { systemTools } from "./tools/builtin/system.js";

export type RuntimeConnectors = {
  google: boolean;
  infra: {
    proxmox: boolean;
    vsphere: boolean;
  };
  database: {
    postgres: boolean;
    mysql: boolean;
    sqlite: boolean;
    redis: boolean;
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
  channels: ChannelAdapterStatus[];
};

export async function createRuntime(): Promise<{
  agent: CherryAgent;
  tools: ToolRegistry;
  memory: MemoryStore;
  planner: PlannerStore;
  engineer: EngineerLoopEngine;
  agenticStore: AgenticStateStore;
  cognitionStore: CognitiveStore;
  cognition: CognitiveEngine;
  evidence: SharedEvidenceBus;
  handoffs: AgentHandoffProtocol;
  orchestrator: AgentOrchestrator;
  scheduler: SchedulerEngine;
  approvalGate: ApprovalGate;
  usage: UsageStore;
  officeInbox: OfficeInboxService;
  reports: ReportStudioService;
  chatLogs: ChatLogStore;
  linuxSsh: ReturnType<typeof getLinuxRuntimeProfiles>;
  channelGateway: ChannelGateway;
  connectors: RuntimeConnectors;
}> {
  await mkdir(config.workspaceRoot, { recursive: true });
  await initializeLinuxRuntime();

  const approvalGate = new ApprovalGate(config.agent.autoApprove);
  const usage = new UsageStore(config.usageFile);
  const chatLogs = new ChatLogStore(config.chatLogs.file, config.chatLogs.maxEntries);
  const tools = new ToolRegistry(approvalGate, undefined, usage);
  const memory = new MemoryStore(config.memoryFile);
  const planner = new PlannerStore(config.plannerFile);
  const engineer = new EngineerLoopEngine(config.engineerFile);
  const agenticStore = new AgenticStateStore(config.agentic.file);
  await agenticStore.recoverInterruptedRuns();
  const cognitionStore = new CognitiveStore(config.cognition.file);
  const evidence = new SharedEvidenceBus(agenticStore);
  const handoffs = new AgentHandoffProtocol(agenticStore);
  const bidPilot = new BidPilotEngine(bidPilotConfig);

  const googleAuth = new GoogleAuth({
    ...(config.google.accessToken ? { accessToken: config.google.accessToken } : {}),
    ...(config.google.clientId ? { clientId: config.google.clientId } : {}),
    ...(config.google.clientSecret ? { clientSecret: config.google.clientSecret } : {}),
    ...(config.google.refreshToken ? { refreshToken: config.google.refreshToken } : {}),
    tokenEndpoint: config.google.tokenEndpoint,
  });
  const google = new GoogleWorkspaceClient(googleAuth);
  const officeInbox = new OfficeInboxService(new OfficeInboxStore(config.officeInboxFile), google, planner);
  const provider = new OpenAICompatibleProvider(config.llm);
  const reports = new ReportStudioService(
    new ReportStore(config.reports.file),
    agenticStore,
    provider,
    { workspaceRoot: config.workspaceRoot, retentionDays: config.reports.retentionDays, maxBytes: config.reports.maxBytes, maxRows: config.reports.maxRows, maxColumns: config.reports.maxColumns, modelTimeoutMs: config.reports.modelTimeoutMs },
  );
  await reports.pruneExpired();
  await reports.recoverInterrupted();

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

  const database = new DatabaseCliHub({
    timeoutMs: config.database.timeoutMs,
    maxOutputBytes: config.database.maxOutputBytes,
    ...(config.database.postgresUrl ? { postgresUrl: config.database.postgresUrl } : {}),
    ...(config.database.mysqlUrl ? { mysqlUrl: config.database.mysqlUrl } : {}),
    ...(config.database.sqlitePath ? { sqlitePath: config.database.sqlitePath } : {}),
    ...(config.database.redisUrl ? { redisUrl: config.database.redisUrl } : {}),
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
    ...createBidPilotTools(bidPilot),
    ...createOfficeTools(memory),
    ...createPlannerTools(planner),
    ...createReportTools(reports),
    ...createEngineerTools(engineer),
    ...createInfraTools(proxmox, vsphere),
    ...createDatabaseTools(database),
    ...createMarketTools(exchanges, market),
    ...createGoogleWorkspaceTools(google),
  ]) {
    tools.register(tool);
  }

  const orchestrator = new AgentOrchestrator(provider, agenticStore, evidence, handoffs, tools, {
    maxTasks: config.agentic.maxTasks,
    maxRounds: config.agentic.maxRounds,
    concurrency: config.agentic.concurrency,
    subAgentMaxSteps: config.agentic.subAgentMaxSteps,
  });

  for (const tool of createAgenticTools({ orchestrator, store: agenticStore, evidence, handoffs })) {
    tools.register(tool);
  }

  const cognition = new CognitiveEngine(provider, orchestrator, tools, cognitionStore, {
    maxContextEpisodes: config.cognition.maxContextEpisodes,
    maxContextBeliefs: config.cognition.maxContextBeliefs,
    maxContextSkills: config.cognition.maxContextSkills,
  });
  for (const tool of createCognitionTools(cognition, cognitionStore)) {
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

  const agent = new CherryAgent(provider, tools, {
    maxSteps: config.agent.maxSteps,
    correctnessMaxPasses: config.agent.correctnessMaxPasses,
    workspaceRoot: config.workspaceRoot,
    unavailableToolPrefixes: [
      ...(!google.isConfigured() ? ["gmail_", "calendar_", "drive_"] : []),
      ...(!proxmox.isConfigured() ? ["proxmox_"] : []),
      ...(!vsphere.isConfigured() ? ["vsphere_"] : []),
      ...(!config.database.postgresUrl && !config.database.mysqlUrl && !config.database.sqlitePath && !config.database.redisUrl ? ["db_"] : []),
    ],
  });

  const channelGateway = new ChannelGateway(async (message) => {
    const attachmentContext = message.attachments?.length
      ? `\n\nAttachments: ${message.attachments.map((attachment) => attachment.name ?? attachment.type).join(", ")}`
      : "";
    const userMessage = `${message.text.trim()}${attachmentContext}`.trim();
    if (!userMessage) return { suppressReply: true };

    const sessionParts = ["channel", message.channel, message.conversationId];
    if (message.threadId) sessionParts.push(message.threadId);

    const result = await agent.run(userMessage, {
      sessionId: sessionParts.join(":"),
      userId: `${message.channel}:${message.senderId}`,
      tenantId: "org-default",
    });

    return {
      text: result.answer,
      metadata: {
        steps: result.steps,
        correctness: result.correctness.status,
      },
    };
  });

  channelGateway.register(new LineAdapter({
    ...(config.channels.line.channelSecret ? { channelSecret: config.channels.line.channelSecret } : {}),
    ...(config.channels.line.channelAccessToken ? { channelAccessToken: config.channels.line.channelAccessToken } : {}),
  }));

  return {
    agent,
    tools,
    memory,
    planner,
    engineer,
    agenticStore,
    cognitionStore,
    cognition,
    evidence,
    handoffs,
    orchestrator,
    scheduler,
    approvalGate,
    usage,
    officeInbox,
    reports,
    chatLogs,
    linuxSsh: getLinuxRuntimeProfiles(),
    channelGateway,
    connectors: {
      google: google.isConfigured(),
      infra: {
        proxmox: proxmox.isConfigured(),
        vsphere: vsphere.isConfigured(),
      },
      database: database.configured(),
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
      channels: channelGateway.listAdapters(),
    },
  };
}
