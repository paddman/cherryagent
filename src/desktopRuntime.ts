import { DesktopVisionClient } from "./connectors/desktop/DesktopVisionClient.js";
import { WindowsDesktopClient } from "./connectors/desktop/WindowsDesktopClient.js";
import type { AgentTool } from "./core/types.js";
import { createDesktopTools } from "./tools/builtin/desktop.js";

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

export type DesktopRuntimeStatus = {
  enabled: boolean;
  bridgeUrl: string;
  visionModel: string;
};

export function getDesktopRuntimeStatus(): DesktopRuntimeStatus {
  const enabled = booleanEnv("CHERRY_DESKTOP_ENABLED", process.platform === "win32");
  return {
    enabled,
    bridgeUrl: (process.env.CHERRY_DESKTOP_BRIDGE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, ""),
    visionModel: process.env.CHERRY_VISION_MODEL ?? process.env.CHERRY_LLM_MODEL ?? "qwen3.6-27b",
  };
}

export function createDesktopRuntimeTools(): AgentTool[] {
  const status = getDesktopRuntimeStatus();
  if (!status.enabled) return [];

  const llmBaseUrl = (process.env.CHERRY_LLM_BASE_URL ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "");
  const llmApiKey = process.env.CHERRY_LLM_API_KEY ?? "local";

  const desktop = new WindowsDesktopClient({
    baseUrl: status.bridgeUrl,
    ...(process.env.CHERRY_DESKTOP_BRIDGE_TOKEN?.trim()
      ? { token: process.env.CHERRY_DESKTOP_BRIDGE_TOKEN.trim() }
      : {}),
    timeoutMs: Math.max(1_000, integerEnv("CHERRY_DESKTOP_TIMEOUT_MS", 20_000)),
  });

  const vision = new DesktopVisionClient({
    baseUrl: (process.env.CHERRY_VISION_BASE_URL ?? llmBaseUrl).replace(/\/$/, ""),
    apiKey: process.env.CHERRY_VISION_API_KEY ?? llmApiKey,
    model: status.visionModel,
    timeoutMs: Math.max(1_000, integerEnv("CHERRY_VISION_TIMEOUT_MS", 60_000)),
  });

  return createDesktopTools(desktop, vision);
}
