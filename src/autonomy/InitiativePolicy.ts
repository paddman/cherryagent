import type { AutonomyAction, AutonomyStore } from "./AutonomyStore.js";
import type { InitiativeReflection } from "./InitiativeReasoner.js";
import type { WorldState } from "./WorldObserver.js";

export type InitiativePolicyOptions = {
  maxActionsPerHour: number;
  maxMessagesPerDay: number;
  sameTopicCooldownMinutes: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  timezone: string;
};

export type PolicyDecision = InitiativeReflection & {
  action: AutonomyAction;
  score: number;
  policyNotes: string[];
};

const notificationActions: AutonomyAction[] = ["act_and_notify", "notify_now", "request_approval"];
const executionActions: AutonomyAction[] = ["act_silently", "act_and_notify"];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function scoreReflection(reflection: InitiativeReflection): number {
  const scores = reflection.scores;
  return clamp01(
    scores.urgency * 0.25
    + scores.userRelevance * 0.20
    + scores.expectedValue * 0.20
    + scores.novelty * 0.15
    + scores.confidence * 0.10
    + scores.actionability * 0.10
    - scores.interruptionCost * 0.20
    - scores.repetition * 0.30,
  );
}

function localHour(now: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    return hour === 24 ? 0 : hour;
  } catch {
    return now.getHours();
  }
}

function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function lowerActionForScore(reflection: InitiativeReflection, score: number): AutonomyAction {
  if (score < 0.35) return "ignore";
  if (score < 0.55) return "remember";
  if (score < 0.70) {
    return reflection.goal && reflection.proposedAction === "act_silently" ? "act_silently" : "recheck_later";
  }
  if (score < 0.85) {
    if (reflection.proposedAction === "act_silently" && reflection.goal) return "act_silently";
    if (reflection.proposedAction === "act_and_notify" && reflection.goal) return "act_and_notify";
    if (reflection.proposedAction === "notify_now" && reflection.message) return "notify_now";
    if (reflection.proposedAction === "request_approval" && reflection.message) return "request_approval";
    return reflection.goal ? "act_silently" : "recheck_later";
  }
  return reflection.proposedAction;
}

export class InitiativePolicy {
  constructor(
    private readonly store: AutonomyStore,
    private readonly options: InitiativePolicyOptions,
  ) {}

  async evaluate(reflection: InitiativeReflection, world: WorldState, now = new Date()): Promise<PolicyDecision> {
    const notes: string[] = [];
    let score = scoreReflection(reflection);

    const criticalEvent = world.pendingEvents.some((event) => event.severity === "critical");
    const highEvent = world.pendingEvents.some((event) => event.severity === "high");
    if (criticalEvent) {
      score = Math.max(score, 0.90);
      notes.push("Critical pending event raised minimum initiative score to 0.90.");
    } else if (highEvent) {
      score = Math.max(score, 0.75);
      notes.push("High-severity pending event raised minimum initiative score to 0.75.");
    }

    let action = lowerActionForScore(reflection, score);

    if (action !== "ignore" && reflection.evidence.length === 0) {
      notes.push("Non-ignore decision had no evidence and was downgraded to ignore.");
      action = "ignore";
    }

    if (executionActions.includes(action) && !reflection.goal?.trim()) {
      notes.push("Execution action had no concrete goal and was downgraded to remember.");
      action = "remember";
    }

    if (notificationActions.includes(action) && !reflection.message?.trim()) {
      notes.push("Notification action had no user-facing message and was downgraded.");
      action = reflection.goal ? "act_silently" : "remember";
    }

    const actionsLastHour = await this.store.countActionsSince(new Date(now.getTime() - 60 * 60_000));
    if (["act_silently", "act_and_notify", "notify_now", "request_approval"].includes(action)
      && actionsLastHour >= this.options.maxActionsPerHour
      && !criticalEvent) {
      notes.push(`Hourly autonomy action budget reached (${actionsLastHour}/${this.options.maxActionsPerHour}).`);
      action = "remember";
    }

    const recentTopic = await this.store.findRecentTopicDecision(
      reflection.topic,
      new Date(now.getTime() - this.options.sameTopicCooldownMinutes * 60_000),
    );
    if (recentTopic && notificationActions.includes(action) && reflection.scores.urgency < 0.95 && reflection.scores.novelty < 0.95) {
      notes.push(`Same-topic cooldown active for '${reflection.topic}'.`);
      action = reflection.goal ? "act_silently" : "remember";
    }

    const messagesLastDay = await this.store.countNotificationsSince(new Date(now.getTime() - 24 * 60 * 60_000));
    if (notificationActions.includes(action) && messagesLastDay >= this.options.maxMessagesPerDay && !criticalEvent) {
      notes.push(`Rolling 24-hour proactive message budget reached (${messagesLastDay}/${this.options.maxMessagesPerDay}).`);
      action = reflection.goal ? "act_silently" : "remember";
    }

    const hour = localHour(now, this.options.timezone);
    const quiet = inQuietHours(hour, this.options.quietHoursStart, this.options.quietHoursEnd);
    if (quiet && notificationActions.includes(action) && reflection.scores.urgency < 0.90 && !criticalEvent) {
      notes.push(`Quiet hours are active in ${this.options.timezone}; non-urgent interruption suppressed.`);
      action = reflection.goal ? "act_silently" : "remember";
    }

    return {
      ...reflection,
      action,
      score,
      policyNotes: notes,
    };
  }
}
