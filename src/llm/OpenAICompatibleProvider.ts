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
  error?: { message?: string };
};

export class OpenAICompatibleProvider implements LlmProvider {
  constructor(private readonly options: OpenAICompatibleProviderOptions) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const hasTools = request.tools.length > 0;
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
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
    });

    const text = await response.text();
    let payload: ApiResponse;
    try {
      payload = JSON.parse(text) as ApiResponse;
    } catch {
      throw new Error(`LLM returned non-JSON response (${response.status}): ${text.slice(0, 500)}`);
    }

    if (!response.ok) {
      throw new Error(payload.error?.message ?? `LLM request failed with HTTP ${response.status}`);
    }

    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("LLM response did not contain choices[0].message");

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
