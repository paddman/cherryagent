import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ConversationRole = "user" | "assistant";

export type ConversationMessage = {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
  runId?: string;
  steps?: number;
};

export type Conversation = {
  id: string;
  title: string;
  userId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
};

export type ConversationSummary = Omit<Conversation, "messages"> & {
  messageCount: number;
  lastMessage?: string;
};

type ConversationData = {
  conversations: Conversation[];
};

const emptyData = (): ConversationData => ({ conversations: [] });

function normalizeTitle(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (!collapsed) return "New conversation";
  return collapsed.length > 64 ? `${collapsed.slice(0, 61)}...` : collapsed;
}

function summaryOf(conversation: Conversation): ConversationSummary {
  const last = conversation.messages.at(-1);
  return {
    id: conversation.id,
    title: conversation.title,
    userId: conversation.userId,
    sessionId: conversation.sessionId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    ...(last ? { lastMessage: last.content.slice(0, 180) } : {}),
  };
}

export class ConversationStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<ConversationData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<ConversationData>;
      return { conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw error;
    }
  }

  private async write(data: ConversationData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  private async mutate<T>(operation: (data: ConversationData) => Promise<T> | T): Promise<T> {
    const task = this.writeQueue.then(async () => {
      const data = await this.read();
      const result = await operation(data);
      await this.write(data);
      return result;
    });
    this.writeQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async list(input: { userId?: string; limit?: number } = {}): Promise<ConversationSummary[]> {
    const { conversations } = await this.read();
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    return conversations
      .filter((conversation) => !input.userId || conversation.userId === input.userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(summaryOf);
  }

  async create(input: { userId: string; sessionId?: string; title?: string }): Promise<Conversation> {
    return this.mutate((data) => {
      const now = new Date().toISOString();
      const conversation: Conversation = {
        id: crypto.randomUUID(),
        title: normalizeTitle(input.title ?? "New conversation"),
        userId: input.userId,
        sessionId: input.sessionId ?? crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      data.conversations.push(conversation);
      return conversation;
    });
  }

  async get(id: string): Promise<Conversation> {
    const { conversations } = await this.read();
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) throw new Error(`Conversation not found: ${id}`);
    return conversation;
  }

  async appendMessage(
    conversationId: string,
    input: {
      role: ConversationRole;
      content: string;
      runId?: string;
      steps?: number;
    },
  ): Promise<ConversationMessage> {
    return this.mutate((data) => {
      const conversation = data.conversations.find((item) => item.id === conversationId);
      if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);

      const message: ConversationMessage = {
        id: crypto.randomUUID(),
        role: input.role,
        content: input.content,
        createdAt: new Date().toISOString(),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.steps !== undefined ? { steps: input.steps } : {}),
      };
      conversation.messages.push(message);
      conversation.updatedAt = message.createdAt;
      if (input.role === "user" && conversation.messages.filter((item) => item.role === "user").length === 1) {
        conversation.title = normalizeTitle(input.content);
      }
      return message;
    });
  }

  async rename(id: string, title: string): Promise<ConversationSummary> {
    return this.mutate((data) => {
      const conversation = data.conversations.find((item) => item.id === id);
      if (!conversation) throw new Error(`Conversation not found: ${id}`);
      conversation.title = normalizeTitle(title);
      conversation.updatedAt = new Date().toISOString();
      return summaryOf(conversation);
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate((data) => {
      const index = data.conversations.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`Conversation not found: ${id}`);
      data.conversations.splice(index, 1);
    });
  }
}
