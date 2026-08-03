export type AiWorkerClientOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
};

export type AiWorkerHealth = {
  ok: boolean;
  service: string;
  version: string;
  authentication: "bearer";
  embeddingConfigured: boolean;
  capabilities: string[];
};

export type AiTextChunk = {
  index: number;
  text: string;
  start: number;
  end: number;
};

export type AiRerankItem = {
  index: number;
  score: number;
  preview: string;
};

export class AiWorkerClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(options: AiWorkerClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = (options.token ?? process.env.CHERRY_AI_WORKER_TOKEN ?? "").trim();
    this.#timeoutMs = Math.max(1_000, options.timeoutMs);
    if (!this.#token || this.#token.length < 24 || /[\u0000-\u001f\u007f]/.test(this.#token)) {
      throw new Error("CHERRY_AI_WORKER_TOKEN must contain at least 24 printable characters when the AI worker is enabled");
    }
  }

  async health(): Promise<AiWorkerHealth> {
    return await this.#request<AiWorkerHealth>("GET", "/health");
  }

  async chunk(input: { text: string; maxChars?: number; overlapChars?: number }): Promise<{ chunks: AiTextChunk[]; characters: number }> {
    return await this.#request("POST", "/v1/chunk", {
      text: input.text,
      ...(input.maxChars !== undefined ? { max_chars: input.maxChars } : {}),
      ...(input.overlapChars !== undefined ? { overlap_chars: input.overlapChars } : {}),
    });
  }

  async rerank(input: { query: string; documents: string[]; topK?: number }): Promise<{ results: AiRerankItem[]; method: string }> {
    return await this.#request("POST", "/v1/rerank", {
      query: input.query,
      documents: input.documents,
      ...(input.topK !== undefined ? { top_k: input.topK } : {}),
    });
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#token}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new Error(`AI worker returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      if (!response.ok) {
        const detail = payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as { detail?: unknown }).detail
          : undefined;
        throw new Error(typeof detail === "string" ? detail : `AI worker failed with HTTP ${response.status}`);
      }
      return payload as T;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`AI worker timed out after ${this.#timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
