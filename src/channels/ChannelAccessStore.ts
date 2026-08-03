import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ChannelAccessPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type ChannelAccessDecisionKind = "allow" | "block" | "pairing";

type PendingPairing = {
  id: string;
  senderId: string;
  senderName?: string;
  code: string;
  createdAt: string;
  expiresAt: string;
};

type StoredChannelAccess = {
  policy: ChannelAccessPolicy;
  allowFrom: string[];
  pending: PendingPairing[];
};

type ChannelAccessData = {
  version: 1;
  channels: Record<string, StoredChannelAccess>;
};

export type ChannelAccessSnapshot = {
  channel: string;
  policy: ChannelAccessPolicy;
  allowFrom: string[];
  pending: Array<Omit<PendingPairing, "code">>;
};

export type ChannelAccessDecision = {
  decision: ChannelAccessDecisionKind;
  reason: string;
  requestId?: string;
  code?: string;
  expiresAt?: string;
};

export type ChannelAccessStoreOptions = {
  file: string;
  defaultPolicy?: ChannelAccessPolicy;
  seedAllowFrom?: string[];
  pairingTtlMs?: number;
};

const POLICIES: ChannelAccessPolicy[] = ["pairing", "allowlist", "open", "disabled"];
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function emptyData(): ChannelAccessData {
  return { version: 1, channels: {} };
}

function normalizeChannel(value: string): string {
  const channel = value.trim().toLowerCase();
  if (!channel || channel.length > 80 || !/^[a-z0-9._-]+$/.test(channel)) throw new Error("Invalid channel name");
  return channel;
}

function normalizeSender(value: string): string {
  const sender = value.trim();
  if (!sender || sender.length > 256 || /[\u0000-\u001f\u007f]/.test(sender)) throw new Error("Invalid sender id");
  return sender;
}

function normalizeAllowFrom(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)))];
}

function pairingCode(length = 8): string {
  const bytes = randomBytes(length);
  let output = "";
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index] ?? 0;
    output += CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? "X";
  }
  return output;
}

function isPolicy(value: unknown): value is ChannelAccessPolicy {
  return typeof value === "string" && POLICIES.includes(value as ChannelAccessPolicy);
}

function publicSnapshot(channel: string, state: StoredChannelAccess, now = Date.now()): ChannelAccessSnapshot {
  return {
    channel,
    policy: state.policy,
    allowFrom: [...state.allowFrom],
    pending: state.pending
      .filter((item) => Date.parse(item.expiresAt) > now)
      .map(({ code: _code, ...item }) => structuredClone(item)),
  };
}

