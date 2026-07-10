import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { computeNextRunAt, type NotificationChannel, type ScheduleSpec } from "./schedule.js";

export type PlanStatus = "inbox" | "planned" | "doing" | "waiting" | "done" | "cancelled";
export type PlanPriority = "low" | "normal" | "high" | "urgent";

export type PlanItem = {
  id: string;
  title: string;
  description?: string;
  status: PlanStatus;
  priority: PlanPriority;
  flowId?: string;
  tags: string[];
  startAt?: string;
  dueAt?: string;
  durationMinutes?: number;
  timezone?: string;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type PlannerReminder = {
  id: string;
  itemId?: string;
  title: string;
  message: string;
  schedule: ScheduleSpec;
  channels: NotificationChannel[];
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PlannerAlert = {
  id: string;
  reminderId: string;
  itemId?: string;
  title: string;
  message: string;
  channels: NotificationChannel[];
  createdAt: string;
  readAt?: string;
  snoozedUntil?: string;
  snoozeReleasedAt?: string;
};

export type PlannerData = {
  version: 1;
  items: PlanItem[];
  reminders: PlannerReminder[];
  alerts: PlannerAlert[];
};

export type PlannerDashboard = {
  generatedAt: string;
  stats: {
    today: number;
    overdue: number;
    doing: number;
    waiting: number;
    done: number;
    unreadAlerts: number;
    activeReminders: number;
  };
  today: PlanItem[];
  overdue: PlanItem[];
  upcoming: PlanItem[];
  flow: Record<PlanStatus, PlanItem[]>;
  reminders: PlannerReminder[];
  alerts: PlannerAlert[];
};

const statuses: PlanStatus[] = ["inbox", "planned", "doing", "waiting", "done", "cancelled"];
const priorities: PlanPriority[] = ["low", "normal", "high", "urgent"];
const channels: NotificationChannel[] = ["in_app", "browser", "email", "line", "slack", "webhook"];

function emptyPlannerData(): PlannerData {
  return { version: 1, items: [], reminders: [], alerts: [] };
}

function isoNow(): string {
  return new Date().toISOString();
}

function validDate(value: string, name: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${name}: ${value}`);
  return date.toISOString();
}

function normalizeTags(values?: string[]): string[] {
  return [...new Set((values ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

function normalizeChannels(values?: NotificationChannel[]): NotificationChannel[] {
  const selected = [...new Set(values ?? ["in_app", "browser"])];
  if (selected.some((value) => !channels.includes(value))) throw new Error("Unknown notification channel");
  return selected.length ? selected : ["in_app"];
}

function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

export class PlannerStore {
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<PlannerData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PlannerData>;
      return {
        version: 1,
        items: Array.isArray(parsed.items) ? parsed.items : [],
        reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
        alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPlannerData();
      throw error;
    }
  }

  async #mutate<T>(mutator: (data: PlannerData) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.#writeQueue = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const data = await this.read();
          const value = await mutator(data);
          await mkdir(dirname(this.filePath), { recursive: true });
          await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
          resolveResult(value);
        } catch (error) {
          rejectResult(error);
        }
      });

    return result;
  }

  async createItem(input: {
    title: string;
    description?: string;
    status?: PlanStatus;
    priority?: PlanPriority;
    flowId?: string;
    tags?: string[];
    startAt?: string;
    dueAt?: string;
    durationMinutes?: number;
    timezone?: string;
    dependsOn?: string[];
  }): Promise<PlanItem> {
    return this.#mutate((data) => {
      const title = input.title.trim();
      if (!title) throw new Error("Plan item title is required");
      const status = input.status ?? "planned";
      const priority = input.priority ?? "normal";
      if (!statuses.includes(status)) throw new Error(`Invalid plan status: ${status}`);
      if (!priorities.includes(priority)) throw new Error(`Invalid plan priority: ${priority}`);
      const now = isoNow();
      const item: PlanItem = {
        id: crypto.randomUUID(),
        title,
        status,
        priority,
        tags: normalizeTags(input.tags),
        dependsOn: [...new Set(input.dependsOn ?? [])],
        createdAt: now,
        updatedAt: now,
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        ...(input.flowId?.trim() ? { flowId: input.flowId.trim() } : {}),
        ...(input.startAt ? { startAt: validDate(input.startAt, "startAt") } : {}),
        ...(input.dueAt ? { dueAt: validDate(input.dueAt, "dueAt") } : {}),
        ...(input.durationMinutes !== undefined ? { durationMinutes: Math.max(1, Math.round(input.durationMinutes)) } : {}),
        ...(input.timezone?.trim() ? { timezone: input.timezone.trim() } : {}),
      };
      for (const dependencyId of item.dependsOn) {
        if (!data.items.some((candidate) => candidate.id === dependencyId)) {
          throw new Error(`Dependency not found: ${dependencyId}`);
        }
      }
      data.items.push(item);
      return item;
    });
  }

  async listItems(filter: { status?: PlanStatus; flowId?: string } = {}): Promise<PlanItem[]> {
    const { items } = await this.read();
    return items
      .filter((item) => !filter.status || item.status === filter.status)
      .filter((item) => !filter.flowId || item.flowId === filter.flowId)
      .sort((a, b) => (a.startAt ?? a.dueAt ?? a.createdAt).localeCompare(b.startAt ?? b.dueAt ?? b.createdAt));
  }

  async updateItem(
    id: string,
    patch: {
      title?: string;
      description?: string;
      status?: PlanStatus;
      priority?: PlanPriority;
      flowId?: string;
      tags?: string[];
      startAt?: string | null;
      dueAt?: string | null;
      durationMinutes?: number | null;
      timezone?: string;
    },
  ): Promise<PlanItem> {
    return this.#mutate((data) => {
      const item = data.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Plan item not found: ${id}`);
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new Error("Plan item title cannot be empty");
        item.title = title;
      }
      if (patch.description !== undefined) item.description = patch.description.trim();
      if (patch.status !== undefined) {
        if (!statuses.includes(patch.status)) throw new Error(`Invalid plan status: ${patch.status}`);
        item.status = patch.status;
        if (patch.status === "done") item.completedAt = isoNow();
        else delete item.completedAt;
      }
      if (patch.priority !== undefined) {
        if (!priorities.includes(patch.priority)) throw new Error(`Invalid plan priority: ${patch.priority}`);
        item.priority = patch.priority;
      }
      if (patch.flowId !== undefined) item.flowId = patch.flowId.trim();
      if (patch.tags !== undefined) item.tags = normalizeTags(patch.tags);
      if (patch.startAt !== undefined) {
        if (patch.startAt === null) delete item.startAt;
        else item.startAt = validDate(patch.startAt, "startAt");
      }
      if (patch.dueAt !== undefined) {
        if (patch.dueAt === null) delete item.dueAt;
        else item.dueAt = validDate(patch.dueAt, "dueAt");
      }
      if (patch.durationMinutes !== undefined) {
        if (patch.durationMinutes === null) delete item.durationMinutes;
        else item.durationMinutes = Math.max(1, Math.round(patch.durationMinutes));
      }
      if (patch.timezone !== undefined) item.timezone = patch.timezone.trim();
      item.updatedAt = isoNow();
      return item;
    });
  }

  async setItemStatus(id: string, status: PlanStatus): Promise<PlanItem> {
    return this.updateItem(id, { status });
  }

  async addDependency(itemId: string, dependencyId: string): Promise<PlanItem> {
    if (itemId === dependencyId) throw new Error("A plan item cannot depend on itself");
    return this.#mutate((data) => {
      const item = data.items.find((candidate) => candidate.id === itemId);
      const dependency = data.items.find((candidate) => candidate.id === dependencyId);
      if (!item) throw new Error(`Plan item not found: ${itemId}`);
      if (!dependency) throw new Error(`Dependency not found: ${dependencyId}`);

      const walk = (id: string, visited = new Set<string>()): boolean => {
        if (id === itemId) return true;
        if (visited.has(id)) return false;
        visited.add(id);
        const node = data.items.find((candidate) => candidate.id === id);
        return node ? node.dependsOn.some((nextId) => walk(nextId, visited)) : false;
      };
      if (walk(dependencyId)) throw new Error("Dependency would create a cycle");
      if (!item.dependsOn.includes(dependencyId)) item.dependsOn.push(dependencyId);
      item.updatedAt = isoNow();
      return item;
    });
  }

  async createReminder(input: {
    itemId?: string;
    title: string;
    message?: string;
    schedule: ScheduleSpec;
    channels?: NotificationChannel[];
    enabled?: boolean;
  }): Promise<PlannerReminder> {
    return this.#mutate((data) => {
      const title = input.title.trim();
      if (!title) throw new Error("Reminder title is required");
      if (input.itemId && !data.items.some((item) => item.id === input.itemId)) {
        throw new Error(`Plan item not found: ${input.itemId}`);
      }
      const now = isoNow();
      const nextRunAt = computeNextRunAt(input.schedule, new Date());
      const reminder: PlannerReminder = {
        id: crypto.randomUUID(),
        title,
        message: input.message?.trim() || title,
        schedule: input.schedule,
        channels: normalizeChannels(input.channels),
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
        ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
      };
      if (!nextRunAt && input.schedule.kind !== "once") {
        throw new Error("Could not calculate the next reminder run time");
      }
      data.reminders.push(reminder);
      return reminder;
    });
  }

  async listReminders(enabled?: boolean): Promise<PlannerReminder[]> {
    const { reminders } = await this.read();
    return reminders
      .filter((item) => enabled === undefined || item.enabled === enabled)
      .sort((a, b) => (a.nextRunAt ?? "9999").localeCompare(b.nextRunAt ?? "9999"));
  }

  async setReminderEnabled(id: string, enabled: boolean): Promise<PlannerReminder> {
    return this.#mutate((data) => {
      const reminder = data.reminders.find((item) => item.id === id);
      if (!reminder) throw new Error(`Reminder not found: ${id}`);
      reminder.enabled = enabled;
      reminder.updatedAt = isoNow();
      if (enabled && !reminder.nextRunAt) {
        const nextRunAt = computeNextRunAt(reminder.schedule, new Date());
        if (nextRunAt) reminder.nextRunAt = nextRunAt;
      }
      return reminder;
    });
  }

  async getDueReminders(now = new Date()): Promise<PlannerReminder[]> {
    const { reminders } = await this.read();
    return reminders.filter(
      (reminder) => reminder.enabled && reminder.nextRunAt !== undefined && new Date(reminder.nextRunAt).getTime() <= now.getTime(),
    );
  }

  async fireReminder(id: string, now = new Date()): Promise<{ reminder: PlannerReminder; alert: PlannerAlert }> {
    return this.#mutate((data) => {
      const reminder = data.reminders.find((item) => item.id === id);
      if (!reminder) throw new Error(`Reminder not found: ${id}`);
      if (!reminder.enabled) throw new Error(`Reminder is disabled: ${id}`);
      if (!reminder.nextRunAt || new Date(reminder.nextRunAt).getTime() > now.getTime()) {
        throw new Error(`Reminder is not due: ${id}`);
      }

      const firedAt = now.toISOString();
      const alert: PlannerAlert = {
        id: crypto.randomUUID(),
        reminderId: reminder.id,
        title: reminder.title,
        message: reminder.message,
        channels: reminder.channels,
        createdAt: firedAt,
        ...(reminder.itemId ? { itemId: reminder.itemId } : {}),
      };
      data.alerts.push(alert);
      reminder.lastRunAt = firedAt;
      reminder.updatedAt = firedAt;
      const nextRunAt = computeNextRunAt(reminder.schedule, new Date(now.getTime() + 1_000));
      if (nextRunAt) reminder.nextRunAt = nextRunAt;
      else {
        delete reminder.nextRunAt;
        reminder.enabled = false;
      }
      return { reminder, alert };
    });
  }

  async listAlerts(options: { unreadOnly?: boolean; limit?: number } = {}): Promise<PlannerAlert[]> {
    const { alerts } = await this.read();
    return alerts
      .filter((alert) => !options.unreadOnly || !alert.readAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(options.limit ?? 100, 1), 500));
  }

  async markAlertRead(id: string): Promise<PlannerAlert> {
    return this.#mutate((data) => {
      const alert = data.alerts.find((item) => item.id === id);
      if (!alert) throw new Error(`Alert not found: ${id}`);
      alert.readAt = isoNow();
      return alert;
    });
  }

  async snoozeAlert(id: string, minutes: number): Promise<PlannerAlert> {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 43_200) {
      throw new Error("Snooze minutes must be between 1 and 43200");
    }
    return this.#mutate((data) => {
      const alert = data.alerts.find((item) => item.id === id);
      if (!alert) throw new Error(`Alert not found: ${id}`);
      alert.readAt = isoNow();
      alert.snoozedUntil = new Date(Date.now() + Math.round(minutes) * 60_000).toISOString();
      delete alert.snoozeReleasedAt;
      return alert;
    });
  }

  async releaseDueSnoozes(now = new Date()): Promise<PlannerAlert[]> {
    return this.#mutate((data) => {
      const released: PlannerAlert[] = [];
      for (const source of data.alerts) {
        if (!source.snoozedUntil || source.snoozeReleasedAt) continue;
        if (new Date(source.snoozedUntil).getTime() > now.getTime()) continue;
        source.snoozeReleasedAt = now.toISOString();
        const alert: PlannerAlert = {
          id: crypto.randomUUID(),
          reminderId: source.reminderId,
          title: source.title,
          message: source.message,
          channels: source.channels,
          createdAt: now.toISOString(),
          ...(source.itemId ? { itemId: source.itemId } : {}),
        };
        data.alerts.push(alert);
        released.push(alert);
      }
      return released;
    });
  }

  async getDashboard(now = new Date()): Promise<PlannerDashboard> {
    const data = await this.read();
    const dayStart = startOfDay(now).getTime();
    const dayEnd = endOfDay(now).getTime();
    const activeItems = data.items.filter((item) => item.status !== "cancelled");
    const today = activeItems.filter((item) => {
      const value = item.startAt ?? item.dueAt;
      if (!value) return false;
      const time = new Date(value).getTime();
      return time >= dayStart && time <= dayEnd;
    });
    const overdue = activeItems.filter(
      (item) => item.status !== "done" && item.dueAt !== undefined && new Date(item.dueAt).getTime() < now.getTime(),
    );
    const upcoming = activeItems
      .filter((item) => item.status !== "done" && (item.startAt || item.dueAt))
      .filter((item) => new Date(item.startAt ?? item.dueAt ?? "9999").getTime() > dayEnd)
      .sort((a, b) => (a.startAt ?? a.dueAt ?? "9999").localeCompare(b.startAt ?? b.dueAt ?? "9999"))
      .slice(0, 20);

    const flow = Object.fromEntries(statuses.map((status) => [status, activeItems.filter((item) => item.status === status)])) as Record<PlanStatus, PlanItem[]>;
    const reminders = data.reminders
      .filter((item) => item.enabled)
      .sort((a, b) => (a.nextRunAt ?? "9999").localeCompare(b.nextRunAt ?? "9999"))
      .slice(0, 20);
    const alerts = data.alerts.filter((item) => !item.readAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);

    return {
      generatedAt: now.toISOString(),
      stats: {
        today: today.length,
        overdue: overdue.length,
        doing: flow.doing.length,
        waiting: flow.waiting.length,
        done: flow.done.length,
        unreadAlerts: alerts.length,
        activeReminders: data.reminders.filter((item) => item.enabled).length,
      },
      today: today.sort((a, b) => (a.startAt ?? a.dueAt ?? a.createdAt).localeCompare(b.startAt ?? b.dueAt ?? b.createdAt)),
      overdue: overdue.sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999")),
      upcoming,
      flow,
      reminders,
      alerts,
    };
  }
}
