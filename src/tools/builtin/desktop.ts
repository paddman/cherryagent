import type { AgentTool } from "../../core/types.js";
import type { DesktopVisionClient } from "../../connectors/desktop/DesktopVisionClient.js";
import type { DesktopMouseButton, WindowsDesktopClient } from "../../connectors/desktop/WindowsDesktopClient.js";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(args: Record<string, unknown>, key: string, fallback?: number): number {
  const raw = args[key];
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function boolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  return value;
}

function stringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a string array`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function mouseButton(value: unknown): DesktopMouseButton {
  if (value === undefined) return "left";
  if (value === "left" || value === "right" || value === "middle") return value;
  throw new Error("button must be left, right, or middle");
}

export function createDesktopTools(
  desktop: WindowsDesktopClient,
  vision: DesktopVisionClient,
): AgentTool[] {
  return [
    {
      name: "desktop_get_status",
      description: "Check whether the local Windows desktop bridge is reachable and which native capabilities are available.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => desktop.status(),
    },
    {
      name: "desktop_list_monitors",
      description: "List attached monitors and their geometry. This does not capture screen content.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => desktop.listMonitors(),
    },
    {
      name: "desktop_list_windows",
      description: "Read visible window titles and geometry from the local desktop. Window titles may contain sensitive information.",
      risk: "external",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => desktop.listWindows(),
    },
    {
      name: "desktop_capture_screen",
      description: "Capture one monitor through the local Windows bridge. Returns metadata only to the agent; raw pixels are not echoed into the answer. Use for evidence and visual inspection with explicit approval.",
      risk: "external",
      parameters: {
        type: "object",
        properties: { monitorIndex: { type: "number", description: "Zero-based monitor index. Default 0." } },
        additionalProperties: false,
      },
      execute: async (args) => {
        const capture = await desktop.captureScreen(integer(args, "monitorIndex", 0));
        return {
          mimeType: capture.mimeType,
          width: capture.width,
          height: capture.height,
          monitorIndex: capture.monitorIndex,
          capturedAt: capture.capturedAt,
          imageBytesApprox: Math.floor((capture.imageBase64.length * 3) / 4),
        };
      },
    },
    {
      name: "desktop_vision_analyze",
      description: "Capture the selected monitor and ask the configured multimodal model to describe visible UI, warnings, text, and actionable targets. Never treats inferred coordinates or hidden state as verified facts.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          monitorIndex: { type: "number" },
          prompt: { type: "string", description: "What to inspect in the screenshot." },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const capture = await desktop.captureScreen(integer(args, "monitorIndex", 0));
        return await vision.analyze(
          capture,
          optionalString(args, "prompt") ?? "Describe the visible desktop state, important UI elements, warnings, and actionable targets.",
        );
      },
    },
    {
      name: "desktop_move_mouse",
      description: "Move the local Windows mouse cursor to absolute screen coordinates or by a relative delta. This changes local desktop state and requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          relative: { type: "boolean" },
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      execute: async (args) => desktop.moveMouse(integer(args, "x"), integer(args, "y"), boolean(args, "relative", false)),
    },
    {
      name: "desktop_click",
      description: "Click the local Windows mouse. A click can trigger external actions, purchases, deletion, sends, or destructive UI operations, so approval is required by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          button: { type: "string", enum: ["left", "right", "middle"] },
          clicks: { type: "number", description: "Number of clicks, 1-3." },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const clicks = integer(args, "clicks", 1);
        if (clicks < 1 || clicks > 3) throw new Error("clicks must be between 1 and 3");
        return await desktop.click(mouseButton(args.button), clicks);
      },
    },
    {
      name: "desktop_type_text",
      description: "Type Unicode text into the currently focused application on the local Windows desktop. Requires approval because the focused target may be external or consequential.",
      risk: "external",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (args) => desktop.typeText(requiredString(args, "text")),
    },
    {
      name: "desktop_press_key",
      description: "Press a named key with optional modifiers such as control, alt, shift, or meta on the local Windows desktop.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Examples: enter, tab, escape, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1-f12, or one Unicode character." },
          modifiers: { type: "array", items: { type: "string" } },
        },
        required: ["key"],
        additionalProperties: false,
      },
      execute: async (args) => desktop.pressKey(requiredString(args, "key"), stringArray(args, "modifiers")),
    },
    {
      name: "desktop_speak",
      description: "Speak text aloud through the Windows speech synthesizer on the local PC.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (args) => desktop.speak(requiredString(args, "text")),
    },
    {
      name: "desktop_listen",
      description: "Listen once through the default Windows microphone and return recognized speech text. Microphone access is privacy-sensitive and requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: { timeoutMs: { type: "number", description: "Recognition timeout in milliseconds, 1000-30000." } },
        additionalProperties: false,
      },
      execute: async (args) => {
        const timeoutMs = integer(args, "timeoutMs", 10_000);
        if (timeoutMs < 1_000 || timeoutMs > 30_000) throw new Error("timeoutMs must be between 1000 and 30000");
        return await desktop.listen(timeoutMs);
      },
    },
  ];
}
