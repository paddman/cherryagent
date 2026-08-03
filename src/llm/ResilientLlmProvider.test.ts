import assert from "node:assert/strict";
import test from "node:test";
import type { CompletionRequest, CompletionResult, LlmProvider } from "../core/types.js";
import { OpenAICompatibleProviderError } from "./OpenAICompatibleProvider.js";
import { ResilientLlmProvider, type ResilientLlmProfile } from "./ResilientLlmProvider.js";

const request: CompletionRequest = {
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

class FakeProvider implements LlmProvider {
  calls = 0;

  constructor(private readonly handler: () => CompletionResult | Promise<CompletionResult>) {}

  async complete(): Promise<CompletionResult> {
    this.calls += 1;
    return await this.handler();
  }
}

function profiles(): ResilientLlmProfile[] {
  return [
    { id: "primary", baseUrl: "http://primary/v1", apiKey: "secret", model: "primary-model" },
    { id: "fallback", baseUrl: "http://fallback/v1", apiKey: "secret", model: "fallback-model" },
  ];
}

test("falls back on rate limits and records cooldown", async () => {
  const primary = new FakeProvider(() => {
    throw new OpenAICompatibleProviderError("Too many requests", { status: 429, retryAfterMs: 45_000 });
  });
  const fallback = new FakeProvider(() => ({ message: { role: "assistant", content: "fallback answer" } }));
  const provider = new ResilientLlmProvider(profiles(), (profile) => profile.id === "primary" ? primary : fallback);

  const result = await provider.complete(request);
  assert.equal(result.message.content, "fallback answer");
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 1);

  const status = provider.getStatus();
  assert.equal(status.lastReport?.selectedProfileId, "fallback");
  assert.equal(status.profiles.find((item) => item.id === "primary")?.available, false);
  assert.equal(status.profiles.find((item) => item.id === "primary")?.lastFailureReason, "rate_limit");
});

test("does not hide invalid requests behind a fallback", async () => {
  const primary = new FakeProvider(() => {
    throw new OpenAICompatibleProviderError("invalid tool schema", { status: 400 });
  });
  const fallback = new FakeProvider(() => ({ message: { role: "assistant", content: "should not run" } }));
  const provider = new ResilientLlmProvider(profiles(), (profile) => profile.id === "primary" ? primary : fallback);

  await assert.rejects(() => provider.complete(request), /invalid tool schema/);
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 0);
});

test("external abort never rotates profiles", async () => {
  const primary = new FakeProvider(() => {
    throw new OpenAICompatibleProviderError("aborted", { externalAbort: true });
  });
  const fallback = new FakeProvider(() => ({ message: { role: "assistant", content: "should not run" } }));
  const provider = new ResilientLlmProvider(profiles(), (profile) => profile.id === "primary" ? primary : fallback);

  await assert.rejects(() => provider.complete(request), /aborted/);
  assert.equal(fallback.calls, 0);
});
