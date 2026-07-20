export type RiskLevel = "safe" | "write" | "external" | "dangerous";

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name: string };

export type ToolContext = {
  sessionId: string;
  userId: string;
  tenantId: string;
  workspaceRoot: string;
  traceId?: string;
};

export type AgentTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: RiskLevel;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

export type CompletionRequest = {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
};

export type CompletionResult = {
  message: Extract<ChatMessage, { role: "assistant" }>;
  raw?: unknown;
};

export interface LlmProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
