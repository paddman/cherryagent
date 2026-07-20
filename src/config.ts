import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RiskLevel } from "./core/types.js";

function loadDotEnv(path = ".env"): void {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return;

  for (const rawLine of readFileSync(absolute, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

const knownRisks = new Set<RiskLevel>(["safe", "write", "external", "dangerous"]);
const autoApprove = new Set<RiskLevel>(
  (process.env.CHERRY_AUTO_APPROVE ?? "safe,write")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is RiskLevel => knownRisks.has(item as RiskLevel)),
);

const googleAccessToken = optionalEnv("CHERRY_GOOGLE_ACCESS_TOKEN");
const googleClientId = optionalEnv("CHERRY_GOOGLE_CLIENT_ID");
const googleClientSecret = optionalEnv("CHERRY_GOOGLE_CLIENT_SECRET");
const googleRefreshToken = optionalEnv("CHERRY_GOOGLE_REFRESH_TOKEN");

const proxmoxBaseUrl = optionalEnv("CHERRY_PROXMOX_BASE_URL");
const proxmoxTokenId = optionalEnv("CHERRY_PROXMOX_TOKEN_ID");
const proxmoxTokenSecret = optionalEnv("CHERRY_PROXMOX_TOKEN_SECRET");
const vsphereBaseUrl = optionalEnv("CHERRY_VSPHERE_BASE_URL");
const vsphereUsername = optionalEnv("CHERRY_VSPHERE_USERNAME");
const vspherePassword = optionalEnv("CHERRY_VSPHERE_PASSWORD");

const postgresUrl = optionalEnv("CHERRY_DB_POSTGRES_URL");
const mysqlUrl = optionalEnv("CHERRY_DB_MYSQL_URL");
const sqlitePath = optionalEnv("CHERRY_DB_SQLITE_PATH");
const redisUrl = optionalEnv("CHERRY_DB_REDIS_URL");

const lineChannelSecret = optionalEnv("CHERRY_LINE_CHANNEL_SECRET");
const lineChannelAccessToken = optionalEnv("CHERRY_LINE_CHANNEL_ACCESS_TOKEN")
  ?? optionalEnv("CHERRY_NOTIFY_LINE_CHANNEL_ACCESS_TOKEN");

export const config = {
  llm: {
    baseUrl: (process.env.CHERRY_LLM_BASE_URL ?? "http://127.0.0.1:8000/v1").replace(/\/$/, ""),
    apiKey: process.env.CHERRY_LLM_API_KEY ?? "local",
    model: process.env.CHERRY_LLM_MODEL ?? "qwen3.6-27b",
  },
  agent: {
    maxSteps: integerEnv("CHERRY_MAX_STEPS", 24),
    correctnessMaxPasses: Math.min(5, Math.max(1, integerEnv("CHERRY_CORRECTNESS_MAX_PASSES", 3))),
    autoApprove,
  },
  agentic: {
    file: resolve(process.env.CHERRY_AGENTIC_FILE ?? ".cherry/agentic.json"),
    maxTasks: Math.min(20, Math.max(1, integerEnv("CHERRY_AGENTIC_MAX_TASKS", 8))),
    maxRounds: Math.min(5, Math.max(1, integerEnv("CHERRY_AGENTIC_MAX_ROUNDS", 2))),
    concurrency: Math.min(8, Math.max(1, integerEnv("CHERRY_AGENTIC_CONCURRENCY", 3))),
    subAgentMaxSteps: Math.min(30, Math.max(1, integerEnv("CHERRY_SUBAGENT_MAX_STEPS", 10))),
  },
  cognition: {
    file: resolve(process.env.CHERRY_COGNITIVE_FILE ?? ".cherry/cognition.json"),
    maxContextEpisodes: Math.min(50, Math.max(1, integerEnv("CHERRY_COGNITIVE_MAX_CONTEXT_EPISODES", 12))),
    maxContextBeliefs: Math.min(100, Math.max(1, integerEnv("CHERRY_COGNITIVE_MAX_CONTEXT_BELIEFS", 20))),
    maxContextSkills: Math.min(100, Math.max(1, integerEnv("CHERRY_COGNITIVE_MAX_CONTEXT_SKILLS", 20))),
  },
  google: {
    accessToken: googleAccessToken,
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    refreshToken: googleRefreshToken,
    tokenEndpoint: optionalEnv("CHERRY_GOOGLE_TOKEN_ENDPOINT") ?? "https://oauth2.googleapis.com/token",
    configured: Boolean(
      googleAccessToken || (googleClientId && googleClientSecret && googleRefreshToken),
    ),
  },
  channels: {
    line: {
      channelSecret: lineChannelSecret,
      channelAccessToken: lineChannelAccessToken,
      configured: Boolean(lineChannelSecret && lineChannelAccessToken),
    },
  },
  infra: {
    timeoutMs: Math.max(1_000, integerEnv("CHERRY_INFRA_TIMEOUT_MS", 20_000)),
    proxmox: {
      baseUrl: proxmoxBaseUrl,
      tokenId: proxmoxTokenId,
      tokenSecret: proxmoxTokenSecret,
      rejectUnauthorized: booleanEnv("CHERRY_PROXMOX_VERIFY_TLS", true),
      configured: Boolean(proxmoxBaseUrl && proxmoxTokenId && proxmoxTokenSecret),
    },
    vsphere: {
      baseUrl: vsphereBaseUrl,
      username: vsphereUsername,
      password: vspherePassword,
      rejectUnauthorized: booleanEnv("CHERRY_VSPHERE_VERIFY_TLS", true),
      configured: Boolean(vsphereBaseUrl && vsphereUsername && vspherePassword),
    },
  },
  database: {
    timeoutMs: Math.max(1_000, integerEnv("CHERRY_DB_TIMEOUT_MS", 30_000)),
    maxOutputBytes: Math.max(4_096, integerEnv("CHERRY_DB_MAX_OUTPUT_BYTES", 1_000_000)),
    postgresUrl,
    mysqlUrl,
    sqlitePath,
    redisUrl,
  },
  markets: {
    timeoutMs: Math.max(1_000, integerEnv("CHERRY_MARKET_TIMEOUT_MS", 20_000)),
    newsLanguage: optionalEnv("CHERRY_MARKET_NEWS_LANGUAGE") ?? "th",
    newsCountry: optionalEnv("CHERRY_MARKET_NEWS_COUNTRY") ?? "TH",
  },
  trading: {
    binance: {
      apiKey: optionalEnv("CHERRY_BINANCE_API_KEY"),
      apiSecret: optionalEnv("CHERRY_BINANCE_API_SECRET"),
    },
    mexc: {
      apiKey: optionalEnv("CHERRY_MEXC_API_KEY"),
      apiSecret: optionalEnv("CHERRY_MEXC_API_SECRET"),
    },
    bitkub: {
      apiKey: optionalEnv("CHERRY_BITKUB_API_KEY"),
      apiSecret: optionalEnv("CHERRY_BITKUB_API_SECRET"),
    },
    xt: {
      appKey: optionalEnv("CHERRY_XT_APP_KEY"),
      secretKey: optionalEnv("CHERRY_XT_SECRET_KEY"),
    },
  },
  notifications: {
    emailTo: optionalEnv("CHERRY_NOTIFY_EMAIL_TO"),
    slackWebhookUrl: optionalEnv("CHERRY_NOTIFY_SLACK_WEBHOOK"),
    webhookUrl: optionalEnv("CHERRY_NOTIFY_WEBHOOK_URL"),
    lineChannelAccessToken: optionalEnv("CHERRY_NOTIFY_LINE_CHANNEL_ACCESS_TOKEN"),
    lineTo: optionalEnv("CHERRY_NOTIFY_LINE_TO"),
  },
  memoryFile: resolve(process.env.CHERRY_MEMORY_FILE ?? ".cherry/memory.json"),
  plannerFile: resolve(process.env.CHERRY_PLANNER_FILE ?? ".cherry/planner.json"),
  engineerFile: resolve(process.env.CHERRY_ENGINEER_FILE ?? ".cherry/engineer.json"),
  usageFile: resolve(process.env.CHERRY_USAGE_FILE ?? ".cherry/usage.json"),
  officeInboxFile: resolve(process.env.CHERRY_OFFICE_INBOX_FILE ?? ".cherry/office-inbox.json"),
  reports: {
    file: resolve(process.env.CHERRY_REPORT_FILE ?? ".cherry/reports.json"),
    retentionDays: Math.max(1, integerEnv("CHERRY_REPORT_RETENTION_DAYS", 30)),
    maxBytes: Math.max(1_000_000, integerEnv("CHERRY_REPORT_MAX_BYTES", 20 * 1024 * 1024)),
    maxRows: Math.max(100, integerEnv("CHERRY_REPORT_MAX_ROWS", 100_000)),
    maxColumns: Math.max(2, integerEnv("CHERRY_REPORT_MAX_COLUMNS", 100)),
    modelTimeoutMs: Math.max(1_000, integerEnv("CHERRY_REPORT_MODEL_TIMEOUT_MS", 25_000)),
  },
  chatLogs: {
    file: resolve(process.env.CHERRY_CHAT_LOG_FILE ?? ".cherry/chat-logs.json"),
    maxEntries: Math.max(100, integerEnv("CHERRY_CHAT_LOG_MAX_ENTRIES", 10_000)),
  },
  chatSessions: {
    file: resolve(process.env.CHERRY_CHAT_SESSION_FILE ?? ".cherry/chat-sessions.json"),
    maxMessages: Math.max(10, integerEnv("CHERRY_CHAT_SESSION_MAX_MESSAGES", 80)),
    maxMessageBytes: Math.max(1_000, integerEnv("CHERRY_CHAT_SESSION_MAX_MESSAGE_BYTES", 24_000)),
  },
  nodes: {
    file: resolve(process.env.CHERRY_NODE_FILE ?? ".cherry/nodes.json"),
    onlineWindowMs: Math.max(5_000, integerEnv("CHERRY_NODE_ONLINE_WINDOW_MS", 30_000)),
    taskTimeoutMs: Math.max(1_000, integerEnv("CHERRY_NODE_TASK_TIMEOUT_MS", 60_000)),
  },
  mcp: {
    file: resolve(process.env.CHERRY_MCP_SERVER_FILE ?? ".cherry/mcp-servers.json"),
  },
  skillsDirectory: resolve(process.env.CHERRY_SKILLS_DIRECTORY ?? "skills"),
  linuxSsh: {
    profileFile: resolve(process.env.CHERRY_LINUX_SSH_PROFILE_FILE ?? ".cherry/ssh/profile.json"),
    keyDirectory: resolve(process.env.CHERRY_LINUX_SSH_KEY_DIRECTORY ?? ".cherry/ssh"),
  },
  scheduler: {
    intervalMs: Math.max(1_000, integerEnv("CHERRY_SCHEDULER_INTERVAL_MS", 15_000)),
  },
  workspaceRoot: resolve(process.env.CHERRY_WORKSPACE ?? "workspace"),
  server: {
    host: process.env.CHERRY_HOST ?? "0.0.0.0",
    port: integerEnv("CHERRY_PORT", 8787),
  },
  auth: {
    enabled: booleanEnv("CHERRY_AUTH_ENABLED", true),
    file: resolve(process.env.CHERRY_AUTH_FILE ?? ".cherry/auth.json"),
    adminEmail: optionalEnv("CHERRY_AUTH_ADMIN_EMAIL") ?? "padd@cherrydeskx.com",
    adminName: optionalEnv("CHERRY_AUTH_ADMIN_NAME") ?? "Cherry Admin",
    adminPassword: optionalEnv("CHERRY_AUTH_ADMIN_PASSWORD"),
    sessionTtlMs: Math.max(5, integerEnv("CHERRY_AUTH_SESSION_TTL_MINUTES", 480)) * 60_000,
  },
} as const;
