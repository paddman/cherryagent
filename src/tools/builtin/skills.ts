import type { AgentTool } from "../../core/types.js";
import type { EngineerLoopEngine } from "../../engineer/EngineerLoopEngine.js";
import type { SkillStore } from "../../skills/SkillStore.js";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalLimit(args: Record<string, unknown>, fallback: number): number {
  if (args.limit === undefined) return fallback;
  const limit = Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer between 1 and 50");
  return limit;
}

export function createSkillTools(skills: SkillStore, engineer: EngineerLoopEngine): AgentTool[] {
  return [
    {
      name: "skill_list",
      description: "List tenant-scoped procedural skills. Verified skills were promoted from Engineer Loop runbooks with real verification evidence.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, context) => skills.list(context.tenantId),
    },
    {
      name: "skill_search",
      description: "Search reusable procedural skills before repeating a complex, operational, or previously solved task.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symptoms, objective, technology, or procedure to find" },
          limit: { type: "number", minimum: 1, maximum: 50 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args, context) => skills.search(requiredString(args, "query"), context.tenantId, optionalLimit(args, 8)),
    },
    {
      name: "skill_read",
      description: "Read one SKILL.md including procedure, verification, provenance, and revision. Read before updating so optimistic concurrency can prevent blind overwrites.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      execute: async (args, context) => skills.read(
        requiredString(args, "name"),
        optionalString(args, "category"),
        context.tenantId,
      ),
    },
    {
      name: "skill_create",
      description: "Create one tenant-scoped agentskills-style SKILL.md from explicit user requirements or a procedure that has already been proven. New free-form skills are marked unverified until evidence exists.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Lowercase-hyphenated name, at most 64 characters" },
          category: { type: "string", description: "Lowercase-hyphenated category" },
          description: { type: "string", description: "One capability sentence, at most 60 characters" },
          body: { type: "string", description: "Markdown procedure with When to Use, Procedure, and Verification sections" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["name", "category", "description", "body"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const tags = optionalStringArray(args, "tags");
        return skills.create({
          tenantId: context.tenantId,
          name: requiredString(args, "name"),
          category: requiredString(args, "category"),
          description: requiredString(args, "description"),
          body: requiredString(args, "body"),
          ...(tags !== undefined ? { tags } : {}),
          source: "agent",
          verified: false,
        });
      },
    },
    {
      name: "skill_update",
      description: "Update an existing skill only after reading its current revision. Provenance and verification status cannot be forged by this tool.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          expectedRevision: { type: "string", description: "Revision returned by skill_read" },
          description: { type: "string" },
          body: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["name", "expectedRevision"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const category = optionalString(args, "category");
        const description = optionalString(args, "description");
        const body = optionalString(args, "body");
        const tags = optionalStringArray(args, "tags");
        return skills.update({
          tenantId: context.tenantId,
          name: requiredString(args, "name"),
          expectedRevision: requiredString(args, "expectedRevision"),
          ...(category !== undefined ? { category } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(tags !== undefined ? { tags } : {}),
        });
      },
    },
    {
      name: "skill_promote_runbook",
      description: "Promote a successfully verified Engineer Loop runbook into a reusable procedural skill. This is the trusted learning path because verification evidence and provenance are preserved.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          runbookId: { type: "string" },
          name: { type: "string", description: "Lowercase-hyphenated skill name" },
          category: { type: "string" },
          description: { type: "string", description: "One capability sentence, at most 60 characters" },
          tags: { type: "array", items: { type: "string" } },
          whenToUse: { type: "array", items: { type: "string" } },
        },
        required: ["runbookId", "name", "description"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const runbookId = requiredString(args, "runbookId");
        const runbook = (await engineer.listRunbooks(500, context.tenantId)).find((item) => item.id === runbookId);
        if (!runbook) throw new Error(`Engineer runbook not found: ${runbookId}`);
        const category = optionalString(args, "category");
        const tags = optionalStringArray(args, "tags");
        const whenToUse = optionalStringArray(args, "whenToUse");
        return skills.promoteRunbook({
          tenantId: context.tenantId,
          runbook,
          name: requiredString(args, "name"),
          description: requiredString(args, "description"),
          ...(category !== undefined ? { category } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(whenToUse !== undefined ? { whenToUse } : {}),
        });
      },
    },
  ];
}