export class ChannelAccessStore {
  readonly #file: string;
  readonly #defaultPolicy: ChannelAccessPolicy;
  readonly #seedAllowFrom: string[];
  readonly #pairingTtlMs: number;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ChannelAccessStoreOptions) {
    this.#file = options.file;
    this.#defaultPolicy = options.defaultPolicy ?? "pairing";
    this.#seedAllowFrom = normalizeAllowFrom(options.seedAllowFrom ?? []);
    this.#pairingTtlMs = Math.min(Math.max(options.pairingTtlMs ?? 10 * 60_000, 60_000), 24 * 60 * 60_000);
  }

  async evaluate(input: { channel: string; senderId: string; senderName?: string }): Promise<ChannelAccessDecision> {
    const channel = normalizeChannel(input.channel);
    const senderId = normalizeSender(input.senderId);
    const data = await this.#read();
    const state = this.#state(data, channel);
    this.#prunePending(state);

    if (state.policy === "disabled") return { decision: "block", reason: "channel policy is disabled" };
    if (state.policy === "open") return { decision: "allow", reason: "channel policy is open" };
    if (state.allowFrom.includes("*") || state.allowFrom.includes(senderId)) {
      return { decision: "allow", reason: "sender is allowlisted" };
    }
    if (state.policy === "allowlist") return { decision: "block", reason: "sender is not allowlisted" };

    return await this.#mutate((mutable) => {
      const mutableState = this.#state(mutable, channel);
      this.#prunePending(mutableState);
      const existing = mutableState.pending.find((item) => item.senderId === senderId);
      if (existing) {
        return {
          decision: "pairing",
          reason: "sender approval is pending",
          requestId: existing.id,
          code: existing.code,
          expiresAt: existing.expiresAt,
        };
      }

      const now = new Date();
      const pending: PendingPairing = {
        id: randomUUID(),
        senderId,
        ...(input.senderName?.trim() ? { senderName: input.senderName.trim().slice(0, 160) } : {}),
        code: pairingCode(),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.#pairingTtlMs).toISOString(),
      };
      mutableState.pending.push(pending);
      return {
        decision: "pairing",
        reason: "sender must be paired before messages reach the agent",
        requestId: pending.id,
        code: pending.code,
        expiresAt: pending.expiresAt,
      };
    });
  }

  async list(channelInput?: string): Promise<ChannelAccessSnapshot[]> {
    const data = await this.#read();
    if (channelInput) {
      const channel = normalizeChannel(channelInput);
      return [publicSnapshot(channel, this.#state(data, channel))];
    }
    const channels = new Set(Object.keys(data.channels));
    return [...channels]
      .sort()
      .map((channel) => publicSnapshot(channel, this.#state(data, channel)));
  }

  async approve(input: { channel: string; code?: string; requestId?: string }): Promise<ChannelAccessSnapshot> {
    const channel = normalizeChannel(input.channel);
    const code = input.code?.trim().toUpperCase();
    const requestId = input.requestId?.trim();
    if (!code && !requestId) throw new Error("code or requestId is required");

    return await this.#mutate((data) => {
      const state = this.#state(data, channel);
      this.#prunePending(state);
      const pending = state.pending.find((item) =>
        (requestId ? item.id === requestId : true) && (code ? item.code === code : true));
      if (!pending) throw new Error("Pairing request not found or expired");
      state.allowFrom = normalizeAllowFrom([...state.allowFrom, pending.senderId]);
      state.pending = state.pending.filter((item) => item.id !== pending.id);
      return publicSnapshot(channel, state);
    });
  }

  async revoke(channelInput: string, senderInput: string): Promise<ChannelAccessSnapshot> {
    const channel = normalizeChannel(channelInput);
    const senderId = normalizeSender(senderInput);
    return await this.#mutate((data) => {
      const state = this.#state(data, channel);
      state.allowFrom = state.allowFrom.filter((item) => item !== senderId);
      state.pending = state.pending.filter((item) => item.senderId !== senderId);
      return publicSnapshot(channel, state);
    });
  }

  async setPolicy(channelInput: string, policy: ChannelAccessPolicy): Promise<ChannelAccessSnapshot> {
    const channel = normalizeChannel(channelInput);
    if (!isPolicy(policy)) throw new Error(`policy must be one of: ${POLICIES.join(", ")}`);
    return await this.#mutate((data) => {
      const state = this.#state(data, channel);
      state.policy = policy;
      return publicSnapshot(channel, state);
    });
  }

  async seed(channelInput: string, senders: string[]): Promise<ChannelAccessSnapshot> {
    const channel = normalizeChannel(channelInput);
    return await this.#mutate((data) => {
      const state = this.#state(data, channel);
      state.allowFrom = normalizeAllowFrom([...state.allowFrom, ...senders]);
      return publicSnapshot(channel, state);
    });
  }

  defaultPolicy(): ChannelAccessPolicy {
    return this.#defaultPolicy;
  }

  file(): string {
    return this.#file;
  }

  async #read(): Promise<ChannelAccessData> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as Partial<ChannelAccessData>;
      const channels: Record<string, StoredChannelAccess> = {};
      if (parsed.channels && typeof parsed.channels === "object" && !Array.isArray(parsed.channels)) {
        for (const [rawChannel, rawState] of Object.entries(parsed.channels)) {
          if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) continue;
          const state = rawState as Partial<StoredChannelAccess>;
          const channel = normalizeChannel(rawChannel);
          channels[channel] = {
            policy: isPolicy(state.policy) ? state.policy : this.#defaultPolicy,
            allowFrom: normalizeAllowFrom(Array.isArray(state.allowFrom) ? state.allowFrom.filter((item): item is string => typeof item === "string") : this.#seedAllowFrom),
            pending: Array.isArray(state.pending)
              ? state.pending.filter((item): item is PendingPairing => Boolean(
                  item && typeof item === "object"
                  && typeof (item as PendingPairing).id === "string"
                  && typeof (item as PendingPairing).senderId === "string"
                  && typeof (item as PendingPairing).code === "string"
                  && typeof (item as PendingPairing).createdAt === "string"
                  && typeof (item as PendingPairing).expiresAt === "string",
                ))
              : [],
          };
          this.#prunePending(channels[channel]);
        }
      }
      return { version: 1, channels };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw new Error(`Could not read channel access state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #state(data: ChannelAccessData, channel: string): StoredChannelAccess {
    data.channels[channel] ??= {
      policy: this.#defaultPolicy,
      allowFrom: [...this.#seedAllowFrom],
      pending: [],
    };
    const state = data.channels[channel];
    if (!state) throw new Error(`Could not initialize channel policy: ${channel}`);
    return state;
  }

  #prunePending(state: StoredChannelAccess): void {
    const now = Date.now();
    state.pending = state.pending.filter((item) => Date.parse(item.expiresAt) > now);
  }

  async #mutate<T>(mutator: (data: ChannelAccessData) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#writeQueue = this.#writeQueue.catch(() => undefined).then(async () => {
      try {
        const data = await this.#read();
        const value = await mutator(data);
        await this.#write(data);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  async #write(data: ChannelAccessData): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#file);
  }
}
