import type { AgentTool } from "../../core/types.js";

export const systemTools: AgentTool[] = [
  {
    name: "system_current_time",
    description: "Get the current date and time, optionally formatted in an IANA timezone such as Asia/Bangkok.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone, for example Asia/Bangkok" },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const timezone = typeof args.timezone === "string" && args.timezone.trim() ? args.timezone.trim() : "UTC";
      const now = new Date();
      return {
        iso: now.toISOString(),
        timezone,
        formatted: new Intl.DateTimeFormat("en-GB", {
          dateStyle: "full",
          timeStyle: "long",
          timeZone: timezone,
        }).format(now),
      };
    },
  },
  {
    name: "system_calculate",
    description: "Calculate a basic arithmetic expression using numbers, parentheses, +, -, *, /, and %. Use this instead of mental arithmetic when precision matters.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Arithmetic expression such as (1250 * 7) / 3" },
      },
      required: ["expression"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const expression = String(args.expression ?? "").trim();
      if (!expression || !/^[0-9+\-*/().%\s]+$/.test(expression)) {
        throw new Error("Expression contains unsupported characters");
      }
      const result = Function(`"use strict"; return (${expression});`)() as unknown;
      if (typeof result !== "number" || !Number.isFinite(result)) {
        throw new Error("Expression did not produce a finite number");
      }
      return { expression, result };
    },
  },
];
