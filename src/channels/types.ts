export type ChannelCapability =
  | "text"
  | "typing"
  | "files"
  | "threads"
  | "reactions";

export type ChannelMetadata = Record<string, unknown>;

export type ChannelAttachment = {
  id?: string;
  type: "image" | "audio" | "video" | "file" | "other";
  name?: string;
  mimeType?: string;
  url?: string;
  sizeBytes?: number;
  metadata?: ChannelMetadata;
};

export type InboundChannelMessage = {
  id: string;
  channel: string;
  conversationId: string;
  senderId: string;
  text: string;
  receivedAt: string;
  senderName?: string;
  threadId?: string;
  replyToMessageId?: string;
  attachments?: ChannelAttachment[];
  metadata?: ChannelMetadata;
};

export type OutboundChannelMessage = {
  conversationId: string;
  text: string;
  threadId?: string;
  replyToMessageId?: string;
  attachments?: ChannelAttachment[];
  metadata?: ChannelMetadata;
};

export type ChannelWebhookRequest = {
  method: string;
  headers: Readonly<Record<string, string>>;
  rawBody: string;
  query: Readonly<Record<string, string | string[]>>;
};

export type ChannelSendResult = {
  ok: boolean;
  channel: string;
  messageId?: string;
  detail?: string;
};

export type ChannelHandlerResult = {
  text?: string;
  attachments?: ChannelAttachment[];
  suppressReply?: boolean;
  metadata?: ChannelMetadata;
};

export type ChannelMessageHandler = (
  message: InboundChannelMessage,
) => Promise<ChannelHandlerResult | null>;

export type ChannelAdapterStatus = {
  name: string;
  configured: boolean;
  capabilities: readonly ChannelCapability[];
};

export type ChannelGatewayMessageStatus = "processed" | "skipped_duplicate" | "failed";

export type ChannelGatewayMessageResult = {
  messageId: string;
  status: ChannelGatewayMessageStatus;
  reply?: ChannelSendResult;
  error?: string;
};

export type ChannelGatewayWebhookResult = {
  ok: boolean;
  channel: string;
  received: number;
  processed: number;
  failed: number;
  duplicates: number;
  results: ChannelGatewayMessageResult[];
};
