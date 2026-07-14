import { isIP } from "node:net";

export type SecurityExecutionMode = "manual" | "auto" | "emergency";
export type SecurityPolicyAction =
  | "temporary_block"
  | "remove_block"
  | "firewall_change"
  | "waf_change"
  | "ids_change"
  | "emergency_contain";

export type SecurityPolicyRequest = {
  action: SecurityPolicyAction;
  target?: string;
  timeoutMinutes?: number;
  confidence?: number;
  evidenceCount?: number;
  mode?: SecurityExecutionMode;
  reason?: string;
};

export type SecurityPolicyDecision = {
  policyVersion: string;
  allowed: boolean;
  hardDeny: boolean;
  requiresApproval: boolean;
  autoContainEligible: boolean;
  mode: SecurityExecutionMode;
  action: SecurityPolicyAction;
  target: string | null;
  timeoutMinutes: number | null;
  confidence: number;
  evidenceCount: number;
  reasons: string[];
};

export type SecurityPolicyOptions = {
  allowlist?: string[];
  protectedTargets?: string[];
  maxBlockMinutes?: number;
  autoMinConfidence?: number;
  autoMinEvidence?: number;
  minIpv4Prefix?: number;
  minIpv6Prefix?: number;
  emergencyModeEnabled?: boolean;
};

type ParsedTarget = {
  raw: string;
  address: string;
  family: 4 | 6;
  prefix: number;
};

