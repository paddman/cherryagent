import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelAccessStore } from "./ChannelAccessStore.js";

test("unknown senders are paired before they can reach the agent", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cherry-channel-access-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new ChannelAccessStore({
    file: join(directory, "access.json"),
    defaultPolicy: "pairing",
    pairingTtlMs: 60_000,
  });

  const first = await store.evaluate({ channel: "line", senderId: "user-1", senderName: "Tester" });
  assert.equal(first.decision, "pairing");
  assert.ok(first.code);
  assert.ok(first.requestId);

  const repeated = await store.evaluate({ channel: "line", senderId: "user-1" });
  assert.equal(repeated.code, first.code);
  assert.equal(repeated.requestId, first.requestId);

  await store.approve({ channel: "line", code: first.code });
  const allowed = await store.evaluate({ channel: "line", senderId: "user-1" });
  assert.equal(allowed.decision, "allow");

  await store.revoke("line", "user-1");
  const revoked = await store.evaluate({ channel: "line", senderId: "user-1" });
  assert.equal(revoked.decision, "pairing");
});

test("allowlist policy blocks unknown senders without issuing a code", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cherry-channel-allowlist-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new ChannelAccessStore({
    file: join(directory, "access.json"),
    defaultPolicy: "allowlist",
    seedAllowFrom: ["admin"],
  });

  assert.equal((await store.evaluate({ channel: "line", senderId: "admin" })).decision, "allow");
  const blocked = await store.evaluate({ channel: "line", senderId: "stranger" });
  assert.equal(blocked.decision, "block");
  assert.equal(blocked.code, undefined);
});
