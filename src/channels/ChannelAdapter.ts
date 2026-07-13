import type {
  ChannelAdapterStatus,
  ChannelCapability,
  ChannelSendResult,
  ChannelWebhookRequest,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "./types.js";

/**
 * Platform adapter contract for conversational channels such as LINE,
 * Telegram, Discord, Slack, Teams, or any custom webhook-backed chat app.
 *
 * Adapters own platform-specific authentication, webhook parsing, payload
 * formatting, and delivery. ChannelGateway owns routing, deduplication,
 * agent invocation, and reply orchestration.
 */
export interface ChannelAdapter {
  readonly name: string;
  readonly capabilities: readonly ChannelCapability[];

  isConfigured(): boolean;

  verifyWebhook(request: ChannelWebhookRequest): boolean | Promise<boolean>;

  parseWebhook(request: ChannelWebhookRequest): Promise<InboundChannelMessage[]>;

  sendMessage(message: OutboundChannelMessage): Promise<ChannelSendResult>;

  sendTyping?(
    conversationId: string,
    active: boolean,
    context?: { threadId?: string },
  ): Promise<void>;

  healthCheck?(): Promise<{ ok: boolean; detail?: string }>;
}

export function getChannelAdapterStatus(adapter: ChannelAdapter): ChannelAdapterStatus {
  return {
    name: adapter.name,
    configured: adapter.isConfigured(),
    capabilities: adapter.capabilities,
  };
}
