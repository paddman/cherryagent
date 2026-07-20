import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatMessage } from "../core/types.js";

export type SessionMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type AgentSession = {
  tenantId: string;
  chatId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
};

type SessionData = {
  version: 1;
  sessions: AgentSession[];
};

function emptyData(): SessionData {
  return { version: 1, sessions: [] };
}

function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Bearer|Node)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]")
    .replace(/\b(password|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}

function boundedContent(value: string, maxBytes: number): string {
  const redacted = redactSecrets(value);
  const buffer = Buffer.from(redacted, "utf8");
  if (buffer.byteLength <= maxBytes) return redacted;
  return `${buffer.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n[TRUNCATED]`;
}

export class AgentSessionStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxMessages = 80,
    private readonly maxMessageBytes = 24_000,
    private readonly maxSessions = 2_000,
  ) {}

  async history(tenantId: string, chatId: string): Promise<SessionMessage[]> {
    const data = await this.read();
    const session = data.sessions.find((item) => item.tenantId === tenantId && item.chatId === chatId);
    return structuredClone(session?.messages ?? []);
  }

  async messages(tenantId: string, chatId: string): Promise<ChatMessage[]> {
    return (await this.history(tenantId, chatId)).map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }

  async appendTurn(input: {
    tenantId: string;
    chatId: string;
    userId: string;
    userMessage: string;
    assistantMessage: string;
  }): Promise<void> {
    await this.mutate((data) => {
      const now = new Date().toISOString();
      let session = data.sessions.find((item) => item.tenantId === input.tenantId && item.chatId === input.chatId);
      if (!session) {
        session = {
          tenantId: input.tenantId,
          chatId: input.chatId,
          userId: input.userId,
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        data.sessions.push(session);
      }

      session.userId = input.userId;
      session.updatedAt = now;
      session.messages.push(
        { role: "user", content: boundedContent(input.userMessage, this.maxMessageBytes), createdAt: now },
        { role: "assistant", content: boundedContent(input.assistantMessage, this.maxMessageBytes), createdAt: now },
      );
      if (session.messages.length > this.maxMessages) {
        session.messages.splice(0, session.messages.length - this.maxMessages);
      }

      data.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (data.sessions.length > this.maxSessions) data.sessions.length = this.maxSessions;
    });
  }

  async clear(tenantId: string, chatId: string): Promise<boolean> {
    let removed = false;
    await this.mutate((data) => {
      const index = data.sessions.findIndex((item) => item.tenantId === tenantId && item.chatId === chatId);
      if (index >= 0) {
        data.sessions.splice(index, 1);
        removed = true;
      }
    });
    return removed;
  }

  private async read(): Promise<SessionData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<SessionData>;
      return { version: 1, sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw error;
    }
  }

  private async mutate(mutator: (data: SessionData) => void): Promise<void> {
    const operation = this.#queue.then(async () => {
      const data = await this.read();
      mutator(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}
