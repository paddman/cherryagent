import type { GoogleWorkspaceClient } from "../connectors/google/GoogleWorkspaceClient.js";
import type { PlannerAlert, PlannerReminder } from "./PlannerStore.js";
import type { NotificationChannel } from "./schedule.js";

export type NotificationDeliveryResult = {
  channel: NotificationChannel;
  ok: boolean;
  skipped?: boolean;
  detail: string;
};

export type NotificationDispatcherConfig = {
  emailTo?: string;
  slackWebhookUrl?: string;
  webhookUrl?: string;
  lineChannelAccessToken?: string;
  lineTo?: string;
};

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function expectOk(response: Response, label: string): Promise<string> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text || response.statusText}`);
  return text || response.statusText || "ok";
}

export class NotificationDispatcher {
  constructor(
    private readonly google: GoogleWorkspaceClient,
    private readonly config: NotificationDispatcherConfig,
  ) {}

  async dispatch(alert: PlannerAlert, reminder?: PlannerReminder): Promise<NotificationDeliveryResult[]> {
    const results: NotificationDeliveryResult[] = [];
    for (const channel of [...new Set(alert.channels)]) {
      try {
        results.push(await this.dispatchChannel(channel, alert, reminder));
      } catch (error) {
        results.push({
          channel,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  private async dispatchChannel(
    channel: NotificationChannel,
    alert: PlannerAlert,
    reminder?: PlannerReminder,
  ): Promise<NotificationDeliveryResult> {
    if (channel === "in_app") {
      return { channel, ok: true, detail: "Stored in durable in-app alert inbox" };
    }
    if (channel === "browser") {
      return { channel, ok: true, detail: "Queued for connected PWA clients to surface as a browser notification" };
    }
    if (channel === "email") return this.sendEmail(alert, reminder);
    if (channel === "slack") return this.sendSlack(alert);
    if (channel === "webhook") return this.sendWebhook(alert, reminder);
    if (channel === "line") return this.sendLine(alert);
    return { channel, ok: false, detail: `Unsupported notification channel: ${channel}` };
  }

  private async sendEmail(alert: PlannerAlert, reminder?: PlannerReminder): Promise<NotificationDeliveryResult> {
    const channel: NotificationChannel = "email";
    if (!this.config.emailTo) {
      return { channel, ok: false, skipped: true, detail: "CHERRY_NOTIFY_EMAIL_TO is not configured" };
    }
    if (!this.google.isConfigured()) {
      return { channel, ok: false, skipped: true, detail: "Google Workspace is not configured for Gmail delivery" };
    }
    const result = await this.google.gmailSendEmail({
      to: this.config.emailTo,
      subject: `[CherryAgent] ${alert.title}`,
      body: [
        alert.message,
        "",
        `Triggered: ${alert.createdAt}`,
        reminder?.nextRunAt ? `Next run: ${reminder.nextRunAt}` : "",
      ].filter(Boolean).join("\n"),
    });
    return { channel, ok: true, detail: JSON.stringify(result) };
  }

  private async sendSlack(alert: PlannerAlert): Promise<NotificationDeliveryResult> {
    const channel: NotificationChannel = "slack";
    if (!this.config.slackWebhookUrl) {
      return { channel, ok: false, skipped: true, detail: "CHERRY_NOTIFY_SLACK_WEBHOOK is not configured" };
    }
    const response = await postJson(this.config.slackWebhookUrl, {
      text: `*${alert.title}*\n${alert.message}\n_${alert.createdAt}_`,
    });
    const detail = await expectOk(response, "Slack webhook delivery");
    return { channel, ok: true, detail };
  }

  private async sendWebhook(alert: PlannerAlert, reminder?: PlannerReminder): Promise<NotificationDeliveryResult> {
    const channel: NotificationChannel = "webhook";
    if (!this.config.webhookUrl) {
      return { channel, ok: false, skipped: true, detail: "CHERRY_NOTIFY_WEBHOOK_URL is not configured" };
    }
    const response = await postJson(this.config.webhookUrl, {
      source: "CherryAgent",
      event: "planner.alert",
      alert,
      ...(reminder ? { reminder } : {}),
    });
    const detail = await expectOk(response, "Generic webhook delivery");
    return { channel, ok: true, detail };
  }

  private async sendLine(alert: PlannerAlert): Promise<NotificationDeliveryResult> {
    const channel: NotificationChannel = "line";
    if (!this.config.lineChannelAccessToken || !this.config.lineTo) {
      return {
        channel,
        ok: false,
        skipped: true,
        detail: "CHERRY_NOTIFY_LINE_CHANNEL_ACCESS_TOKEN and CHERRY_NOTIFY_LINE_TO are required",
      };
    }
    const response = await postJson(
      "https://api.line.me/v2/bot/message/push",
      {
        to: this.config.lineTo,
        messages: [{ type: "text", text: `${alert.title}\n${alert.message}`.slice(0, 5000) }],
      },
      { authorization: `Bearer ${this.config.lineChannelAccessToken}` },
    );
    const detail = await expectOk(response, "LINE push delivery");
    return { channel, ok: true, detail };
  }
}
