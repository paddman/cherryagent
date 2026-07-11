import type { DesktopCapture } from "./WindowsDesktopClient.js";

export type DesktopVisionClientOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export type DesktopVisionResult = {
  model: string;
  description: string;
  analyzedAt: string;
};

export class DesktopVisionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: DesktopVisionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
  }

  configured(): boolean {
    return Boolean(this.baseUrl && this.model);
  }

  async analyze(capture: DesktopCapture, prompt: string): Promise<DesktopVisionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: "You are Cherry desktop vision. Describe only what is visibly supported by the screenshot. Never invent hidden UI state, passwords, text, coordinates, or successful actions. Mention uncertainty explicitly.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt || "Describe the visible desktop state, important UI elements, warnings, and actionable targets.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${capture.mimeType};base64,${capture.imageBase64}`,
                  },
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Vision model request failed: ${response.status} ${raw.slice(0, 1_000)}`);
      }

      const parsed = JSON.parse(raw) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const description = parsed.choices?.[0]?.message?.content?.trim();
      if (!description) throw new Error("Vision model returned no text description");

      return {
        model: this.model,
        description,
        analyzedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Vision model timed out after ${this.timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
