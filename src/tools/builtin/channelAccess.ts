import type { AgentTool } from "../../core/types.js";
import type { ChannelAccessPolicy, ChannelAccessStore } from "../../channels/ChannelAccessStore.js";

const policies: ChannelAccessPolicy[] = ["pairing", "allowlist", "open", "disabled"];

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function policy(value: unknown): ChannelAccessPolicy {
  if (typeof value !== "string" || !policies.includes(value as ChannelAccessPolicy)) {
    throw new Error(`policy must be one of: ${policies.join(", ")}`);
  }
  return value as ChannelAccessPolicy;
}

export function createChannelAccessTools(access: ChannelAccessStore): AgentTool[] {
  return [
    {
      name: "channel_access_status",
      description: "Inspect channel ingress policy, allowlisted senders, and pending pairing requests. Pairing codes are not exposed by status output.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { channel: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (args) => access.list(optionalString(args, "channel")),
    },
    {
      name: "channel_access_approve",
      description: "Approve one pending external sender by pairing code or request ID. This expands who can issue commands to CherryAgent and therefore requires explicit approval.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string" },
          code: { type: "string" },
          requestId: { type: "string" },
        },
        required: ["channel"],
        additionalProperties: false,
      },
      execute: async (args) => access.approve({
        channel: requiredString(args, "channel"),
        ...(optionalString(args, "code") ? { code: optionalString(args, "code") } : {}),
        ...(optionalString(args, "requestId") ? { requestId: optionalString(args, "requestId") } : {}),
      }),
    },
    {
      name: "channel_access_revoke",
      description: "Revoke a sender from a channel allowlist and remove any pending pairing request for that sender.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string" },
          senderId: { type: "string" },
        },
        required: ["channel", "senderId"],
        additionalProperties: false,
      },
      execute: async (args) => access.revoke(requiredString(args, "channel"), requiredString(args, "senderId")),
    },
    {
      name: "channel_access_set_policy",
      description: "Set a channel ingress policy. pairing is the safe default; open permits every sender and should be used only on a trusted private surface.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string" },
          policy: { type: "string", enum: policies },
        },
        required: ["channel", "policy"],
        additionalProperties: false,
      },
      execute: async (args) => access.setPolicy(requiredString(args, "channel"), policy(args.policy)),
    },
  ];
}
