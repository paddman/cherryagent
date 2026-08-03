import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { EngineerRunbook } from "../engineer/EngineerLoopEngine.js";
import { DEFAULT_TENANT_ID } from "../tenancy/constants.js";

export type SkillSource = "user" | "agent" | "runbook";

export type SkillRecord = {
  tenantId: string;
  name: string;
  category: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  source: SkillSource;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
  body: string;
  path: string;
  revision: string;
  runbookId?: string;
};

export type SkillSummary = Omit<SkillRecord, "body">;

type SkillMetadata = Omit<SkillRecord, "tenantId" | "body" | "path" | "revision">;

const MAX_SKILL_BYTES = 256_000;
const MAX_SKILLS = 2_000;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function nowIso(): string {
  return new Date().toISOString();
}

function revisionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function tenantSegment(value?: string): string {
  const tenantId = value?.trim() || DEFAULT_TENANT_ID;
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId) || tenantId === "." || tenantId === "..") {
    throw new Error("tenantId contains unsupported path characters");
  }
  return tenantId;
}

function skillSegment(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!NAME_PATTERN.test(normalized)) {
    throw new Error(`${label} must be lowercase-hyphenated and contain at most 64 characters`);
  }
  return normalized;
}

function cleanDescription(value: string): string {
  const description = value.replace(/\s+/g, " ").trim();
  if (!description) throw new Error("description is required");
  if ([...description].length > 60) throw new Error("description must contain at most 60 characters");
  return description;
}

function cleanBody(value: string): string {
  const body = value.trim();
  if (!body) throw new Error("skill body is required");
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BYTES) {
    throw new Error(`skill body exceeds ${MAX_SKILL_BYTES} bytes`);
  }
  return `${body}\n`;
}

function cleanTags(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value && value.length <= 40))]
    .slice(0, 12);
}

function decodeScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseFrontmatter(raw: string): { metadata: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter");
  const metadata: Record<string, unknown> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (key) metadata[key] = decodeScalar(value);
  }
  return { metadata, body: match[2] ?? "" };
}

function stringField(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`SKILL.md is missing ${key}`);
  return value.trim();
}

function renderDocument(metadata: SkillMetadata, body: string): string {
  const lines = [
    "---",
    `name: ${JSON.stringify(metadata.name)}`,
    `description: ${JSON.stringify(metadata.description)}`,
    `version: ${JSON.stringify(metadata.version)}`,
    `author: ${JSON.stringify(metadata.author)}`,
    `category: ${JSON.stringify(metadata.category)}`,
    `tags: ${JSON.stringify(metadata.tags)}`,
    `source: ${JSON.stringify(metadata.source)}`,
    `verified: ${metadata.verified ? "true" : "false"}`,
    `createdAt: ${JSON.stringify(metadata.createdAt)}`,
    `updatedAt: ${JSON.stringify(metadata.updatedAt)}`,
    ...(metadata.runbookId ? [`runbookId: ${JSON.stringify(metadata.runbookId)}`] : []),
    "---",
    body.trim(),
    "",
  ];
  return lines.join("\n");
}

function asSource(value: unknown): SkillSource {
  return value === "user" || value === "agent" || value === "runbook" ? value : "user";
}

function asTags(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? cleanTags(value) : [];
}

function summarize(record: SkillRecord): SkillSummary {
  const { body: _body, ...summary } = record;
  return summary;
}

