import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type AgentSkill = {
  name: string;
  description: string;
  body: string;
  path: string;
};

function parseSkill(path: string, source: string): AgentSkill | undefined {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return undefined;
  const frontmatter = match[1] ?? "";
  const body = match[2]?.trim() ?? "";
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  if (!name || !description || !body) return undefined;
  return { name, description, body, path };
}

function terms(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length >= 2));
}

export class AgentSkillLoader {
  constructor(
    private readonly directory: string,
    private readonly maxSelected = 3,
    private readonly maxBytesPerSkill = 32_000,
  ) {}

  async list(): Promise<AgentSkill[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const skills: AgentSkill[] = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const path = resolve(this.directory, entry.name, "SKILL.md");
      try {
        const source = await readFile(path, "utf8");
        const parsed = parseSkill(path, Buffer.from(source).subarray(0, this.maxBytesPerSkill).toString("utf8"));
        if (parsed) skills.push(parsed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async promptFor(message: string): Promise<string | undefined> {
    const requestTerms = terms(message);
    const explicitNames = new Set([...message.matchAll(/\$([a-z0-9-]+)/gi)].map((match) => match[1]?.toLowerCase()));
    const ranked = (await this.list()).map((skill) => {
      const metadataTerms = terms(`${skill.name} ${skill.description}`);
      const overlap = [...requestTerms].filter((term) => metadataTerms.has(term)).length;
      const explicit = explicitNames.has(skill.name.toLowerCase());
      return { skill, score: explicit ? 10_000 : overlap };
    }).filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, this.maxSelected);
    if (ranked.length === 0) return undefined;
    return `Apply these trusted Cherry workflow skills when executing this request:\n\n${ranked.map(({ skill }) =>
      `<skill name="${skill.name}">\n${skill.body}\n</skill>`).join("\n\n")}`;
  }
}
