export type SttClientOptions = {
  baseUrl: string;
  timeoutMs: number;
};

export type TranscribeResult = {
  text: string;
};

export class SttClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: SttClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#timeoutMs = Math.max(1_000, options.timeoutMs);
  }

  isConfigured(): boolean {
    return Boolean(this.#baseUrl);
  }

  async transcribe(audio: Buffer, filename = "audio.wav"): Promise<TranscribeResult> {
    if (!audio.length) throw new Error("audio is empty");

    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(audio)]), filename);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}/asr`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const payload = await response.json() as { text?: string; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `STT failed with HTTP ${response.status}`);
      }
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) throw new Error("STT returned empty text");
      return { text };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`STT request timeout after ${this.#timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
