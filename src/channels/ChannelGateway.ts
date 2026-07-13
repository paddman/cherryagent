import { getChannelAdapterStatus, type ChannelAdapter } from "./ChannelAdapter.js";
import type {
  ChannelAdapterStatus,
  ChannelGatewayMessageResult,
  ChannelGatewayWebhookResult,
  ChannelMessageHandler,
  ChannelWebhookRequest,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "./types.js";

export type ChannelGatewayOptions = {
  dedupeTtlMs?: number;
  maxSeenMessages?: number;
};

const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SEEN_MESSAGES = 10_000;

function normalizeChannelName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) throw new Error("Channel name is required");
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ChannelGateway {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly seenMessages = new Map<string, number>();
  private readonly inFlightMessages = new Set<string>();
  private readonly dedupeTtlMs: number;
  private readonly maxSeenMessages: number;

  constructor(
    private readonly handler: ChannelMessageHandler,
    options: ChannelGatewayOptions = {},
  ) {
    this.dedupeTtlMs = Math.max(1_000, options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS);
    this.maxSeenMessages = Math.max(100, options.maxSeenMessages ?? DEFAULT_MAX_SEEN_MESSAGES);
  }

  register(adapter: ChannelAdapter): this {
    const name = normalizeChannelName(adapter.name);
    if (this.adapters.has(name)) {
      throw new Error(`Channel adapter already registered: ${name}`);
    }
    this.adapters.set(name, adapter);
    return this;
  }

  unregister(channelName: string): boolean {
    return this.adapters.delete(normalizeChannelName(channelName));
  }

  getAdapter(channelName: string): ChannelAdapter | undefined {
    return this.adapters.get(normalizeChannelName(channelName));
  }

  listAdapters(): ChannelAdapterStatus[] {
    return [...this.adapters.values()]
      .map(getChannelAdapterStatus)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async send(channelName: string, message: OutboundChannelMessage) {
    const adapter = this.requireAdapter(channelName);
    if (!adapter.isConfigured()) {
      throw new Error(`Channel adapter is not configured: ${adapter.name}`);
    }
    return adapter.sendMessage(message);
  }

  async handleWebhook(
    channelName: string,
    request: ChannelWebhookRequest,
  ): Promise<ChannelGatewayWebhookResult> {
    const adapter = this.requireAdapter(channelName);
    if (!adapter.isConfigured()) {
      throw new Error(`Channel adapter is not configured: ${adapter.name}`);
    }

    const verified = await adapter.verifyWebhook(request);
    if (!verified) {
      throw new Error(`Webhook verification failed for channel: ${adapter.name}`);
    }

    const messages = await adapter.parseWebhook(request);
    const results: ChannelGatewayMessageResult[] = [];

    for (const message of messages) {
      results.push(await this.processMessage(adapter, message));
    }

    const failed = results.filter((result) => result.status === "failed").length;
    const duplicates = results.filter((result) => result.status === "skipped_duplicate").length;

    return {
      ok: failed === 0,
      channel: normalizeChannelName(adapter.name),
      received: messages.length,
      processed: messages.length - failed - duplicates,
      failed,
      duplicates,
      results,
    };
  }

  async dispatchInbound(
    channelName: string,
    message: InboundChannelMessage,
  ): Promise<ChannelGatewayMessageResult> {
    const adapter = this.requireAdapter(channelName);
    if (!adapter.isConfigured()) {
      throw new Error(`Channel adapter is not configured: ${adapter.name}`);
    }
    return this.processMessage(adapter, message);
  }

  private requireAdapter(channelName: string): ChannelAdapter {
    const normalized = normalizeChannelName(channelName);
    const adapter = this.adapters.get(normalized);
    if (!adapter) throw new Error(`Unknown channel adapter: ${normalized}`);
    return adapter;
  }

  private async processMessage(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
  ): Promise<ChannelGatewayMessageResult> {
    const channel = normalizeChannelName(adapter.name);
    const normalizedMessage: InboundChannelMessage = message.channel === channel
      ? message
      : { ...message, channel };

    this.validateInboundMessage(normalizedMessage);
    this.pruneSeenMessages();

    const dedupeKey = `${channel}:${normalizedMessage.id}`;
    if (this.seenMessages.has(dedupeKey) || this.inFlightMessages.has(dedupeKey)) {
      return { messageId: normalizedMessage.id, status: "skipped_duplicate" };
    }
    this.inFlightMessages.add(dedupeKey);

    let typingStarted = false;
    try {
      if (adapter.sendTyping && adapter.capabilities.includes("typing")) {
        await adapter.sendTyping(
          normalizedMessage.conversationId,
          true,
          normalizedMessage.threadId ? { threadId: normalizedMessage.threadId } : undefined,
        );
        typingStarted = true;
      }

      const handlerResult = await this.handler(normalizedMessage);
      let reply;

      const hasText = Boolean(handlerResult?.text?.trim());
      const hasAttachments = Boolean(handlerResult?.attachments?.length);
      if (handlerResult && !handlerResult.suppressReply && (hasText || hasAttachments)) {
        const outbound: OutboundChannelMessage = {
          conversationId: normalizedMessage.conversationId,
          text: handlerResult.text?.trim() ?? "",
          replyToMessageId: normalizedMessage.id,
          ...(normalizedMessage.threadId ? { threadId: normalizedMessage.threadId } : {}),
          ...(handlerResult.attachments ? { attachments: handlerResult.attachments } : {}),
          ...(handlerResult.metadata ? { metadata: handlerResult.metadata } : {}),
        };
        reply = await adapter.sendMessage(outbound);
        if (!reply.ok) throw new Error(reply.detail ?? `Failed to send ${channel} reply`);
      }

      this.rememberMessage(dedupeKey);
      return {
        messageId: normalizedMessage.id,
        status: "processed",
        ...(reply ? { reply } : {}),
      };
    } catch (error) {
      return {
        messageId: normalizedMessage.id,
        status: "failed",
        error: errorMessage(error),
      };
    } finally {
      this.inFlightMessages.delete(dedupeKey);
      if (typingStarted && adapter.sendTyping) {
        try {
          await adapter.sendTyping(
            normalizedMessage.conversationId,
            false,
            normalizedMessage.threadId ? { threadId: normalizedMessage.threadId } : undefined,
          );
        } catch {
          // Typing indicators are best effort and must not change message delivery state.
        }
      }
    }
  }

  private validateInboundMessage(message: InboundChannelMessage): void {
    if (!message.id.trim()) throw new Error("Inbound channel message id is required");
    if (!message.conversationId.trim()) throw new Error("Inbound channel conversationId is required");
    if (!message.senderId.trim()) throw new Error("Inbound channel senderId is required");
  }

  private rememberMessage(key: string): void {
    this.seenMessages.set(key, Date.now());
    this.pruneSeenMessages();
  }

  private pruneSeenMessages(): void {
    const cutoff = Date.now() - this.dedupeTtlMs;
    for (const [key, timestamp] of this.seenMessages) {
      if (timestamp < cutoff) this.seenMessages.delete(key);
    }

    while (this.seenMessages.size > this.maxSeenMessages) {
      const oldestKey = this.seenMessages.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.seenMessages.delete(oldestKey);
    }
  }
}
