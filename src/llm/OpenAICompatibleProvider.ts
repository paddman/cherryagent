import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  ToolCall,
} from "../core/types.js";

export type OpenAICompatibleProviderOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
};

type ApiChoice = {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: ToolCall[];
  };
};

type ApiResponse = {
  choices?: ApiChoice[];
  error?: { message?: string; code?: string | number; type?: string };
};

export class OpenAICompatibleProviderError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly timedOut: boolean;
  readonly networkFailure: boolean;
  readonly externalAbort: boolean;
  readonly responsePreview: string | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      timedOut?: boolean;
      networkFailure?: boolean;
      externalAbort?: boolean;
      responsePreview?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OpenAICompatibleProviderError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.timedOut = options.timedOut ?? false;
    this.networkFailure = options.networkFailure ?? false;
    this.externalAbort = options.externalAbort ?? false;
    this.responsePreview = options.responsePreview;
  }
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function safePreview(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
}

export class OpenAICompatibleProvider implements LlmProvider {
  constructor(private readonly options: OpenAICompatibleProviderOptions) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (request.signal?.aborted) {
      throw new OpenAICompatibleProviderError("LLM request aborted", {
        externalAbort: true,
        cause: request.signal.reason,
      });
    }

    const hasTools = request.tools.length > 0;
    const controller = new AbortController();
    const timeoutMs = Math.max(1_000, this.options.timeoutMs ?? 60_000);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`LLM request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const forwardAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", forwardAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages,
          ...(hasTools ? { tools: request.tools, tool_choice: "auto" } : {}),
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (request.signal?.aborted && !timedOut) {
        throw new OpenAICompatibleProviderError("LLM request aborted", {
          externalAbort: true,
          cause: error,
        });
      }
      if (timedOut) {
        throw new OpenAICompatibleProviderError(`LLM request timed out after ${timeoutMs} ms`, {
          timedOut: true,
          cause: error,
        });
      }
      throw new OpenAICompatibleProviderError(
        `LLM network request failed: ${error instanceof Error ? error.message : String(error)}`,
        { networkFailure: true, cause: error },
      );
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", forwardAbort);
    }

    const text = await response.text();
    let payload: ApiResponse;
    try {
      payload = JSON.parse(text) as ApiResponse;
    } catch (error) {
      throw new OpenAICompatibleProviderError(
        `LLM returned non-JSON response (${response.status}): ${safePreview(text)}`,
        {
          status: response.status,
          retryAfterMs: retryAfterMs(response),
          responsePreview: safePreview(text),
          cause: error,
        },
      );
    }

    if (!response.ok) {
      const message = payload.error?.message?.trim() || `LLM request failed with HTTP ${response.status}`;
      throw new OpenAICompatibleProviderError(message, {
        status: response.status,
        retryAfterMs: retryAfterMs(response),
        responsePreview: safePreview(text),
      });
    }

    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new OpenAICompatibleProviderError("LLM response did not contain choices[0].message", {
        status: response.status,
        responsePreview: safePreview(text),
      });
    }

    const assistantMessage: Extract<ChatMessage, { role: "assistant" }> = {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      ...(Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? { tool_calls: message.tool_calls }
        : {}),
    };

    return { message: assistantMessage, raw: payload };
  }
}
