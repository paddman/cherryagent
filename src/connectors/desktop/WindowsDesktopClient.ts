import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DesktopMouseButton = "left" | "right" | "middle";

export type DesktopBridgeStatus = {
  ok: boolean;
  platform: string;
  bridgeVersion: string;
  automationEnabled: boolean;
  visionEnabled: boolean;
  speechEnabled: boolean;
};

export type DesktopMonitor = {
  index: number;
  name: string;
  isPrimary: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
};

export type DesktopWindow = {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
};

export type DesktopCapture = {
  mimeType: "image/png";
  imageBase64: string;
  width: number;
  height: number;
  monitorIndex: number;
  capturedAt: string;
};

export type WindowsDesktopClientOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
};

function discoverLocalBridgeToken(): string | undefined {
  const root = process.env.LOCALAPPDATA?.trim();
  if (!root) return undefined;
  try {
    const token = readFileSync(join(root, "CherryAgent", "desktop-bridge.token"), "utf8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export class WindowsDesktopClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly configuredToken: string | undefined;

  constructor(options: WindowsDesktopClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.configuredToken = options.token;
  }

  configured(): boolean {
    return Boolean(this.baseUrl);
  }

  async status(): Promise<DesktopBridgeStatus> {
    return await this.request<DesktopBridgeStatus>("/health", "GET");
  }

  async listMonitors(): Promise<DesktopMonitor[]> {
    const result = await this.request<{ monitors: DesktopMonitor[] }>("/v1/monitors", "GET");
    return result.monitors;
  }

  async listWindows(): Promise<DesktopWindow[]> {
    const result = await this.request<{ windows: DesktopWindow[] }>("/v1/windows", "GET");
    return result.windows;
  }

  async captureScreen(monitorIndex = 0): Promise<DesktopCapture> {
    return await this.request<DesktopCapture>("/v1/screen/capture", "POST", { monitorIndex });
  }

  async moveMouse(x: number, y: number, relative = false): Promise<unknown> {
    return await this.request("/v1/mouse/move", "POST", { x, y, relative });
  }

  async click(button: DesktopMouseButton = "left", clicks = 1): Promise<unknown> {
    return await this.request("/v1/mouse/click", "POST", { button, clicks });
  }

  async typeText(text: string): Promise<unknown> {
    return await this.request("/v1/keyboard/type", "POST", { text });
  }

  async pressKey(key: string, modifiers: string[] = []): Promise<unknown> {
    return await this.request("/v1/keyboard/key", "POST", { key, modifiers });
  }

  async speak(text: string): Promise<unknown> {
    return await this.request("/v1/speech/speak", "POST", { text });
  }

  async listen(timeoutMs = 10_000): Promise<{ text: string; timeoutMs: number }> {
    return await this.request("/v1/speech/listen", "POST", { timeoutMs });
  }

  private async request<T = unknown>(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const token = this.configuredToken ?? discoverLocalBridgeToken();

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const raw = await response.text();
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        parsed = { message: raw };
      }

      if (!response.ok) {
        const message = parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `${response.status} ${response.statusText}`;
        throw new Error(`Desktop bridge ${method} ${path} failed: ${message}`);
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Desktop bridge ${method} ${path} timed out after ${this.timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
