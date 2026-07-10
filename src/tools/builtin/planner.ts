import type { AgentTool } from "../../core/types.js";
import type { PlanPriority, PlanStatus, PlannerStore } from "../../planner/PlannerStore.js";
import type { NotificationChannel, ScheduleSpec } from "../../planner/schedule.js";

const planStatuses: PlanStatus[] = ["inbox", "planned", "doing", "waiting", "done", "cancelled"];
const priorities: PlanPriority[] = ["low", "normal", "high", "urgent"];
const notificationChannels: NotificationChannel[] = ["in_app", "browser", "email", "line", "slack", "webhook"];

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected an array of strings");
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseStatus(value: unknown): PlanStatus | undefined {
  return typeof value === "string" && planStatuses.includes(value as PlanStatus) ? value as PlanStatus : undefined;
}

function parsePriority(value: unknown): PlanPriority | undefined {
  return typeof value === "string" && priorities.includes(value as PlanPriority) ? value as PlanPriority : undefined;
}

function parseChannels(value: unknown): NotificationChannel[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("channels must be an array");
  const result = value.map((item) => {
    if (typeof item !== "string" || !notificationChannels.includes(item as NotificationChannel)) {
      throw new Error(`Unknown notification channel: ${String(item)}`);
    }
    return item as NotificationChannel;
  });
  return result;
}

function parseSchedule(value: unknown): ScheduleSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule must be an object");
  const schedule = value as Record<string, unknown>;
  const kind = requiredString(schedule, "kind");
  const timezone = optionalString(schedule, "timezone");

  switch (kind) {
    case "once":
      return { kind, at: requiredString(schedule, "at") };
    case "interval": {
      const everyMinutes = Number(schedule.everyMinutes);
      if (!Number.isFinite(everyMinutes)) throw new Error("interval schedule requires everyMinutes");
      return {
        kind,
        everyMinutes,
        ...(optionalString(schedule, "startAt") ? { startAt: optionalString(schedule, "startAt") } : {}),
      };
    }
    case "daily":
      return { kind, time: requiredString(schedule, "time"), ...(timezone ? { timezone } : {}) };
    case "weekdays":
      return { kind, time: requiredString(schedule, "time"), ...(timezone ? { timezone } : {}) };
    case "weekly": {
      if (!Array.isArray(schedule.weekdays)) throw new Error("weekly schedule requires weekdays array");
      const weekdays = schedule.weekdays.map(Number);
      return { kind, weekdays, time: requiredString(schedule, "time"), ...(timezone ? { timezone } : {}) };
    }
    case "monthly": {
      const day = Number(schedule.day);
      if (!Number.isFinite(day)) throw new Error("monthly schedule requires day");
      return { kind, day, time: requiredString(schedule, "time"), ...(timezone ? { timezone } : {}) };
    }
    case "cron":
      return { kind, expression: requiredString(schedule, "expression"), ...(timezone ? { timezone } : {}) };
    default:
      throw new Error(`Unknown schedule kind: ${kind}`);
  }
}

const scheduleSchema = {
  type: "object",
  description: "Scheduling rule. Supports once, interval, daily, weekdays, weekly, monthly, or 5-field cron.",
  properties: {
    kind: { type: "string", enum: ["once", "interval", "daily", "weekdays", "weekly", "monthly", "cron"] },
    at: { type: "string", description: "ISO 8601 datetime for once schedule" },
    everyMinutes: { type: "number", minimum: 1 },
    startAt: { type: "string" },
    time: { type: "string", description: "HH:mm local time" },
    timezone: { type: "string", description: "IANA timezone, default Asia/Bangkok" },
    weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
    day: { type: "integer", minimum: 1, maximum: 31 },
    expression: { type: "string", description: "5-field cron: minute hour day month weekday" },
  },
  required: ["kind"],
  additionalProperties: false,
};

