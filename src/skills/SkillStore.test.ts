import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EngineerRunbook } from "../engineer/EngineerLoopEngine.js";
import { SkillStore } from "./SkillStore.js";

function verifiedRunbook(): EngineerRunbook {
  return {
    id: "runbook-1",
    tenantId: "org-test",
    loopId: "loop-1",
    title: "Recover an unhealthy service",
    objective: "Restore the service and verify health",
    symptoms: ["HTTP health check returns 503"],
    rootCause: "A stale lock prevented startup",
    fix: "Remove the stale lock after confirming no process owns it, then restart the service",
    diagnostics: ["Service status showed the stale lock error"],
    verification: ["Health endpoint returned HTTP 200"],
    rollback: ["Restore the lock backup and stop the service"],
    prevention: ["Alert on repeated stale lock startup failures"],
    createdAt: new Date().toISOString(),
  };
}

test("skill updates require the revision returned by a prior read", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cherry-skills-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new SkillStore(directory);

  const created = await store.create({
    tenantId: "org-test",
    name: "check-linux-disk",
    category: "operations",
    description: "Check Linux disk pressure safely.",
    body: "# Check Linux Disk\n\n## Procedure\n1. Inspect usage.\n\n## Verification\n- Confirm free space.",
    tags: ["Linux", "Disk"],
  });
  assert.equal(created.verified, false);
  assert.equal((await store.search("linux disk", "org-test"))[0]?.name, "check-linux-disk");

  const updated = await store.update({
    tenantId: "org-test",
    name: created.name,
    category: created.category,
    expectedRevision: created.revision,
    body: `${created.body}\n\n## Pitfalls\n- Do not delete files before identifying their owner.`,
  });
  assert.notEqual(updated.revision, created.revision);

  await assert.rejects(() => store.update({
    tenantId: "org-test",
    name: created.name,
    category: created.category,
    expectedRevision: created.revision,
    body: "stale overwrite",
  }), /changed after it was read/);
  await assert.rejects(() => store.update({
    tenantId: "org-test",
    name: created.name,
    category: created.category,
    expectedRevision: updated.revision,
    body: updated.body,
  }), /does not change/);
});

test("verified runbooks can be promoted with provenance", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cherry-runbook-skill-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new SkillStore(directory);
  const runbook = verifiedRunbook();

  const skill = await store.promoteRunbook({
    runbook,
    name: "recover-stale-lock-service",
    description: "Recover a service blocked by a stale lock.",
  });
  assert.equal(skill.verified, true);
  assert.equal(skill.source, "runbook");
  assert.equal(skill.runbookId, runbook.id);
  assert.match(skill.body, /Health endpoint returned HTTP 200/);

  const edited = await store.update({
    tenantId: runbook.tenantId,
    name: skill.name,
    category: skill.category,
    expectedRevision: skill.revision,
    body: `${skill.body}\n\n## Operator Note\n- Re-verify after changing this procedure.`,
  });
  assert.equal(edited.verified, false);
  assert.equal(edited.source, "runbook");
  assert.equal(edited.runbookId, runbook.id);
  assert.equal(edited.tags.some((tag) => tag.toLowerCase() === "verified"), false);
});

test("invalid path-shaped names are rejected", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "cherry-skill-path-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new SkillStore(directory);
  await assert.rejects(() => store.create({
    name: "../escape",
    category: "operations",
    description: "Reject unsafe paths.",
    body: "# Unsafe",
  }), /lowercase-hyphenated/);
});

test("direct skill reads refuse symbolic links", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows symlink creation requires privileges not guaranteed in CI");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "cherry-skill-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "cherry-skill-outside-"));
  context.after(async () => Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]).then(() => undefined));
  const store = new SkillStore(directory);
  const outsideFile = join(outside, "SKILL.md");
  await writeFile(outsideFile, "---\nname: \"linked-skill\"\ndescription: \"Unsafe linked procedure.\"\nversion: \"0.1.0\"\nauthor: \"attacker\"\ncategory: \"operations\"\ntags: []\nsource: \"user\"\nverified: false\ncreatedAt: \"2026-01-01T00:00:00.000Z\"\nupdatedAt: \"2026-01-01T00:00:00.000Z\"\n---\n# Unsafe\n", "utf8");
  const skillDirectory = join(directory, "org-test", "operations", "linked-skill");
  await mkdir(skillDirectory, { recursive: true });
  await symlink(outsideFile, join(skillDirectory, "SKILL.md"), "file");

  await assert.rejects(
    () => store.read("linked-skill", "operations", "org-test"),
    /symlink/,
  );
});
