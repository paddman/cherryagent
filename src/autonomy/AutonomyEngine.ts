import type { AgentOrchestrator } from "../agentic/AgentOrchestrator.js";
import type { ToolContext } from "../core/types.js";
import type { AutonomyDecision, AutonomyEvent, AutonomyEventSeverity, AutonomyStore } from "./AutonomyStore.js";
import type { InitiativePolicy } from "./InitiativePolicy.js";
import type { InitiativeReasoner } from "./InitiativeReasoner.js";
import type { ProactiveNotifier } from "./ProactiveNotifier.js";
import type { WorldObserver } from "./WorldObserver.js";

export type AutonomyEngineOptions = {
  enabled: boolean;
  minIntervalMs: number;
  maxIntervalMs: number;
  workspaceRoot: string;
  userId?: string;
};

export type AutonomyPulseResult = {
  trigger: string;
  decision: AutonomyDecision;
  nextDelayMs: number;
};

export type AutonomyEngineStatus = {
  enabled: boolean;
  started: boolean;
  running: boolean;
  currentDelayMs: number;
  lastPulseAt?: string;
  nextPulseAt?: string;
  lastDecision?: AutonomyDecision;
  lastError?: string;
};

function concise(value: string | undefined, fallback: string, max = 4000): string {
  const text = value?.trim() || fallback;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export class AutonomyEngine {
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #running = false;
  #currentDelayMs: number;
  #lastPulseAt?: string;
  #nextPulseAt?: string;
  #lastDecision?: AutonomyDecision;
  #lastError?: string;
  #pendingTrigger?: string;

  constructor(private readonly dependencies: {
    observer: WorldObserver;
    reasoner: InitiativeReasoner;
    policy: InitiativePolicy;
    store: AutonomyStore;
    orchestrator: AgentOrchestrator;
    notifier: ProactiveNotifier;
  }, private readonly options: AutonomyEngineOptions) {
    this.#currentDelayMs = Math.max(1_000, options.minIntervalMs);
  }

  get status(): AutonomyEngineStatus {
    return {
      enabled: this.options.enabled,
      started: this.#started,
      running: this.#running,
      currentDelayMs: this.#currentDelayMs,
      ...(this.#lastPulseAt ? { lastPulseAt: this.#lastPulseAt } : {}),
      ...(this.#nextPulseAt ? { nextPulseAt: this.#nextPulseAt } : {}),
      ...(this.#lastDecision ? { lastDecision: structuredClone(this.#lastDecision) } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  start(): void {
    if (this.#started || !this.options.enabled) return;
    this.#started = true;
    this.#schedule(1_000, "startup");
  }

  stop(): void {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#nextPulseAt = undefined;
  }

  wake(reason: string): void {
    const trigger = reason.trim() || "event";
    this.#pendingTrigger = trigger;
    if (!this.#started || this.#running) return;
    this.#schedule(250, trigger);
  }

  async ingestEvent(input: {
    source: string;
    type: string;
    summary: string;
    severity?: AutonomyEventSeverity;
    data?: unknown;
  }): Promise<AutonomyEvent> {
    const event = await this.dependencies.store.addEvent(input);
    this.wake(`event:${event.source}:${event.type}`);
    return event;
  }

  async pulse(trigger = "heartbeat"): Promise<AutonomyPulseResult> {
    if (this.#running) {
      throw new Error("Autonomy pulse skipped because a previous pulse is still running");
    }

    this.#running = true;
    this.#lastPulseAt = new Date().toISOString();
    this.#nextPulseAt = undefined;
    this.#lastError = undefined;
    const pendingTrigger = this.#pendingTrigger;
    this.#pendingTrigger = undefined;
    const effectiveTrigger = pendingTrigger ?? trigger;

    try {
      const world = await this.dependencies.observer.observe();
      const reflection = await this.dependencies.reasoner.reflect(world, effectiveTrigger);
      const policyDecision = await this.dependencies.policy.evaluate(reflection, world);
      await this.dependencies.store.upsertThoughts(policyDecision.thoughts);

      let decision = await this.dependencies.store.recordDecision({
        action: policyDecision.action,
        topic: policyDecision.topic,
        reason: [policyDecision.reason, ...policyDecision.policyNotes].filter(Boolean).join(" "),
        evidence: policyDecision.evidence,
        scores: policyDecision.scores,
        score: policyDecision.score,
        trigger: effectiveTrigger,
        ...(policyDecision.goal ? { goal: policyDecision.goal } : {}),
        ...(policyDecision.message ? { message: policyDecision.message } : {}),
      });

      await this.dependencies.store.markEventsProcessed(
        world.pendingEvents.map((event) => event.id),
        decision.id,
      );

      if (policyDecision.action === "ignore") {
        decision = await this.dependencies.store.updateDecision(decision.id, { outcome: "No autonomous action taken." });
      } else if (policyDecision.action === "remember") {
        decision = await this.dependencies.store.updateDecision(decision.id, { outcome: "Context retained in autonomy memory." });
      } else if (policyDecision.action === "recheck_later") {
        decision = await this.dependencies.store.updateDecision(decision.id, { outcome: "Deferred for future observation." });
      } else if (policyDecision.action === "act_silently" || policyDecision.action === "act_and_notify") {
        const context: ToolContext = {
          sessionId: `autonomy:${decision.id}`,
          userId: this.options.userId ?? "autonomy",
          workspaceRoot: this.options.workspaceRoot,
        };
        const run = await this.dependencies.orchestrator.runGoal({ goal: policyDecision.goal ?? policyDecision.topic }, context);
        const outcome = concise(
          run.synthesis ?? run.blockedReason,
          `Autonomous run finished with status ${run.status}.`,
        );
        decision = await this.dependencies.store.updateDecision(decision.id, {
          runId: run.id,
          outcome: `${run.status}: ${outcome}`,
        });

        if (policyDecision.action === "act_and_notify") {
          const message = concise(
            policyDecision.message,
            `Cherry investigated '${policyDecision.topic}' proactively. ${outcome}`,
            5000,
          );
          await this.dependencies.notifier.notify({
            decisionId: decision.id,
            topic: decision.topic,
            message,
          });
          decision = await this.dependencies.store.updateDecision(decision.id, {
            notifiedAt: new Date().toISOString(),
            message,
          });
        }
      } else {
        const message = concise(
          policyDecision.message,
          policyDecision.action === "request_approval"
            ? `Cherry found a useful next step for '${policyDecision.topic}' that needs your approval.`
            : `Cherry noticed something important about '${policyDecision.topic}'.`,
          5000,
        );
        await this.dependencies.notifier.notify({
          decisionId: decision.id,
          topic: decision.topic,
          message,
        });
        decision = await this.dependencies.store.updateDecision(decision.id, {
          notifiedAt: new Date().toISOString(),
          message,
          outcome: policyDecision.action === "request_approval" ? "User approval requested." : "User notified proactively.",
        });
      }

      this.#lastDecision = decision;
      this.#currentDelayMs = this.#chooseNextDelay(policyDecision.score, policyDecision.action, world.pendingEvents.length);
      return {
        trigger: effectiveTrigger,
        decision,
        nextDelayMs: this.#currentDelayMs,
      };
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#currentDelayMs = Math.min(this.options.maxIntervalMs, Math.max(this.options.minIntervalMs, this.#currentDelayMs * 2));
      throw error;
    } finally {
      this.#running = false;
      if (this.#started && this.options.enabled) {
        const queued = this.#pendingTrigger;
        if (queued) this.#schedule(250, queued);
        else this.#schedule(this.#currentDelayMs, "heartbeat");
      }
    }
  }

  #chooseNextDelay(score: number, action: AutonomyDecision["action"], pendingEvents: number): number {
    if (pendingEvents > 0 || score >= 0.85 || action === "request_approval") {
      return Math.max(1_000, this.options.minIntervalMs);
    }
    if (action === "ignore") {
      return Math.min(this.options.maxIntervalMs, Math.max(this.options.minIntervalMs, Math.round(this.#currentDelayMs * 1.5)));
    }
    return Math.min(
      this.options.maxIntervalMs,
      Math.max(this.options.minIntervalMs, Math.round((this.options.minIntervalMs + this.options.maxIntervalMs) / 2)),
    );
  }

  #schedule(delayMs: number, trigger: string): void {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    const delay = Math.min(this.options.maxIntervalMs, Math.max(250, Math.round(delayMs)));
    this.#nextPulseAt = new Date(Date.now() + delay).toISOString();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.pulse(trigger).catch((error) => {
        console.error(`[autonomy:${trigger}] ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delay);
    this.#timer.unref?.();
  }
}
