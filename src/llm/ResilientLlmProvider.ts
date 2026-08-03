import type { CompletionRequest, CompletionResult, LlmProvider } from "../core/types.js";
import {
  OpenAICompatibleProvider,
  OpenAICompatibleProviderError,
  type OpenAICompatibleProviderOptions,
} from "./OpenAICompatibleProvider.js";

export type LlmFailureReason =
  | "aborted"
  | "auth"
  | "billing"
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "server_error"
  | "network"
  | "invalid_request"
  | "unknown";

export type ResilientLlmProfile = OpenAICompatibleProviderOptions & {
  id: string;
};

export type LlmFailoverAttempt = {
  profileId: string;
  model: string;
  baseUrl: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  reason?: LlmFailureReason;
  status?: number;
  error?: string;
};

export type ResilientLlmProfileStatus = {
  id: string;
  model: string;
  baseUrl: string;
  available: boolean;
  errorCount: number;
  lastUsedAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: LlmFailureReason | null;
  cooldownUntil: string | null;
  disabledUntil: string | null;
};

export type LlmFailoverReport = {
  startedAt: string;
  completedAt: string;
  selectedProfileId: string | null;
  attempts: LlmFailoverAttempt[];
  nextRetryAt: string | null;
};

type ProfileRuntimeState = {
  errorCount: number;
  lastUsedAt: number | null;
  lastFailureAt: number | null;
  lastFailureReason: LlmFailureReason | null;
  cooldownUntil: number;
  disabledUntil: number;
};

type FailureClassification = {
  reason: LlmFailureReason;
  failover: boolean;
  status?: number;
  retryAfterMs?: number;
};

type ProviderFactory = (profile: ResilientLlmProfile) => LlmProvider;

const TRANSIENT_COOLDOWNS_MS = [30_000, 60_000, 300_000] as const;
const AUTH_DISABLE_MS = 5 * 60_000;
const BILLING_DISABLE_MS = 30 * 60_000;

function nowIso(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString();
}

function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 1_000);
}

function includesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyLlmFailure(error: unknown): FailureClassification {
  if (error instanceof OpenAICompatibleProviderError && error.externalAbort) {
    return { reason: "aborted", failover: false, ...(error.status !== undefined ? { status: error.status } : {}) };
  }

  const status = error instanceof OpenAICompatibleProviderError ? error.status : undefined;
  const retryAfterMs = error instanceof OpenAICompatibleProviderError ? error.retryAfterMs : undefined;
  const message = safeErrorMessage(error).toLowerCase();

  if (status === 401 || status === 403 || includesAny(message, [
    /invalid api key/,
    /incorrect api key/,
    /authentication failed/,
    /unauthorized/,
    /token (?:is )?expired/,
    /revoked key/,
  ])) {
    return { reason: "auth", failover: true, ...(status !== undefined ? { status } : {}) };
  }

  if (status === 402 || includesAny(message, [
    /insufficient (?:credit|balance)/,
    /credit balance too low/,
    /billing/,
    /payment required/,
  ])) {
    return { reason: "billing", failover: true, ...(status !== undefined ? { status } : {}) };
  }

  if (status === 429 || includesAny(message, [
    /rate.?limit/,
    /too many requests/,
    /quota (?:limit|exceeded)/,
    /resource exhausted/,
    /throttl/,
    /concurrency limit/,
  ])) {
    return {
      reason: "rate_limit",
      failover: true,
      ...(status !== undefined ? { status } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  if (includesAny(message, [
    /overload/,
    /model not ready/,
    /temporarily unavailable/,
    /no available worker/,
    /service busy/,
  ])) {
    return {
      reason: "overloaded",
      failover: true,
      ...(status !== undefined ? { status } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  if (error instanceof OpenAICompatibleProviderError && error.timedOut) {
    return { reason: "timeout", failover: true, ...(status !== undefined ? { status } : {}) };
  }
  if (status === 408 || includesAny(message, [/timed out/, /timeout/, /socket hang up/])) {
    return { reason: "timeout", failover: true, ...(status !== undefined ? { status } : {}) };
  }

  if (status !== undefined && status >= 500) {
    return {
      reason: "server_error",
      failover: true,
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  if (error instanceof OpenAICompatibleProviderError && error.networkFailure) {
    return { reason: "network", failover: true };
  }
  if (includesAny(message, [/fetch failed/, /network/, /connection refused/, /econnreset/, /enotfound/])) {
    return { reason: "network", failover: true, ...(status !== undefined ? { status } : {}) };
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return { reason: "invalid_request", failover: false, status };
  }

  return { reason: "unknown", failover: false, ...(status !== undefined ? { status } : {}) };
}

export class LlmFallbackError extends Error {
  readonly attempts: LlmFailoverAttempt[];
  readonly nextRetryAt: string | null;

  constructor(attempts: LlmFailoverAttempt[], nextRetryAt: string | null) {
    const summary = attempts.length
      ? attempts.map((attempt) => `${attempt.profileId}:${attempt.reason ?? "unknown"}`).join(", ")
      : "no profile was currently available";
    super(`All configured LLM profiles failed (${summary})${nextRetryAt ? `. Next retry after ${nextRetryAt}` : ""}.`);
    this.name = "LlmFallbackError";
    this.attempts = attempts;
    this.nextRetryAt = nextRetryAt;
  }
}

export class ResilientLlmProvider implements LlmProvider {
  readonly #profiles: Array<{ config: ResilientLlmProfile; provider: LlmProvider }>;
  readonly #states = new Map<string, ProfileRuntimeState>();
  #lastReport: LlmFailoverReport | null = null;

  constructor(
    profiles: readonly ResilientLlmProfile[],
    providerFactory: ProviderFactory = (profile) => new OpenAICompatibleProvider(profile),
  ) {
    if (!profiles.length) throw new Error("At least one LLM profile is required");
    const seen = new Set<string>();
    this.#profiles = profiles.map((profile) => {
      const id = profile.id.trim();
      if (!id || !/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw new Error(`Invalid LLM profile id: ${profile.id}`);
      if (seen.has(id)) throw new Error(`Duplicate LLM profile id: ${id}`);
      seen.add(id);
      const normalized: ResilientLlmProfile = {
        ...profile,
        id,
        baseUrl: profile.baseUrl.replace(/\/$/, ""),
      };
      this.#states.set(id, {
        errorCount: 0,
        lastUsedAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
        cooldownUntil: 0,
        disabledUntil: 0,
      });
      return { config: normalized, provider: providerFactory(normalized) };
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("LLM request aborted");

    const startedAtMs = Date.now();
    const attempts: LlmFailoverAttempt[] = [];
    const available = this.#availableProfiles(startedAtMs);
    if (!available.length) {
      const nextRetryAt = this.#nextRetryAt(startedAtMs);
      this.#lastReport = {
        startedAt: nowIso(startedAtMs),
        completedAt: nowIso(),
        selectedProfileId: null,
        attempts,
        nextRetryAt,
      };
      throw new LlmFallbackError(attempts, nextRetryAt);
    }

    for (const runtime of available) {
      if (request.signal?.aborted) throw request.signal.reason ?? new Error("LLM request aborted");
      const attemptStarted = Date.now();
      try {
        const result = await runtime.provider.complete(request);
        const completed = Date.now();
        const state = this.#requireState(runtime.config.id);
        state.errorCount = 0;
        state.lastUsedAt = completed;
        state.lastFailureAt = null;
        state.lastFailureReason = null;
        state.cooldownUntil = 0;
        state.disabledUntil = 0;
        attempts.push({
          profileId: runtime.config.id,
          model: runtime.config.model,
          baseUrl: runtime.config.baseUrl,
          startedAt: nowIso(attemptStarted),
          completedAt: nowIso(completed),
          durationMs: completed - attemptStarted,
          ok: true,
        });
        this.#lastReport = {
          startedAt: nowIso(startedAtMs),
          completedAt: nowIso(completed),
          selectedProfileId: runtime.config.id,
          attempts,
          nextRetryAt: null,
        };
        return result;
      } catch (error) {
        const completed = Date.now();
        const failure = classifyLlmFailure(error);
        attempts.push({
          profileId: runtime.config.id,
          model: runtime.config.model,
          baseUrl: runtime.config.baseUrl,
          startedAt: nowIso(attemptStarted),
          completedAt: nowIso(completed),
          durationMs: completed - attemptStarted,
          ok: false,
          reason: failure.reason,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          error: safeErrorMessage(error),
        });

        if (!failure.failover) {
          this.#lastReport = {
            startedAt: nowIso(startedAtMs),
            completedAt: nowIso(completed),
            selectedProfileId: null,
            attempts,
            nextRetryAt: null,
          };
          throw error;
        }
        this.#markFailure(runtime.config.id, failure, completed);
      }
    }

    const completedAtMs = Date.now();
    const nextRetryAt = this.#nextRetryAt(completedAtMs);
    this.#lastReport = {
      startedAt: nowIso(startedAtMs),
      completedAt: nowIso(completedAtMs),
      selectedProfileId: null,
      attempts,
      nextRetryAt,
    };
    throw new LlmFallbackError(attempts, nextRetryAt);
  }

  getStatus(now = Date.now()): { healthy: boolean; profiles: ResilientLlmProfileStatus[]; lastReport: LlmFailoverReport | null } {
    const profiles = this.#profiles.map(({ config }) => {
      const state = this.#requireState(config.id);
      return {
        id: config.id,
        model: config.model,
        baseUrl: config.baseUrl,
        available: state.cooldownUntil <= now && state.disabledUntil <= now,
        errorCount: state.errorCount,
        lastUsedAt: state.lastUsedAt === null ? null : nowIso(state.lastUsedAt),
        lastFailureAt: state.lastFailureAt === null ? null : nowIso(state.lastFailureAt),
        lastFailureReason: state.lastFailureReason,
        cooldownUntil: state.cooldownUntil > now ? nowIso(state.cooldownUntil) : null,
        disabledUntil: state.disabledUntil > now ? nowIso(state.disabledUntil) : null,
      } satisfies ResilientLlmProfileStatus;
    });
    return { healthy: profiles.some((profile) => profile.available), profiles, lastReport: this.#lastReport ? structuredClone(this.#lastReport) : null };
  }

  resetProfile(profileId: string): void {
    const state = this.#requireState(profileId);
    state.errorCount = 0;
    state.lastFailureAt = null;
    state.lastFailureReason = null;
    state.cooldownUntil = 0;
    state.disabledUntil = 0;
  }

  #availableProfiles(now: number): Array<{ config: ResilientLlmProfile; provider: LlmProvider }> {
    return this.#profiles.filter(({ config }) => {
      const state = this.#requireState(config.id);
      return state.cooldownUntil <= now && state.disabledUntil <= now;
    });
  }

  #markFailure(profileId: string, failure: FailureClassification, now: number): void {
    const state = this.#requireState(profileId);
    state.errorCount += 1;
    state.lastFailureAt = now;
    state.lastFailureReason = failure.reason;

    if (failure.reason === "auth") {
      state.disabledUntil = Math.max(state.disabledUntil, now + AUTH_DISABLE_MS);
      return;
    }
    if (failure.reason === "billing") {
      state.disabledUntil = Math.max(state.disabledUntil, now + BILLING_DISABLE_MS);
      return;
    }

    const cooldownIndex = Math.min(state.errorCount - 1, TRANSIENT_COOLDOWNS_MS.length - 1);
    const baseCooldown = TRANSIENT_COOLDOWNS_MS[cooldownIndex] ?? TRANSIENT_COOLDOWNS_MS[TRANSIENT_COOLDOWNS_MS.length - 1];
    const delay = Math.max(baseCooldown, failure.retryAfterMs ?? 0);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + delay);
  }

  #nextRetryAt(now: number): string | null {
    const candidates = this.#profiles
      .map(({ config }) => {
        const state = this.#requireState(config.id);
        return Math.max(state.cooldownUntil, state.disabledUntil);
      })
      .filter((value) => value > now)
      .sort((left, right) => left - right);
    const earliest = candidates[0];
    return earliest === undefined ? null : nowIso(earliest);
  }

  #requireState(profileId: string): ProfileRuntimeState {
    const state = this.#states.get(profileId);
    if (!state) throw new Error(`Unknown LLM profile: ${profileId}`);
    return state;
  }
}
