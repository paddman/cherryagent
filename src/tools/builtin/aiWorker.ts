import type { AiWorkerClient } from "../../connectors/ai/AiWorkerClient.js";
import type { AgentTool } from "../../core/types.js";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function integer(args: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const raw = args[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function documents(args: Record<string, unknown>): string[] {
  const value = args.documents;
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("documents must be a non-empty array of strings");
  }
  if (value.length > 200) throw new Error("documents cannot contain more than 200 items");
  return value;
}

export function createAiWorkerTools(client: AiWorkerClient): AgentTool[] {
  return [
    {
      name: "ai_worker_health",
      description: "Check the configured Python AI worker and list its available intelligence capabilities.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => client.health(),
    },
    {
      name: "ai_chunk_text",
      description: "Split long text into deterministic overlapping chunks with source offsets. Text is sent to the configured AI worker, so approval protects potentially sensitive content.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          maxChars: { type: "number", minimum: 200, maximum: 20000 },
          overlapChars: { type: "number", minimum: 0, maximum: 5000 },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (args) => client.chunk({
        text: requiredString(args, "text"),
        ...(integer(args, "maxChars") !== undefined ? { maxChars: integer(args, "maxChars") } : {}),
        ...(integer(args, "overlapChars") !== undefined ? { overlapChars: integer(args, "overlapChars") } : {}),
      }),
    },
    {
      name: "ai_rerank",
      description: "Rank candidate passages against a query using the Python AI worker. Use after retrieval to reduce irrelevant context before sending evidence to the LLM.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          documents: { type: "array", items: { type: "string" }, maxItems: 200 },
          topK: { type: "number", minimum: 1, maximum: 200 },
        },
        required: ["query", "documents"],
        additionalProperties: false,
      },
      execute: async (args) => client.rerank({
        query: requiredString(args, "query"),
        documents: documents(args),
        ...(integer(args, "topK") !== undefined ? { topK: integer(args, "topK") } : {}),
      }),
    },
  ];
}
