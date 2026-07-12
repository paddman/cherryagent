import type { ConversationStore } from "../conversation/ConversationStore.js";
import type { NotificationDispatcher, NotificationDeliveryResult } from "../planner/NotificationDispatcher.js";
import type { PlannerAlert } from "../planner/PlannerStore.js";
import type { NotificationChannel } from "../planner/schedule.js";

export type ProactiveNotificationResult = {
  conversationId: string;
  alert: PlannerAlert;
  deliveries: NotificationDeliveryResult[];
};

export class ProactiveNotifier {
  constructor(private readonly dependencies: {
    conversation: ConversationStore;
    dispatcher: NotificationDispatcher;
    channels: NotificationChannel[];
    userId: string;
  }) {}

  async notify(input: {
    decisionId: string;
    topic: string;
    message: string;
  }): Promise<ProactiveNotificationResult> {
    const message = input.message.trim();
    if (!message) throw new Error("Proactive notification message is required");

    const existing = (await this.dependencies.conversation.list({
      userId: this.dependencies.userId,
      limit: 200,
    })).find((item) => item.title === "Cherry proactive");

    const target = existing ?? await this.dependencies.conversation.create({
      userId: this.dependencies.userId,
      title: "Cherry proactive",
    });

    await this.dependencies.conversation.appendMessage(target.id, {
      role: "assistant",
      content: message,
      runId: `autonomy:${input.decisionId}`,
    });

    const alert: PlannerAlert = {
      id: crypto.randomUUID(),
      reminderId: `autonomy:${input.decisionId}`,
      title: `Cherry · ${input.topic}`.slice(0, 120),
      message,
      channels: this.dependencies.channels,
      createdAt: new Date().toISOString(),
    };
    const deliveries = await this.dependencies.dispatcher.dispatch(alert);
    return { conversationId: target.id, alert, deliveries };
  }
}
