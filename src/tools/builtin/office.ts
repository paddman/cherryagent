import type { AgentTool } from "../../core/types.js";
import type { MemoryStore } from "../../memory/MemoryStore.js";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty string argument: ${key}`);
  }
  return value.trim();
}

export function createOfficeTools(memory: MemoryStore): AgentTool[] {
  return [
    {
      name: "office_create_task",
      description: "Create a local office task or follow-up item. Use this when the user asks to remember work, create a to-do, or schedule a follow-up without changing an external calendar.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Clear task title" },
          due: { type: "string", description: "Optional due date/time in ISO 8601 or clear natural-language form" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      execute: async (args, context) =>
        memory.createTask({
          title: stringArg(args, "title"),
          tenantId: context.tenantId,
          ...(typeof args.due === "string" && args.due.trim() ? { due: args.due.trim() } : {}),
        }),
    },
    {
      name: "office_list_tasks",
      description: "List local office tasks. Can filter by open or done status.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "done"] },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const status = args.status === "open" || args.status === "done" ? args.status : undefined;
        return memory.listTasks(status, context.tenantId);
      },
    },
    {
      name: "office_complete_task",
      description: "Mark a local office task as completed using its task ID.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (args, context) => memory.completeTask(stringArg(args, "id"), context.tenantId),
    },
    {
      name: "office_save_note",
      description: "Save a durable local note for later office work, meeting notes, decisions, procedures, or useful context.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["title", "content"],
        additionalProperties: false,
      },
      execute: async (args, context) =>
        memory.createNote({
          title: stringArg(args, "title"),
          content: stringArg(args, "content"),
          tenantId: context.tenantId,
        }),
    },
    {
      name: "memory_remember_fact",
      description: "Store a durable user or workplace fact by key. Use only for useful, non-secret long-term context.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
      execute: async (args, context) => memory.remember(stringArg(args, "key"), stringArg(args, "value"), context.tenantId),
    },
    {
      name: "memory_recall_fact",
      description: "Recall a durable fact previously stored under a key.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
      execute: async (args, context) => ({ key: stringArg(args, "key"), value: await memory.recall(stringArg(args, "key"), context.tenantId) }),
    },
  ];
}
