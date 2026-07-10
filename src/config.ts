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

export const config = {
  llm: {
    baseUrl: (process.env.CHERRY_LLM_BASE_URL ?? "http://127.0.0.1:8000/v1").replace(/\/$/, ""),
    apiKey: process.env.CHERRY_LLM_API_KEY ?? "local",
    model: process.env.CHERRY_LLM_MODEL ?? "qwen3.6-27b",
  },
  agent: {
    maxSteps: integerEnv("CHERRY_MAX_STEPS", 24),
    autoApprove,
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
  scheduler: {
    intervalMs: Math.max(1_000, integerEnv("CHERRY_SCHEDULER_INTERVAL_MS", 15_000)),
  },
  workspaceRoot: resolve(process.env.CHERRY_WORKSPACE ?? "workspace"),
  server: {
    host: process.env.CHERRY_HOST ?? "0.0.0.0",
    port: integerEnv("CHERRY_PORT", 8787),
  },
} as const;
