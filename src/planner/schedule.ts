export type NotificationChannel = "in_app" | "browser" | "email" | "line" | "slack" | "webhook";

export type ScheduleSpec =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMinutes: number; startAt?: string }
  | { kind: "daily"; time: string; timezone?: string }
  | { kind: "weekdays"; time: string; timezone?: string }
  | { kind: "weekly"; weekdays: number[]; time: string; timezone?: string }
  | { kind: "monthly"; day: number; time: string; timezone?: string }
  | { kind: "cron"; expression: string; timezone?: string };

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const DEFAULT_TIMEZONE = "Asia/Bangkok";
const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseTime(value: string): { hour: number; minute: number } {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid time '${value}'. Expected HH:mm`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time '${value}'. Expected HH:mm`);
  }
  return { hour, minute };
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((item) => [item.type, item.value]));
  const weekday = WEEKDAY_MAP[parts.weekday ?? ""];
  if (weekday === undefined) throw new Error(`Could not resolve weekday for timezone ${timeZone}`);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday,
  };
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const delta = desired - actualAsUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

function addLocalDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function localWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function normalizeTimeZone(value?: string): string {
  const timeZone = value?.trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    throw new Error(`Invalid timezone: ${timeZone}`);
  }
}

function nextAtLocalTime(
  after: Date,
  time: string,
  timezone: string | undefined,
  allowedWeekdays?: ReadonlySet<number>,
  monthlyDay?: number,
): Date | undefined {
  const zone = normalizeTimeZone(timezone);
  const { hour, minute } = parseTime(time);
  const current = zonedParts(after, zone);

  for (let offset = 0; offset <= 370; offset += 1) {
    const localDate = addLocalDays(current.year, current.month, current.day, offset);
    if (allowedWeekdays && !allowedWeekdays.has(localWeekday(localDate.year, localDate.month, localDate.day))) continue;
    if (monthlyDay !== undefined && localDate.day !== monthlyDay) continue;

    const candidate = zonedDateTimeToUtc(
      localDate.year,
      localDate.month,
      localDate.day,
      hour,
      minute,
      zone,
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return undefined;
}

function parseCronPart(part: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const rawSegment of part.split(",")) {
    const segment = rawSegment.trim();
    if (!segment) throw new Error(`Invalid cron segment in '${part}'`);

    const [rangePart, stepPart] = segment.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step '${segment}'`);

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart?.includes("-")) {
      const [startRaw, endRaw] = rangePart.split("-");
      start = Number(startRaw);
      end = Number(endRaw);
    } else {
      start = Number(rangePart);
      end = start;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron range '${segment}' (allowed ${min}-${max})`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function cronMatches(expression: string, date: Date, timeZone: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression '${expression}'. Expected 5 fields`);
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  if (!minuteField || !hourField || !dayField || !monthField || !weekdayField) {
    throw new Error(`Invalid cron expression '${expression}'`);
  }
  const parts = zonedParts(date, timeZone);
  const minutes = parseCronPart(minuteField, 0, 59);
  const hours = parseCronPart(hourField, 0, 23);
  const days = parseCronPart(dayField, 1, 31);
  const months = parseCronPart(monthField, 1, 12);
  const weekdays = parseCronPart(weekdayField, 0, 6);
  return (
    minutes.has(parts.minute) &&
    hours.has(parts.hour) &&
    days.has(parts.day) &&
    months.has(parts.month) &&
    weekdays.has(parts.weekday)
  );
}

function nextCron(expression: string, after: Date, timezone?: string): Date | undefined {
  const zone = normalizeTimeZone(timezone);
  let cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor = new Date(cursor.getTime() + 60_000);
  const maxIterations = 60 * 24 * 370;
  for (let index = 0; index < maxIterations; index += 1) {
    if (cronMatches(expression, cursor, zone)) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return undefined;
}

export function computeNextRunAt(schedule: ScheduleSpec, after = new Date()): string | undefined {
  switch (schedule.kind) {
    case "once": {
      const at = new Date(schedule.at);
      if (Number.isNaN(at.getTime())) throw new Error(`Invalid once schedule date: ${schedule.at}`);
      return at.getTime() > after.getTime() ? at.toISOString() : undefined;
    }
    case "interval": {
      if (!Number.isFinite(schedule.everyMinutes) || schedule.everyMinutes < 1) {
        throw new Error("Interval schedule requires everyMinutes >= 1");
      }
      const intervalMs = Math.floor(schedule.everyMinutes) * 60_000;
      const start = schedule.startAt ? new Date(schedule.startAt) : new Date(after.getTime() + intervalMs);
      if (Number.isNaN(start.getTime())) throw new Error(`Invalid interval startAt: ${schedule.startAt}`);
      if (start.getTime() > after.getTime()) return start.toISOString();
      const elapsed = after.getTime() - start.getTime();
      const jumps = Math.floor(elapsed / intervalMs) + 1;
      return new Date(start.getTime() + jumps * intervalMs).toISOString();
    }
    case "daily":
      return nextAtLocalTime(after, schedule.time, schedule.timezone)?.toISOString();
    case "weekdays":
      return nextAtLocalTime(after, schedule.time, schedule.timezone, new Set([1, 2, 3, 4, 5]))?.toISOString();
    case "weekly": {
      const weekdays = new Set(schedule.weekdays);
      if (!weekdays.size || [...weekdays].some((value) => !Number.isInteger(value) || value < 0 || value > 6)) {
        throw new Error("Weekly schedule requires weekdays containing values 0-6");
      }
      return nextAtLocalTime(after, schedule.time, schedule.timezone, weekdays)?.toISOString();
    }
    case "monthly": {
      if (!Number.isInteger(schedule.day) || schedule.day < 1 || schedule.day > 31) {
        throw new Error("Monthly schedule requires day between 1 and 31");
      }
      return nextAtLocalTime(after, schedule.time, schedule.timezone, undefined, schedule.day)?.toISOString();
    }
    case "cron":
      return nextCron(schedule.expression, after, schedule.timezone)?.toISOString();
  }
}

export function scheduleSummary(schedule: ScheduleSpec): string {
  switch (schedule.kind) {
    case "once": return `Once at ${schedule.at}`;
    case "interval": return `Every ${schedule.everyMinutes} minute(s)`;
    case "daily": return `Daily at ${schedule.time}`;
    case "weekdays": return `Weekdays at ${schedule.time}`;
    case "weekly": return `Weekly on ${schedule.weekdays.join(",")} at ${schedule.time}`;
    case "monthly": return `Monthly on day ${schedule.day} at ${schedule.time}`;
    case "cron": return `Cron ${schedule.expression}`;
  }
}
