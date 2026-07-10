import type { PlannerAlert, PlannerReminder, PlannerStore } from "./PlannerStore.js";

export type SchedulerTickResult = {
  checkedAt: string;
  fired: Array<{ reminder: PlannerReminder; alert: PlannerAlert }>;
  snoozesReleased: PlannerAlert[];
  errors: Array<{ reminderId?: string; error: string }>;
};

export type SchedulerEngineOptions = {
  intervalMs?: number;
  onAlert?: (alert: PlannerAlert, reminder?: PlannerReminder) => Promise<void> | void;
};

export class SchedulerEngine {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #lastTick?: SchedulerTickResult;
  readonly #intervalMs: number;

  constructor(
    private readonly store: PlannerStore,
    private readonly options: SchedulerEngineOptions = {},
  ) {
    this.#intervalMs = Math.max(1_000, options.intervalMs ?? 15_000);
  }

  get running(): boolean {
    return this.#running;
  }

  get lastTick(): SchedulerTickResult | undefined {
    return this.#lastTick;
  }

  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(now = new Date()): Promise<SchedulerTickResult> {
    if (this.#running) {
      return this.#lastTick ?? {
        checkedAt: now.toISOString(),
        fired: [],
        snoozesReleased: [],
        errors: [{ error: "Scheduler tick skipped because a previous tick is still running" }],
      };
    }

    this.#running = true;
    const result: SchedulerTickResult = {
      checkedAt: now.toISOString(),
      fired: [],
      snoozesReleased: [],
      errors: [],
    };

    try {
      const due = await this.store.getDueReminders(now);
      for (const reminder of due) {
        try {
          const fired = await this.store.fireReminder(reminder.id, now);
          result.fired.push(fired);
          await this.options.onAlert?.(fired.alert, fired.reminder);
        } catch (error) {
          result.errors.push({
            reminderId: reminder.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      try {
        result.snoozesReleased = await this.store.releaseDueSnoozes(now);
        for (const alert of result.snoozesReleased) {
          await this.options.onAlert?.(alert);
        }
      } catch (error) {
        result.errors.push({ error: error instanceof Error ? error.message : String(error) });
      }

      this.#lastTick = result;
      return result;
    } finally {
      this.#running = false;
    }
  }
}
