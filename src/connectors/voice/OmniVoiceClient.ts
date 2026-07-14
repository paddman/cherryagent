export type OmniVoiceClientOptions = {
  baseUrl: string;
  timeoutMs: number;
  defaultLanguage?: string;
  defaultFormat?: SpeechFormat;
};

export type SpeechFormat = "wav" | "mp3" | "opus" | "aac" | "flac" | "pcm";

export type SynthesizeOptions = {
  language?: string | undefined;
  voice?: string | undefined;
  speed?: number | undefined;
  format?: SpeechFormat | undefined;
};

export type SynthesizeResult = {
  audio: Buffer;
  format: SpeechFormat;
  bytes: number;
};

export type VoiceHealth = {
  status: string;
  ready: boolean;
  modelLoaded?: boolean;
  modelId?: string;
};

export class OmniVoiceClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #defaultLanguage: string;
  readonly #defaultFormat: SpeechFormat;

  constructor(options: OmniVoiceClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#timeoutMs = Math.max(1_000, options.timeoutMs);
    this.#defaultLanguage = options.defaultLanguage ?? "th";
    this.#defaultFormat = options.defaultFormat ?? "wav";
  }

  isConfigured(): boolean {
    return Boolean(this.#baseUrl);
  }

  async health(): Promise<VoiceHealth> {
    const response = await this.#request("/health");
    const payload = await response.json() as VoiceHealth;
    return payload;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<SynthesizeResult> {
    const input = text.trim();
    if (!input) throw new Error("text is required");

    const format = options.format ?? this.#defaultFormat;
    const response = await this.#request("/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/*" },
      body: JSON.stringify({
        input,
        language: options.language ?? this.#defaultLanguage,
        voice: options.voice ?? "auto",
        response_format: format,
        speed: options.speed ?? 1,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OmniVoice TTS failed (${response.status}): ${detail.slice(0, 500)}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw new Error("OmniVoice returned empty audio");
    return { audio, format, bytes: audio.length };
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`OmniVoice request timeout after ${this.#timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
