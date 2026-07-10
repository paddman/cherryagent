import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { AgentTool, ToolContext } from "../../core/types.js";

function sandboxPath(context: ToolContext, requested: unknown): string {
  if (typeof requested !== "string" || !requested.trim()) {
    throw new Error("path must be a non-empty string");
  }

  const root = resolve(context.workspaceRoot);
  const target = resolve(root, requested);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("Path escapes the configured workspace sandbox");
  }
  return target;
}

export const fileTools: AgentTool[] = [
  {
    name: "files_list",
    description: "List files and directories inside the controlled CherryAgent workspace sandbox.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path inside workspace; use . for root" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const target = sandboxPath(context, args.path);
      await mkdir(target, { recursive: true });
      const entries = await readdir(target, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }));
    },
  },
  {
    name: "files_read_text",
    description: "Read a UTF-8 text file from the controlled CherryAgent workspace sandbox.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const target = sandboxPath(context, args.path);
      const info = await stat(target);
      if (!info.isFile()) throw new Error("Requested path is not a file");
      if (info.size > 2_000_000) throw new Error("Text file exceeds 2 MB safety limit");
      return { path: relative(context.workspaceRoot, target), content: await readFile(target, "utf8") };
    },
  },
  {
    name: "files_write_text",
    description: "Create or replace a UTF-8 text file inside the controlled CherryAgent workspace sandbox.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const target = sandboxPath(context, args.path);
      const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
      if (Buffer.byteLength(content, "utf8") > 2_000_000) throw new Error("Text content exceeds 2 MB safety limit");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return {
        path: relative(context.workspaceRoot, target),
        bytes: Buffer.byteLength(content, "utf8"),
        verified: (await readFile(target, "utf8")) === content,
      };
    },
  },
];