const POLICY_VERSION = "securityops-policy-v1";
const DEFAULT_PROTECTED_TARGETS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ipv4ToInt(address: string): number {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${address}`);
  }
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function parseTarget(raw: string): ParsedTarget {
  const value = raw.trim();
  if (!value) throw new Error("Security policy target is required");
  const [address = "", prefixText] = value.split("/", 2);
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error(`Invalid IP or CIDR target: ${raw}`);
  const maxPrefix = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`Invalid CIDR prefix: ${raw}`);
  }
  return { raw: value, address, family, prefix };
}

function ipv4Contains(network: ParsedTarget, candidate: ParsedTarget): boolean {
  if (network.family !== 4 || candidate.family !== 4) return false;
  if (network.prefix === 0) return true;
  const mask = network.prefix === 32 ? 0xffffffff : (0xffffffff << (32 - network.prefix)) >>> 0;
  return (ipv4ToInt(network.address) & mask) === (ipv4ToInt(candidate.address) & mask);
}

function expandedIpv6(address: string): string[] {
  const lower = address.toLowerCase();
  const [left = "", right = ""] = lower.split("::", 2);
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const missing = Math.max(0, 8 - leftParts.length - rightParts.length);
  return [...leftParts, ...Array.from({ length: missing }, () => "0"), ...rightParts]
    .slice(0, 8)
    .map((part) => part.padStart(4, "0"));
}

function ipv6Contains(network: ParsedTarget, candidate: ParsedTarget): boolean {
  if (network.family !== 6 || candidate.family !== 6) return false;
  const networkHex = expandedIpv6(network.address).join("");
  const candidateHex = expandedIpv6(candidate.address).join("");
  const fullNibbles = Math.floor(network.prefix / 4);
  const remainder = network.prefix % 4;
  if (networkHex.slice(0, fullNibbles) !== candidateHex.slice(0, fullNibbles)) return false;
  if (remainder === 0) return true;
  const mask = 0xf << (4 - remainder);
  return (Number.parseInt(networkHex[fullNibbles] ?? "0", 16) & mask)
    === (Number.parseInt(candidateHex[fullNibbles] ?? "0", 16) & mask);
}

function targetContains(networkRaw: string, candidate: ParsedTarget): boolean {
  try {
    const network = parseTarget(networkRaw);
    return network.family === 4 ? ipv4Contains(network, candidate) : ipv6Contains(network, candidate);
  } catch {
    return false;
  }
}

export class SecurityPolicyEngine {
  readonly #allowlist: string[];
  readonly #protectedTargets: string[];
  readonly #maxBlockMinutes: number;
  readonly #autoMinConfidence: number;
  readonly #autoMinEvidence: number;
  readonly #minIpv4Prefix: number;
  readonly #minIpv6Prefix: number;
  readonly #emergencyModeEnabled: boolean;

  constructor(options: SecurityPolicyOptions = {}) {
    this.#allowlist = options.allowlist ?? [];
    this.#protectedTargets = options.protectedTargets ?? DEFAULT_PROTECTED_TARGETS;
    this.#maxBlockMinutes = Math.max(1, Math.floor(options.maxBlockMinutes ?? 1_440));
    this.#autoMinConfidence = Math.min(1, Math.max(0, options.autoMinConfidence ?? 0.95));
    this.#autoMinEvidence = Math.max(1, Math.floor(options.autoMinEvidence ?? 2));
    this.#minIpv4Prefix = Math.min(32, Math.max(0, Math.floor(options.minIpv4Prefix ?? 24)));
    this.#minIpv6Prefix = Math.min(128, Math.max(0, Math.floor(options.minIpv6Prefix ?? 64)));
    this.#emergencyModeEnabled = options.emergencyModeEnabled ?? false;
  }

  static fromEnvironment(): SecurityPolicyEngine {
    const protectedTargets = listEnv("CHERRY_SECURITY_POLICY_PROTECTED_TARGETS");
    return new SecurityPolicyEngine({
      allowlist: listEnv("CHERRY_SECURITY_POLICY_ALLOWLIST"),
      protectedTargets: protectedTargets.length ? protectedTargets : DEFAULT_PROTECTED_TARGETS,
      maxBlockMinutes: numberEnv("CHERRY_SECURITY_POLICY_MAX_BLOCK_MINUTES", 1_440),
      autoMinConfidence: numberEnv("CHERRY_SECURITY_POLICY_AUTO_MIN_CONFIDENCE", 0.95),
      autoMinEvidence: numberEnv("CHERRY_SECURITY_POLICY_AUTO_MIN_EVIDENCE", 2),
      minIpv4Prefix: numberEnv("CHERRY_SECURITY_POLICY_MIN_IPV4_PREFIX", 24),
      minIpv6Prefix: numberEnv("CHERRY_SECURITY_POLICY_MIN_IPV6_PREFIX", 64),
      emergencyModeEnabled: booleanEnv("CHERRY_SECURITY_POLICY_EMERGENCY_MODE", false),
    });
  }

  status(): Record<string, unknown> {
    return {
      policyVersion: POLICY_VERSION,
      allowlistEntries: this.#allowlist.length,
      protectedTargetEntries: this.#protectedTargets.length,
      maxBlockMinutes: this.#maxBlockMinutes,
      autoMinConfidence: this.#autoMinConfidence,
      autoMinEvidence: this.#autoMinEvidence,
      minIpv4Prefix: this.#minIpv4Prefix,
      minIpv6Prefix: this.#minIpv6Prefix,
      emergencyModeEnabled: this.#emergencyModeEnabled,
    };
  }

  evaluate(request: SecurityPolicyRequest): SecurityPolicyDecision {
    const mode = request.mode ?? "manual";
    const confidence = Math.min(1, Math.max(0, request.confidence ?? (mode === "manual" ? 1 : 0)));
    const evidenceCount = Math.max(0, Math.floor(request.evidenceCount ?? (mode === "manual" ? 1 : 0)));
    const reasons: string[] = [];
    let hardDeny = false;
    let parsedTarget: ParsedTarget | undefined;

    if (request.target) {
      parsedTarget = parseTarget(request.target);
      if (this.#allowlist.some((entry) => targetContains(entry, parsedTarget!))) {
        hardDeny = true;
        reasons.push("target is covered by the SecurityOps allowlist");
      }
      if (this.#protectedTargets.some((entry) => targetContains(entry, parsedTarget!))) {
        hardDeny = true;
        reasons.push("target is inside a protected/local network range");
      }
      const minimumPrefix = parsedTarget.family === 4 ? this.#minIpv4Prefix : this.#minIpv6Prefix;
      if (parsedTarget.prefix < minimumPrefix) {
        hardDeny = true;
        reasons.push(`CIDR block is broader than policy minimum /${minimumPrefix}`);
      }
    }

    const requestedMinutes = request.timeoutMinutes === undefined
      ? null
      : Math.max(1, Math.floor(request.timeoutMinutes));
    if (request.action === "temporary_block" && requestedMinutes !== null && requestedMinutes > this.#maxBlockMinutes) {
      hardDeny = true;
      reasons.push(`requested timeout exceeds maximum ${this.#maxBlockMinutes} minutes`);
    }

    if (mode === "emergency" && !this.#emergencyModeEnabled) {
      hardDeny = true;
      reasons.push("emergency mode is disabled by policy");
    }

    const autoContainEligible = !hardDeny
      && (mode === "auto" || mode === "emergency")
      && confidence >= this.#autoMinConfidence
      && evidenceCount >= this.#autoMinEvidence;

    if ((mode === "auto" || mode === "emergency") && confidence < this.#autoMinConfidence) {
      reasons.push(`confidence ${confidence.toFixed(3)} is below auto-containment threshold ${this.#autoMinConfidence.toFixed(3)}`);
    }
    if ((mode === "auto" || mode === "emergency") && evidenceCount < this.#autoMinEvidence) {
      reasons.push(`evidence count ${evidenceCount} is below auto-containment minimum ${this.#autoMinEvidence}`);
    }
    if (!hardDeny && reasons.length === 0) reasons.push("request satisfies hard safety policy");

    return {
      policyVersion: POLICY_VERSION,
      allowed: !hardDeny && (mode === "manual" || autoContainEligible),
      hardDeny,
      requiresApproval: request.action !== "remove_block" || mode !== "manual",
      autoContainEligible,
      mode,
      action: request.action,
      target: parsedTarget?.raw ?? null,
      timeoutMinutes: requestedMinutes,
      confidence,
      evidenceCount,
      reasons,
    };
  }
}