export function createPlannerTools(planner: PlannerStore): AgentTool[] {
  return [
    {
      name: "planner_get_dashboard",
      description: "Get the current planning dashboard with today, overdue, upcoming, flow columns, active reminders, and unread alerts.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => planner.getDashboard(),
    },
    {
      name: "planner_create_item",
      description: "Create a plan item in the office flow board with priority, schedule, duration, tags, dependencies, and optional flow/project ID.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: planStatuses },
          priority: { type: "string", enum: priorities },
          flowId: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          startAt: { type: "string", description: "ISO 8601 start datetime" },
          dueAt: { type: "string", description: "ISO 8601 due datetime" },
          durationMinutes: { type: "number", minimum: 1 },
          timezone: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
        additionalProperties: false,
      },
      execute: async (args) => planner.createItem({
        title: requiredString(args, "title"),
        ...(optionalString(args, "description") ? { description: optionalString(args, "description") } : {}),
        ...(parseStatus(args.status) ? { status: parseStatus(args.status) } : {}),
        ...(parsePriority(args.priority) ? { priority: parsePriority(args.priority) } : {}),
        ...(optionalString(args, "flowId") ? { flowId: optionalString(args, "flowId") } : {}),
        ...(stringArray(args.tags) ? { tags: stringArray(args.tags) } : {}),
        ...(optionalString(args, "startAt") ? { startAt: optionalString(args, "startAt") } : {}),
        ...(optionalString(args, "dueAt") ? { dueAt: optionalString(args, "dueAt") } : {}),
        ...(typeof args.durationMinutes === "number" ? { durationMinutes: args.durationMinutes } : {}),
        ...(optionalString(args, "timezone") ? { timezone: optionalString(args, "timezone") } : {}),
        ...(stringArray(args.dependsOn) ? { dependsOn: stringArray(args.dependsOn) } : {}),
      }),
    },
    {
      name: "planner_list_items",
      description: "List plan items, optionally filtered by flow status or project/flow ID.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: planStatuses },
          flowId: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (args) => planner.listItems({
        ...(parseStatus(args.status) ? { status: parseStatus(args.status) } : {}),
        ...(optionalString(args, "flowId") ? { flowId: optionalString(args, "flowId") } : {}),
      }),
    },
    {
      name: "planner_update_item_status",
      description: "Move a plan item between inbox, planned, doing, waiting, done, or cancelled flow columns.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: planStatuses },
        },
        required: ["id", "status"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const status = parseStatus(args.status);
        if (!status) throw new Error("Valid status is required");
        return planner.setItemStatus(requiredString(args, "id"), status);
      },
    },
    {
      name: "planner_add_dependency",
      description: "Add a dependency between two plan items. Cycles are rejected.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          dependencyId: { type: "string" },
        },
        required: ["itemId", "dependencyId"],
        additionalProperties: false,
      },
      execute: async (args) => planner.addDependency(requiredString(args, "itemId"), requiredString(args, "dependencyId")),
    },
    {
      name: "planner_create_reminder",
      description: "Create a persistent reminder schedule. Supports once, interval, daily, weekdays, weekly, monthly, and cron schedules. Prefer in_app/browser channels for normal personal reminders.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          title: { type: "string" },
          message: { type: "string" },
          schedule: scheduleSchema,
          channels: { type: "array", items: { type: "string", enum: notificationChannels } },
        },
        required: ["title", "schedule"],
        additionalProperties: false,
      },
      execute: async (args) => planner.createReminder({
        title: requiredString(args, "title"),
        schedule: parseSchedule(args.schedule),
        ...(optionalString(args, "itemId") ? { itemId: optionalString(args, "itemId") } : {}),
        ...(optionalString(args, "message") ? { message: optionalString(args, "message") } : {}),
        ...(parseChannels(args.channels) ? { channels: parseChannels(args.channels) } : {}),
      }),
    },
    {
      name: "planner_list_reminders",
      description: "List persistent reminder schedules ordered by next execution time.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        additionalProperties: false,
      },
      execute: async (args) => planner.listReminders(typeof args.enabled === "boolean" ? args.enabled : undefined),
    },
    {
      name: "planner_set_reminder_enabled",
      description: "Enable or disable a reminder schedule without deleting it.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, enabled: { type: "boolean" } },
        required: ["id", "enabled"],
        additionalProperties: false,
      },
      execute: async (args) => {
        if (typeof args.enabled !== "boolean") throw new Error("enabled must be boolean");
        return planner.setReminderEnabled(requiredString(args, "id"), args.enabled);
      },
    },
    {
      name: "planner_snooze_alert",
      description: "Snooze a planner alert for a number of minutes. Maximum 30 days.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, minutes: { type: "number", minimum: 1, maximum: 43200 } },
        required: ["id", "minutes"],
        additionalProperties: false,
      },
      execute: async (args) => planner.snoozeAlert(requiredString(args, "id"), Number(args.minutes)),
    },
    {
      name: "planner_mark_alert_read",
      description: "Mark a planner alert as read.",
      risk: "write",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (args) => planner.markAlertRead(requiredString(args, "id")),
    },
  ];
}
