import { spawn } from "node:child_process";

export type LinuxSshClientOptions = {
  host: string;
  username?: string;
  port?: number;
  privateKeyPath?: string;
  knownHostsFile?: string;
  strictHostKeyChecking?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type LinuxCommandResult = {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function appendLimited(current: string, chunk: Buffer, limit: number): { value: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current);
  if (currentBytes >= limit) return { value: current, truncated: true };

  const remaining = limit - currentBytes;
  if (chunk.byteLength <= remaining) {
    return { value: current + chunk.toString("utf8"), truncated: false };
  }

  return {
    value: current + chunk.subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

export class LinuxSshClient {
  readonly #host: string;
  readonly #username?: string;
  readonly #port: number;
  readonly #privateKeyPath?: string;
  readonly #knownHostsFile?: string;
  readonly #strictHostKeyChecking: boolean;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: LinuxSshClientOptions) {
    this.#host = options.host.trim();
    this.#username = options.username?.trim() || undefined;
    this.#port = positiveInteger(options.port, 22);
    this.#privateKeyPath = options.privateKeyPath?.trim() || undefined;
    this.#knownHostsFile = options.knownHostsFile?.trim() || undefined;
    this.#strictHostKeyChecking = options.strictHostKeyChecking ?? true;
    this.#timeoutMs = positiveInteger(options.timeoutMs, 30_000);
    this.#maxOutputBytes = positiveInteger(options.maxOutputBytes, 1_000_000);
  }

  isConfigured(): boolean {
    return Boolean(this.#host);
  }

  status(): {
    configured: boolean;
    host: string | null;
    username: string | null;
    port: number;
    strictHostKeyChecking: boolean;
    privateKeyConfigured: boolean;
  } {
    return {
      configured: this.isConfigured(),
      host: this.#host || null,
      username: this.#username ?? null,
      port: this.#port,
      strictHostKeyChecking: this.#strictHostKeyChecking,
      privateKeyConfigured: Boolean(this.#privateKeyPath),
    };
  }

  async execute(command: string, timeoutMs = this.#timeoutMs): Promise<LinuxCommandResult> {
    const normalized = command.trim();
    if (!normalized) throw new Error("Linux SSH command must not be empty");
    if (!this.isConfigured()) throw new Error("Linux SSH connector is not configured");

    const target = this.#username ? `${this.#username}@${this.#host}` : this.#host;
    const connectTimeoutSeconds = Math.max(1, Math.ceil(Math.min(timeoutMs, 120_000) / 1_000));
    const args = [
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
      "-p", String(this.#port),
    ];

    if (this.#privateKeyPath) args.push("-i", this.#privateKeyPath);
    if (this.#knownHostsFile) args.push("-o", `UserKnownHostsFile=${this.#knownHostsFile}`);

    if (this.#strictHostKeyChecking) {
      args.push("-o", "StrictHostKeyChecking=yes");
    } else {
      args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
    }

    args.push(target, normalized);

    return await new Promise<LinuxCommandResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn("ssh", args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, positiveInteger(timeoutMs, this.#timeoutMs));

      child.stdout.on("data", (chunk: Buffer) => {
        const next = appendLimited(stdout, chunk, this.#maxOutputBytes);
        stdout = next.value;
        truncated ||= next.truncated;
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const next = appendLimited(stderr, chunk, this.#maxOutputBytes);
        stderr = next.value;
        truncated ||= next.truncated;
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to start ssh client: ${error.message}`));
      });

      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          command: normalized,
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          truncated,
        });
      });
    });
  }

  async readFile(path: string, maxBytes = 256_000): Promise<LinuxCommandResult> {
    const boundedBytes = Math.min(Math.max(1, Math.floor(maxBytes)), this.#maxOutputBytes);
    return await this.execute(`head -c ${boundedBytes} -- ${shellQuote(path)}`);
  }

  async writeFile(path: string, content: string, options: { sudo?: boolean; mode?: string } = {}): Promise<LinuxCommandResult> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > 256_000) throw new Error("linux_write_file content exceeds 256000 bytes");

    const encoded = Buffer.from(content, "utf8").toString("base64");
    const sudo = options.sudo ? "sudo " : "";
    const target = shellQuote(path);
    const writeCommand = `printf %s ${shellQuote(encoded)} | base64 -d | ${sudo}tee ${target} >/dev/null`;
    const chmodCommand = options.mode ? ` && ${sudo}chmod ${shellQuote(options.mode)} ${target}` : "";
    return await this.execute(writeCommand + chmodCommand);
  }

  async serviceStatus(service: string): Promise<LinuxCommandResult> {
    const unit = shellQuote(service);
    return await this.execute(
      `systemctl status --no-pager --full ${unit}; rc=$?; echo; systemctl show ${unit} --no-pager -p ActiveState -p SubState -p UnitFileState -p MainPID -p ExecMainStatus; exit $rc`,
    );
  }

  async serviceAction(service: string, action: "start" | "stop" | "restart" | "reload", sudo = true): Promise<LinuxCommandResult> {
    const prefix = sudo ? "sudo " : "";
    return await this.execute(`${prefix}systemctl ${action} ${shellQuote(service)}`);
  }

  async logs(unit: string, lines = 200, since?: string): Promise<LinuxCommandResult> {
    const boundedLines = Math.min(Math.max(1, Math.floor(lines)), 5_000);
    const sinceArg = since?.trim() ? ` --since ${shellQuote(since.trim())}` : "";
    return await this.execute(`journalctl -u ${shellQuote(unit)} -n ${boundedLines} --no-pager -o short-iso${sinceArg}`);
  }

  async diskStatus(): Promise<LinuxCommandResult> {
    return await this.execute("df -hT -x tmpfs -x devtmpfs; echo; df -i -x tmpfs -x devtmpfs");
  }

  async processList(limit = 30): Promise<LinuxCommandResult> {
    const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
    return await this.execute(`ps -eo pid,ppid,user,%cpu,%mem,stat,etime,comm,args --sort=-%cpu | head -n ${boundedLimit + 1}`);
  }

  async networkStatus(): Promise<LinuxCommandResult> {
    return await this.execute("ip -brief address; echo; ip route; echo; ss -lntup");
  }

  async verifyHttp(url: string, expectedStatus = 200, timeoutSeconds = 10): Promise<LinuxCommandResult & { expectedStatus: number; verified: boolean }> {
    const boundedTimeout = Math.min(Math.max(1, Math.floor(timeoutSeconds)), 120);
    const result = await this.execute(
      `curl -sS -L --max-time ${boundedTimeout} -o /dev/null -w '%{http_code}' ${shellQuote(url)}`,
      (boundedTimeout + 5) * 1_000,
    );
    const actualStatus = Number.parseInt(result.stdout.trim(), 10);
    return {
      ...result,
      expectedStatus,
      verified: result.exitCode === 0 && actualStatus === expectedStatus,
    };
  }
}
