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

  await assert.rejects(() => store.revoke("line", "admin"), /CHERRY_CHANNEL_ALLOW_FROM/);
  assert.equal((await store.evaluate({ channel: "line", senderId: "admin" })).decision, "allow");
});

test("approval racing with evaluation cannot recreate a pairing request", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cherry-channel-race-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new ChannelAccessStore({
    file: join(directory, "access.json"),
    defaultPolicy: "pairing",
  });

  const pending = await store.evaluate({ channel: "line", senderId: "user-race" });
  assert.ok(pending.code);

  const [, evaluated] = await Promise.all([
    store.approve({ channel: "line", code: pending.code }),
    store.evaluate({ channel: "line", senderId: "user-race" }),
  ]);
  assert.equal(evaluated.decision, "allow");
  assert.equal((await store.list("line"))[0]?.pending.length, 0);
});

test("new environment allowlist seeds remain effective after state already exists", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cherry-channel-seed-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "access.json");

  const firstStore = new ChannelAccessStore({ file, defaultPolicy: "pairing" });
  await firstStore.evaluate({ channel: "line", senderId: "pending-user" });

  const restartedStore = new ChannelAccessStore({
    file,
    defaultPolicy: "pairing",
    seedAllowFrom: ["new-admin"],
  });
  assert.equal((await restartedStore.evaluate({ channel: "line", senderId: "new-admin" })).decision, "allow");
});
