import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { RiskLevel } from "../core/types.js";
import type { ChannelAccessStore } from "../channels/ChannelAccessStore.js";
import type { ResilientLlmProvider } from "../llm/ResilientLlmProvider.js";
import type { SkillStore } from "../skills/SkillStore.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  status: DoctorCheckStatus;
  summary: string;
  evidence: string[];
  remediation?: string;
};

export type DoctorReport = {
  generatedAt: string;
  healthy: boolean;
  counts: Record<DoctorCheckStatus, number>;
  checks: DoctorCheck[];
};

export type SystemDoctorOptions = {
  serverHost: string;
  authEnabled: boolean;
  authFile: string;
  autoApprove: ReadonlySet<RiskLevel>;
  workspaceRoot: string;
  channelNames: () => string[];
  channelAccess: ChannelAccessStore;
  llm: ResilientLlmProvider;
  skills: SkillStore;
  envFile?: string;
  aiWorkerHealth?: () => Promise<unknown>;
};

function check(
  id: string,
  status: DoctorCheckStatus,
  summary: string,
  evidence: string[] = [],
  remediation?: string,
): DoctorCheck {
  return { id, status, summary, evidence, ...(remediation ? { remediation } : {}) };
}

function isLoopback(hostInput: string): boolean {
  const host = hostInput.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function writablePath(path: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await access(path, fsConstants.R_OK | fsConstants.W_OK);
    return { ok: true, detail: `${path} is readable and writable` };
  } catch (error) {
    return { ok: false, detail: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function permissionCheck(path: string, label: string): Promise<DoctorCheck | null> {
  if (process.platform === "win32") return null;
  try {
    const info = await stat(path);
    const exposedBits = info.mode & 0o077;
    return exposedBits === 0
      ? check(`${label}-permissions`, "pass", `${label} permissions are owner-only`, [`${path} mode ${(info.mode & 0o777).toString(8)}`])
      : check(
          `${label}-permissions`,
          "warn",
          `${label} is readable or writable by group/other users`,
          [`${path} mode ${(info.mode & 0o777).toString(8)}`],
          `Restrict the file with chmod 600 ${path}`,
        );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return check(`${label}-permissions`, "warn", `Could not inspect ${label} permissions`, [String(error)]);
  }
}

export class SystemDoctor {
  constructor(private readonly options: SystemDoctorOptions) {}

  async run(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const exposed = !isLoopback(this.options.serverHost);

    if (exposed && !this.options.authEnabled) {
      checks.push(check(
        "gateway-auth",
        "fail",
        "CherryAgent is reachable beyond loopback while API authentication is disabled",
        [`CHERRY_HOST=${this.options.serverHost}`, "CHERRY_AUTH_ENABLED=false"],
        "Enable authentication or bind CHERRY_HOST to 127.0.0.1 and use a trusted reverse proxy or SSH tunnel.",
      ));
    } else if (exposed) {
      checks.push(check(
        "gateway-auth",
        "warn",
        "CherryAgent is bound beyond loopback; authentication must remain enforced at every route",
        [`CHERRY_HOST=${this.options.serverHost}`, "authentication enabled"],
        "Prefer loopback binding behind a TLS reverse proxy, VPN, or SSH tunnel.",
      ));
    } else {
      checks.push(check("gateway-auth", "pass", "Gateway is bound to loopback", [`CHERRY_HOST=${this.options.serverHost}`]));
    }

    const broadRisks = (["external", "dangerous"] as const).filter((risk) => this.options.autoApprove.has(risk));
    checks.push(broadRisks.length
      ? check(
          "approval-policy",
          "fail",
          "Consequential tool risk levels are configured for automatic approval",
          [`auto-approved: ${broadRisks.join(", ")}`],
          "Keep CHERRY_AUTO_APPROVE limited to safe,write and require a human for external/dangerous actions.",
        )
      : check("approval-policy", "pass", "External and dangerous tools require approval", [
          `auto-approved: ${[...this.options.autoApprove].join(", ") || "none"}`,
        ]));

    const channelNames = this.options.channelNames();
    if (!channelNames.length) {
      checks.push(check("channel-ingress", "pass", "No configured external channel adapters are active"));
    } else {
      for (const channel of channelNames) {
        const [snapshot] = await this.options.channelAccess.list(channel);
        if (!snapshot) continue;
        if (snapshot.policy === "open" || snapshot.allowFrom.includes("*")) {
          checks.push(check(
            `channel-${channel}`,
            "warn",
            `${channel} accepts unpaired senders`,
            [`policy=${snapshot.policy}`, `allowFrom=${snapshot.allowFrom.join(",") || "empty"}`],
            `Use channel_access_set_policy with policy=pairing and approve known senders individually.`,
          ));
        } else if (snapshot.policy === "disabled") {
          checks.push(check(`channel-${channel}`, "pass", `${channel} ingress is disabled`, ["policy=disabled"]));
        } else {
          checks.push(check(
            `channel-${channel}`,
            "pass",
            `${channel} ingress is restricted`,
            [`policy=${snapshot.policy}`, `allowlisted=${snapshot.allowFrom.length}`, `pending=${snapshot.pending.length}`],
          ));
        }
      }
    }

    const llm = this.options.llm.getStatus();
    checks.push(llm.healthy
      ? check(
          "llm-failover",
          "pass",
          "At least one LLM profile is currently available",
          llm.profiles.map((profile) => `${profile.id}:${profile.model}:${profile.available ? "available" : "cooldown"}`),
        )
      : check(
          "llm-failover",
          "fail",
          "Every configured LLM profile is in cooldown or disabled",
          llm.profiles.map((profile) => `${profile.id}: cooldown=${profile.cooldownUntil ?? "none"}, disabled=${profile.disabledUntil ?? "none"}`),
          "Fix provider credentials/capacity or wait until the earliest recorded retry time.",
        ));

    const workspace = await writablePath(this.options.workspaceRoot);
    checks.push(workspace.ok
      ? check("workspace", "pass", "Workspace is accessible", [workspace.detail])
      : check("workspace", "fail", "Workspace is not readable and writable", [workspace.detail], "Create the workspace and grant the CherryAgent service account access."));

    const skillRoot = await writablePath(this.options.skills.root());
    checks.push(skillRoot.ok
      ? check("skills", "pass", "Procedural skill storage is accessible", [skillRoot.detail])
      : check("skills", "warn", "Procedural skill storage is not currently accessible", [skillRoot.detail], "Create CHERRY_SKILLS_ROOT with owner-only write permissions."));

    const envPermission = await permissionCheck(this.options.envFile ?? ".env", "env-file");
    if (envPermission) checks.push(envPermission);
    const authPermission = await permissionCheck(this.options.authFile, "auth-state");
    if (authPermission) checks.push(authPermission);

    if (this.options.aiWorkerHealth) {
      try {
        const health = await this.options.aiWorkerHealth();
        checks.push(check("ai-worker", "pass", "Python AI worker is reachable", [JSON.stringify(health).slice(0, 500)]));
      } catch (error) {
        checks.push(check(
          "ai-worker",
          "warn",
          "Python AI worker is configured but unreachable",
          [error instanceof Error ? error.message : String(error)],
          "Start services/cherry-ai-worker or disable CHERRY_AI_WORKER_ENABLED until it is deployed.",
        ));
      }
    }

    const counts: Record<DoctorCheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
    for (const item of checks) counts[item.status] += 1;
    return {
      generatedAt: new Date().toISOString(),
      healthy: counts.fail === 0,
      counts,
      checks,
    };
  }
}