export class SkillStore {
  readonly #root: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async create(input: {
    tenantId?: string;
    name: string;
    category: string;
    description: string;
    body: string;
    tags?: string[];
    source?: SkillSource;
    verified?: boolean;
    runbookId?: string;
  }): Promise<SkillRecord> {
    const tenantId = tenantSegment(input.tenantId);
    const name = skillSegment(input.name, "name");
    const category = skillSegment(input.category, "category");
    const target = this.#skillPath(tenantId, category, name);
    const createdAt = nowIso();
    const metadata: SkillMetadata = {
      name,
      category,
      description: cleanDescription(input.description),
      version: "0.1.0",
      author: "CherryAgent",
      tags: cleanTags(input.tags),
      source: input.source ?? "agent",
      verified: input.verified ?? false,
      createdAt,
      updatedAt: createdAt,
      ...(input.runbookId?.trim() ? { runbookId: input.runbookId.trim() } : {}),
    };
    const content = renderDocument(metadata, cleanBody(input.body));

    return await this.#mutate(async () => {
      try {
        await lstat(target);
        throw new Error(`Skill already exists: ${category}/${name}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.#atomicWrite(target, content);
      return this.#parseRecord(tenantId, target, content);
    });
  }

  async update(input: {
    tenantId?: string;
    name: string;
    category?: string;
    expectedRevision: string;
    description?: string;
    body?: string;
    tags?: string[];
  }): Promise<SkillRecord> {
    const tenantId = tenantSegment(input.tenantId);
    return await this.#mutate(async () => {
      const current = await this.read(input.name, input.category, tenantId);
      if (current.revision !== input.expectedRevision.trim()) {
        throw new Error("Skill changed after it was read; read it again before updating");
      }
      const metadata: SkillMetadata = {
        name: current.name,
        category: current.category,
        description: input.description === undefined ? current.description : cleanDescription(input.description),
        version: current.version,
        author: current.author,
        tags: input.tags === undefined ? current.tags : cleanTags(input.tags),
        source: current.source,
        verified: current.verified,
        createdAt: current.createdAt,
        updatedAt: nowIso(),
        ...(current.runbookId ? { runbookId: current.runbookId } : {}),
      };
      const content = renderDocument(metadata, input.body === undefined ? current.body : cleanBody(input.body));
      await this.#atomicWrite(current.path, content);
      return this.#parseRecord(tenantId, current.path, content);
    });
  }

  async promoteRunbook(input: {
    tenantId?: string;
    runbook: EngineerRunbook;
    name: string;
    category?: string;
    description: string;
    tags?: string[];
    whenToUse?: string[];
  }): Promise<SkillRecord> {
    const runbook = input.runbook;
    if (!runbook.verification.length) throw new Error("Only a verified runbook can be promoted to a skill");
    const whenToUse = (input.whenToUse?.length ? input.whenToUse : runbook.symptoms).slice(0, 20);
    const body = [
      `# ${runbook.title}`,
      "",
      "This skill captures a procedure learned from a completed CherryAgent Engineer Loop. Follow it only when the observed symptoms and environment match; otherwise start a new diagnostic loop.",
      "",
      "## When to Use",
      ...(whenToUse.length ? whenToUse.map((item) => `- ${item}`) : ["- The objective and symptoms match the source runbook."]),
      "",
      "## Procedure",
      `1. Confirm the objective: ${runbook.objective}`,
      ...runbook.diagnostics.map((item, index) => `${index + 2}. Diagnostic evidence: ${item}`),
      `${runbook.diagnostics.length + 2}. Apply the verified fix: ${runbook.fix}`,
      "",
      "## Verification",
      ...runbook.verification.map((item) => `- ${item}`),
      "",
      "## Rollback",
      ...(runbook.rollback.length ? runbook.rollback.map((item) => `- ${item}`) : ["- No rollback procedure was recorded; require human approval before a consequential change."]),
      "",
      "## Prevention",
      ...(runbook.prevention.length ? runbook.prevention.map((item) => `- ${item}`) : ["- No preventive action was recorded."]),
      "",
      "## Provenance",
      `- Runbook ID: ${runbook.id}`,
      `- Engineer Loop ID: ${runbook.loopId}`,
      `- Root cause: ${runbook.rootCause}`,
    ].join("\n");

    return this.create({
      tenantId: input.tenantId ?? runbook.tenantId,
      name: input.name,
      category: input.category ?? "operations",
      description: input.description,
      body,
      tags: cleanTags([...(input.tags ?? []), "Verified", "Runbook"]),
      source: "runbook",
      verified: true,
      runbookId: runbook.id,
    });
  }

  async read(nameInput: string, categoryInput?: string, tenantIdInput?: string): Promise<SkillRecord> {
    const tenantId = tenantSegment(tenantIdInput);
    const name = skillSegment(nameInput, "name");
    if (categoryInput) {
      const category = skillSegment(categoryInput, "category");
      const target = this.#skillPath(tenantId, category, name);
      const content = await readFile(target, "utf8");
      return this.#parseRecord(tenantId, target, content);
    }

    const matches = (await this.list(tenantId)).filter((skill) => skill.name === name);
    if (!matches.length) throw new Error(`Skill not found: ${name}`);
    if (matches.length > 1) throw new Error(`Skill name is ambiguous; provide category for ${name}`);
    const selected = matches[0];
    if (!selected) throw new Error(`Skill not found: ${name}`);
    const content = await readFile(selected.path, "utf8");
    return this.#parseRecord(tenantId, selected.path, content);
  }

  async list(tenantIdInput?: string): Promise<SkillSummary[]> {
    const tenantId = tenantSegment(tenantIdInput);
    const tenantRoot = this.#assertInsideRoot(resolve(this.#root, tenantId));
    const files: string[] = [];
    const pending = [tenantRoot];

    while (pending.length && files.length < MAX_SKILLS) {
      const directory = pending.pop();
      if (!directory) break;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const target = this.#assertInsideRoot(resolve(directory, entry.name));
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile() && entry.name === "SKILL.md") files.push(target);
        if (files.length >= MAX_SKILLS) break;
      }
    }

    const output: SkillSummary[] = [];
    for (const path of files) {
      const content = await readFile(path, "utf8");
      output.push(summarize(this.#parseRecord(tenantId, path, content)));
    }
    return output.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async search(queryInput: string, tenantIdInput?: string, limit = 8): Promise<SkillSummary[]> {
    const query = queryInput.replace(/\s+/g, " ").trim().toLowerCase();
    if (!query) return (await this.list(tenantIdInput)).slice(0, Math.max(1, limit));
    const terms = query.split(" ").filter(Boolean);
    const records = await this.list(tenantIdInput);
    return records
      .map((record) => {
        const haystack = `${record.name} ${record.category} ${record.description} ${record.tags.join(" ")}`.toLowerCase();
        const score = (haystack.includes(query) ? 20 : 0)
          + terms.reduce((total, term) => total + (haystack.includes(term) ? 3 : 0), 0)
          + (record.verified ? 2 : 0);
        return { record, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
      .slice(0, Math.min(Math.max(1, limit), 50))
      .map((item) => item.record);
  }

  root(): string {
    return this.#root;
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolveResultPromise, rejectResultPromise) => {
      resolveResult = resolveResultPromise;
      rejectResult = rejectResultPromise;
    });
    this.#writeQueue = this.#writeQueue.catch(() => undefined).then(async () => {
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  #skillPath(tenantId: string, category: string, name: string): string {
    return this.#assertInsideRoot(resolve(this.#root, tenantId, category, name, "SKILL.md"));
  }

  #assertInsideRoot(path: string): string {
    const target = resolve(path);
    const rel = relative(this.#root, target);
    if (!rel || rel === ".") return target;
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(this.#root, rel) !== target) {
      throw new Error("Skill path escapes the configured skills root");
    }
    return target;
  }

  async #assertNoSymlinkParents(path: string): Promise<void> {
    const rel = relative(this.#root, path);
    const parts = rel.split(sep).filter(Boolean);
    let current = this.#root;
    for (const part of parts.slice(0, -1)) {
      current = resolve(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error(`Refusing skill write through symlink: ${current}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async #atomicWrite(path: string, content: string): Promise<void> {
    this.#assertInsideRoot(path);
    await this.#assertNoSymlinkParents(path);
    const parent = resolve(path, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await this.#assertNoSymlinkParents(path);
    const temporary = resolve(parent, `.SKILL.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  #parseRecord(tenantId: string, path: string, content: string): SkillRecord {
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES + 16_000) throw new Error(`Skill file is too large: ${path}`);
    const { metadata, body } = parseFrontmatter(content);
    const name = skillSegment(stringField(metadata, "name"), "name");
    const category = skillSegment(stringField(metadata, "category"), "category");
    const source = asSource(metadata.source);
    const runbookId = typeof metadata.runbookId === "string" && metadata.runbookId.trim() ? metadata.runbookId.trim() : undefined;
    return {
      tenantId,
      name,
      category,
      description: cleanDescription(stringField(metadata, "description")),
      version: stringField(metadata, "version"),
      author: stringField(metadata, "author"),
      tags: asTags(metadata.tags),
      source,
      verified: metadata.verified === true,
      createdAt: stringField(metadata, "createdAt"),
      updatedAt: stringField(metadata, "updatedAt"),
      body: body.trim(),
      path,
      revision: revisionOf(content),
      ...(runbookId ? { runbookId } : {}),
    };
  }
}
