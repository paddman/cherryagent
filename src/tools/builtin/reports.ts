import type { AgentTool } from "../../core/types.js";
import type { ReportStudioService } from "../../reports/ReportStudioService.js";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${key} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

export function createReportTools(reports: ReportStudioService): AgentTool[] {
  return [
    {
      name: "report_list_reports",
      description: "List recent tenant-scoped Cherry Report Studio reports and their generation status.",
      risk: "safe",
      parameters: { type: "object", properties: { limit: { type: "number", minimum: 1, maximum: 100 } }, additionalProperties: false },
      execute: async (args, context) => reports.list(context.tenantId, typeof args.limit === "number" ? args.limit : 20),
    },
    {
      name: "report_get_report",
      description: "Read one completed report including source fingerprint, mapping, KPI, chart aggregates, quality warnings, and evidence-linked insights. Raw uploaded rows are never returned.",
      risk: "safe",
      parameters: { type: "object", properties: { reportId: { type: "string" } }, required: ["reportId"], additionalProperties: false },
      execute: async (args, context) => reports.get(requiredString(args, "reportId"), context.tenantId),
    },
    {
      name: "report_regenerate",
      description: "Regenerate a report with explicit date, metric, and dimension mapping. Uses the existing tenant-scoped source file and creates a new verified AgenticRun.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          reportId: { type: "string" },
          dateColumn: { type: "string" },
          metrics: { type: "array", items: { type: "string" } },
          dimensions: { type: "array", items: { type: "string" } },
        },
        required: ["reportId", "metrics", "dimensions"],
        additionalProperties: false,
      },
      execute: async (args, context) => reports.regenerate(requiredString(args, "reportId"), context.tenantId, {
        ...(typeof args.dateColumn === "string" && args.dateColumn.trim() ? { dateColumn: args.dateColumn.trim() } : {}),
        metrics: stringArray(args.metrics, "metrics"),
        dimensions: stringArray(args.dimensions, "dimensions"),
      }),
    },
  ];
}
