import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelAdapter } from "../ChannelAdapter.js";
import type {
  ChannelAttachment,
  ChannelSendResult,
  ChannelWebhookRequest,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "../types.js";

export type LineAdapterConfig = {
  channelSecret?: string;
  channelAccessToken?: string;
  apiBaseUrl?: string;
  replyTokenTtlMs?: number;
  maxReplyTokens?: number;
  fetchImpl?: typeof fetch;
};

type ReplyTokenRecord = {
  token: string;
  expiresAt: number;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_API_BASE_URL = "https://api.line.me";
const DEFAULT_REPLY_TOKEN_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_REPLY_TOKENS = 10_000;
const MAX_LINE_MESSAGES_PER_REQUEST = 5;
const MAX_LINE_TEXT_LENGTH = 5_000;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function headerValue(request: ChannelWebhookRequest, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

function lineConversationId(source: JsonRecord): string | undefined {
  const sourceType = stringValue(source.type);
  if (sourceType === "group") return stringValue(source.groupId);
  if (sourceType === "room") return stringValue(source.roomId);
  if (sourceType === "user") return stringValue(source.userId);
  return stringValue(source.userId) ?? stringValue(source.groupId) ?? stringValue(source.roomId);
}

function lineSenderId(source: JsonRecord, conversationId: string): string {
  return stringValue(source.userId) ?? conversationId;
}

function lineReceivedAt(timestamp: unknown): string {
  const numeric = numberValue(timestamp);
  if (numeric === undefined) return new Date().toISOString();
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  return metadata ? stringValue(metadata[key]) : undefined;
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  return metadata ? numberValue(metadata[key]) : undefined;
}

function lineAttachment(message: JsonRecord): ChannelAttachment | undefined {
  const type = stringValue(message.type);
  const id = stringValue(message.id);
  if (!type || !id || !["image", "audio", "video", "file"].includes(type)) return undefined;

  const contentProvider = asRecord(message.contentProvider);
  const common = {
    id,
    metadata: {
      lineMessageId: id,
      ...(stringValue(contentProvider?.type) ? { contentProvider: stringValue(contentProvider?.type) } : {}),
    },
  };

  if (type === "file") {
    const sizeBytes = numberValue(message.fileSize);
    const name = stringValue(message.fileName);
    return {
      ...common,
      type: "file",
      ...(name ? { name } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    };
  }

  return {
    ...common,
    type,
  } as ChannelAttachment;
}

function lineMessageText(message: JsonRecord): string {
  const type = stringValue(message.type);
  if (type === "text") return stringValue(message.text) ?? "";

  if (type === "location") {
    const title = stringValue(message.title);
    const address = stringValue(message.address);
    const latitude = numberValue(message.latitude);
    const longitude = numberValue(message.longitude);
    return [
      "[LINE location]",
      title,
      address,
      latitude !== undefined && longitude !== undefined ? `${latitude},${longitude}` : undefined,
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if (type === "sticker") {
    const packageId = stringValue(message.packageId) ?? "unknown-package";
    const stickerId = stringValue(message.stickerId) ?? "unknown-sticker";
    return `[LINE sticker] ${packageId}/${stickerId}`;
  }

  return "";
}

function outboundLineMessages(message: OutboundChannelMessage): JsonRecord[] {
  const messages: JsonRecord[] = [];
  const text = message.text.trim();
  if (text) {
    messages.push({
      type: "text",
      text: text.slice(0, MAX_LINE_TEXT_LENGTH),
    });
  }

  for (const attachment of message.attachments ?? []) {
    if (messages.length >= MAX_LINE_MESSAGES_PER_REQUEST) break;
    if (!attachment.url) continue;

    if (attachment.type === "image") {
      messages.push({
        type: "image",
        originalContentUrl: attachment.url,
        previewImageUrl: metadataString(attachment.metadata, "previewImageUrl") ?? attachment.url,
      });
      continue;
    }

    if (attachment.type === "video") {
      const previewImageUrl = metadataString(attachment.metadata, "previewImageUrl");
      if (!previewImageUrl) continue;
      messages.push({
        type: "video",
        originalContentUrl: attachment.url,
        previewImageUrl,
      });
      continue;
    }

    if (attachment.type === "audio") {
      const duration = metadataNumber(attachment.metadata, "durationMs");
      if (duration === undefined || duration <= 0) continue;
      messages.push({
        type: "audio",
        originalContentUrl: attachment.url,
        duration: Math.round(duration),
      });
    }
  }

  return messages.slice(0, MAX_LINE_MESSAGES_PER_REQUEST);
}

function firstSentMessageId(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const sentMessages = record?.sentMessages;
  if (!Array.isArray(sentMessages)) return undefined;
  const first = asRecord(sentMessages[0]);
  return stringValue(first?.id);
}

export class LineAdapter implements ChannelAdapter {
  readonly name = "line";
  readonly capabilities = ["text", "files"] as const;

  private readonly apiBaseUrl: string;
  private readonly replyTokenTtlMs: number;
  private readonly maxReplyTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly replyTokens = new Map<string, ReplyTokenRecord>();

  constructor(private readonly config: LineAdapterConfig = {}) {
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    this.replyTokenTtlMs = Math.max(1_000, config.replyTokenTtlMs ?? DEFAULT_REPLY_TOKEN_TTL_MS);
    this.maxReplyTokens = Math.max(100, config.maxReplyTokens ?? DEFAULT_MAX_REPLY_TOKENS);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.config.channelSecret?.trim() && this.config.channelAccessToken?.trim());
  }

  verifyWebhook(request: ChannelWebhookRequest): boolean {
    const channelSecret = this.config.channelSecret?.trim();
    const signature = headerValue(request, "x-line-signature")?.trim();
    if (!channelSecret || !signature) return false;

    const expected = createHmac("sha256", channelSecret)
      .update(request.rawBody, "utf8")
      .digest("base64");

    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }

  async parseWebhook(request: ChannelWebhookRequest): Promise<InboundChannelMessage[]> {
    const payload = JSON.parse(request.rawBody) as unknown;
    const body = asRecord(payload);
    if (!body) throw new Error("LINE webhook body must be a JSON object");
    if (!Array.isArray(body.events)) throw new Error("LINE webhook body must contain an events array");

    const messages: InboundChannelMessage[] = [];
    for (const rawEvent of body.events) {
      const parsed = this.parseEvent(rawEvent);
      if (parsed) messages.push(parsed);
    }
    return messages;
  }

  async sendMessage(message: OutboundChannelMessage): Promise<ChannelSendResult> {
    const channelAccessToken = this.config.channelAccessToken?.trim();
    if (!channelAccessToken) {
      return {
        ok: false,
        channel: this.name,
        detail: "CHERRY_LINE_CHANNEL_ACCESS_TOKEN is not configured",
      };
    }

    const messages = outboundLineMessages(message);
    if (messages.length === 0) {
      return {
        ok: false,
        channel: this.name,
        detail: "LINE outbound message has no supported text or media payload",
      };
    }

    const replyToken = message.replyToMessageId
      ? this.consumeReplyToken(message.replyToMessageId)
      : undefined;

    if (replyToken) {
      const replyResponse = await this.postJson(
        "/v2/bot/message/reply",
        { replyToken, messages },
        channelAccessToken,
      );
      const replyResult = await this.responseResult(replyResponse, "LINE reply delivery");
      if (replyResult.ok || replyResponse.status !== 400) return replyResult;
    }

    const pushResponse = await this.postJson(
      "/v2/bot/message/push",
      { to: message.conversationId, messages },
      channelAccessToken,
    );
    return this.responseResult(pushResponse, "LINE push delivery");
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const channelAccessToken = this.config.channelAccessToken?.trim();
    if (!channelAccessToken) return { ok: false, detail: "LINE channel access token is not configured" };

    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}/v2/bot/info`, {
        method: "GET",
        headers: { authorization: `Bearer ${channelAccessToken}` },
      });
      const detail = await response.text();
      return response.ok
        ? { ok: true, ...(detail ? { detail } : {}) }
        : { ok: false, detail: `LINE bot info failed (${response.status}): ${detail || response.statusText}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private parseEvent(value: unknown): InboundChannelMessage | null {
    const event = asRecord(value);
    if (!event) return null;

    const eventType = stringValue(event.type);
    const source = asRecord(event.source);
    if (!eventType || !source) return null;

    const conversationId = lineConversationId(source);
    if (!conversationId) return null;
    const senderId = lineSenderId(source, conversationId);
    const timestamp = numberValue(event.timestamp);
    const webhookEventId = stringValue(event.webhookEventId);
    const sourceType = stringValue(source.type) ?? "unknown";
    const deliveryContext = asRecord(event.deliveryContext);

    if (eventType === "message") {
      const lineMessage = asRecord(event.message);
      if (!lineMessage) return null;

      const lineMessageId = stringValue(lineMessage.id);
      const id = webhookEventId ?? lineMessageId;
      if (!id) return null;

      const replyToken = stringValue(event.replyToken);
      if (replyToken) this.rememberReplyToken(id, replyToken);

      const attachment = lineAttachment(lineMessage);
      const text = lineMessageText(lineMessage);
      return {
        id,
        channel: this.name,
        conversationId,
        senderId,
        text,
        receivedAt: lineReceivedAt(timestamp),
        ...(attachment ? { attachments: [attachment] } : {}),
        metadata: {
          sourceType,
          ...(webhookEventId ? { webhookEventId } : {}),
          ...(lineMessageId ? { lineMessageId } : {}),
          ...(typeof deliveryContext?.isRedelivery === "boolean"
            ? { isRedelivery: deliveryContext.isRedelivery }
            : {}),
        },
      };
    }

    if (eventType === "postback") {
      const postback = asRecord(event.postback);
      const data = stringValue(postback?.data);
      if (!data) return null;

      const id = webhookEventId ?? `${timestamp ?? Date.now()}:${conversationId}:${senderId}:postback:${data}`;
      const replyToken = stringValue(event.replyToken);
      if (replyToken) this.rememberReplyToken(id, replyToken);

      return {
        id,
        channel: this.name,
        conversationId,
        senderId,
        text: `[LINE postback] ${data}`,
        receivedAt: lineReceivedAt(timestamp),
        metadata: {
          sourceType,
          data,
          ...(webhookEventId ? { webhookEventId } : {}),
          ...(asRecord(postback?.params) ? { params: asRecord(postback?.params) } : {}),
          ...(typeof deliveryContext?.isRedelivery === "boolean"
            ? { isRedelivery: deliveryContext.isRedelivery }
            : {}),
        },
      };
    }

    return null;
  }

  private rememberReplyToken(messageId: string, token: string): void {
    this.replyTokens.set(messageId, {
      token,
      expiresAt: Date.now() + this.replyTokenTtlMs,
    });
    this.pruneReplyTokens();
  }

  private consumeReplyToken(messageId: string): string | undefined {
    this.pruneReplyTokens();
    const record = this.replyTokens.get(messageId);
    if (!record) return undefined;
    this.replyTokens.delete(messageId);
    return record.expiresAt > Date.now() ? record.token : undefined;
  }

  private pruneReplyTokens(): void {
    const now = Date.now();
    for (const [messageId, record] of this.replyTokens) {
      if (record.expiresAt <= now) this.replyTokens.delete(messageId);
    }

    while (this.replyTokens.size > this.maxReplyTokens) {
      const oldest = this.replyTokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.replyTokens.delete(oldest);
    }
  }

  private async postJson(path: string, body: unknown, channelAccessToken: string): Promise<Response> {
    return this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${channelAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  private async responseResult(response: Response, label: string): Promise<ChannelSendResult> {
    const text = await response.text();
    let payload: unknown;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = undefined;
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        channel: this.name,
        detail: `${label} failed (${response.status}): ${text || response.statusText}`,
      };
    }

    const messageId = firstSentMessageId(payload);
    const requestId = response.headers.get("x-line-request-id") ?? undefined;
    return {
      ok: true,
      channel: this.name,
      ...(messageId ? { messageId } : {}),
      ...(requestId ? { detail: `x-line-request-id=${requestId}` } : {}),
    };
  }
}
