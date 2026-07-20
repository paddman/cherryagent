import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { LinuxSshClient, type LinuxCommandResult, type LinuxSshClientOptions } from "./LinuxSshClient.js";

export type LinuxSshAuthentication = "private-key" | "password" | "ssh-agent";

export type LinuxSshHostKey = {
  host: string;
  port: number;
  keyType: string;
  hostKey: string;
  fingerprint: string;
};

export type LinuxSshProfileInput = {
  host: string;
  username: string;
  port?: number;
  authentication: LinuxSshAuthentication;
  privateKey?: string;
  password?: string;
  hostKey: string;
  expectedFingerprint: string;
};

type StoredLinuxSshProfile = {
  version: 1;
  host: string;
  username: string;
  port: number;
  authentication: LinuxSshAuthentication;
  privateKeyPath?: string;
  encryptedPassword?: string;
  knownHostsFile: string;
  keyType: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string;
};

export type LinuxSshPublicStatus = ReturnType<LinuxSshClient["status"]> & {
  source: "profile" | "environment";
  ready: boolean;
  fingerprint: string | null;
  keyType: string | null;
  lastVerifiedAt: string | null;
};

export type LinuxSshProfileStoreOptions = {
  profileFile: string;
  keyDirectory: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  environmentClientOptions: LinuxSshClientOptions;
};

const probeCommand = "printf '%s\\n' '--- hostname ---'; hostname; printf '%s\\n' '--- user ---'; id -un; printf '%s\\n' '--- kernel ---'; uname -sr; printf '%s\\n' '--- uptime ---'; uptime";

function normalizeHost(value: string): string {
  const host = value.trim().replace(/^\[|\]$/g, "");
  if (!host || host.length > 255 || host.startsWith("-") || !/^[a-zA-Z0-9._:-]+$/.test(host)) {
    throw new Error("SSH host must be a hostname or IP address");
  }
  return host;
}

function normalizeUsername(value: string): string {
  const username = value.trim();
  if (!username || username.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw new Error("SSH username contains unsupported characters");
  }
  return username;
}

function normalizePort(value: number | undefined): number {
  const port = value ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SSH port must be between 1 and 65535");
  return port;
}

function knownHostToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function parseHostKey(hostKey: string): { keyType: string; keyData: string } {
  const line = hostKey.split(/\r?\n/).map((item) => item.trim()).find((item) => item && !item.startsWith("#"));
  if (!line) throw new Error("SSH host key is required");
  const fields = line.split(/\s+/);
  const keyTypeIndex = fields.findIndex((field) => /^(?:ssh-|ecdsa-|sk-)/.test(field));
  const keyType = keyTypeIndex >= 0 ? fields[keyTypeIndex] : undefined;
  const keyData = keyTypeIndex >= 0 ? fields[keyTypeIndex + 1] : undefined;
  if (!keyType || !keyData || !/^[A-Za-z0-9+/]+={0,2}$/.test(keyData)) {
    throw new Error("SSH host key is invalid");
  }
  return { keyType, keyData };
}

function fingerprintForKeyData(keyData: string): string {
  const digest = createHash("sha256").update(Buffer.from(keyData, "base64")).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

function validatePrivateKey(privateKey: string | undefined): string {
  const value = privateKey?.trim();
  if (!value || value.length > 128_000 || !/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----$/.test(value)) {
    throw new Error("A valid SSH private key is required");
  }
  return `${value}\n`;
}

function validatePassword(password: string | undefined): string {
  if (!password || password.length > 4_096 || /[\u0000\r\n]/.test(password)) {
    throw new Error("A valid SSH password is required");
  }
  return password;
}

function safeSshError(result: LinuxCommandResult): string {
  const detail = (result.stderr || result.stdout || `ssh exited with code ${String(result.exitCode)}`)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 1_500);
  if (/permission denied|authentication failed/i.test(detail)) return `SSH authentication failed: ${detail}`;
  if (/host key verification failed|remote host identification has changed/i.test(detail)) return `SSH host verification failed: ${detail}`;
  if (/connection timed out|operation timed out/i.test(detail) || result.timedOut) return `SSH connection timed out: ${detail}`;
  if (/connection refused|no route to host|network is unreachable|could not resolve hostname/i.test(detail)) return `SSH network connection failed: ${detail}`;
  return `SSH login failed: ${detail}`;
}

async function atomicWrite(path: string, content: string | Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, path);
}

async function collectProcess(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 256_000) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 32_000) stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ stdout, stderr, exitCode });
    });
  });
}

export class LinuxSshProfileStore {
  #profile: StoredLinuxSshProfile | undefined;
  #configurationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: LinuxSshClient,
    private readonly options: LinuxSshProfileStoreOptions,
  ) {}

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.profileFile, "utf8")) as StoredLinuxSshProfile;
      if (parsed.version !== 1) throw new Error("Unsupported SSH profile version");
      this.#profile = parsed;
      this.client.configure(await this.clientOptions(parsed));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[LinuxSshProfileStore] could not load profile: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.#profile = undefined;
      this.client.configure(this.options.environmentClientOptions);
    }
  }

  status(): LinuxSshPublicStatus {
    const profile = this.#profile;
    return {
      ...this.client.status(),
      source: profile ? "profile" : "environment",
      ready: Boolean(profile?.lastVerifiedAt),
      fingerprint: profile?.fingerprint ?? null,
      keyType: profile?.keyType ?? null,
      lastVerifiedAt: profile?.lastVerifiedAt ?? null,
    };
  }

  async scanHostKey(rawHost: string, rawPort?: number): Promise<LinuxSshHostKey> {
    const host = normalizeHost(rawHost);
    const port = normalizePort(rawPort);
    const result = await collectProcess("ssh-keyscan", ["-T", "10", "-p", String(port), "-t", "ed25519,ecdsa,rsa", host], 15_000);
    const candidates = result.stdout.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => parseHostKey(line));
    const selected = candidates.find((item) => item.keyType === "ssh-ed25519") ?? candidates[0];
    if (!selected) {
      const detail = result.stderr.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
      throw new Error(`Could not read the SSH host key${detail ? `: ${detail}` : ""}`);
    }
    const normalizedHostKey = `${knownHostToken(host, port)} ${selected.keyType} ${selected.keyData}`;
    return {
      host,
      port,
      keyType: selected.keyType,
      hostKey: normalizedHostKey,
      fingerprint: fingerprintForKeyData(selected.keyData),
    };
  }

  async configureAndConnect(input: LinuxSshProfileInput): Promise<{ status: LinuxSshPublicStatus; probe: LinuxCommandResult }> {
    const operation = this.#configurationQueue.then(() => this.configureAndConnectNow(input));
    this.#configurationQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async probe(): Promise<{ status: LinuxSshPublicStatus; probe: LinuxCommandResult }> {
    const result = await this.client.execute(probeCommand);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(safeSshError(result));
    if (this.#profile) {
      this.#profile.lastVerifiedAt = new Date().toISOString();
      this.#profile.updatedAt = this.#profile.lastVerifiedAt;
      await atomicWrite(this.options.profileFile, JSON.stringify(this.#profile, null, 2), 0o600);
    }
    return { status: this.status(), probe: result };
  }

  private async configureAndConnectNow(input: LinuxSshProfileInput): Promise<{ status: LinuxSshPublicStatus; probe: LinuxCommandResult }> {
    const host = normalizeHost(input.host);
    const username = normalizeUsername(input.username);
    const port = normalizePort(input.port);
    const { keyType, keyData } = parseHostKey(input.hostKey);
    const fingerprint = fingerprintForKeyData(keyData);
    if (fingerprint !== input.expectedFingerprint.trim()) {
      throw new Error(`SSH host fingerprint changed. Expected ${input.expectedFingerprint.trim()}, received ${fingerprint}`);
    }

    await mkdir(this.options.keyDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.options.keyDirectory, 0o700);
    const id = randomUUID();
    const knownHostsFile = resolve(this.options.keyDirectory, `${id}.known_hosts`);
    const privateKeyPath = input.authentication === "private-key"
      ? resolve(this.options.keyDirectory, `${id}.key`)
      : undefined;
    const knownHostsLine = `${knownHostToken(host, port)} ${keyType} ${keyData}\n`;
    await atomicWrite(knownHostsFile, knownHostsLine, 0o600);

    let encryptedPassword: string | undefined;
    try {
      if (privateKeyPath) await atomicWrite(privateKeyPath, validatePrivateKey(input.privateKey), 0o600);
      if (input.authentication === "password") encryptedPassword = await this.encryptSecret(validatePassword(input.password));
      const askpassPath = input.authentication === "password" ? await this.ensureAskpassHelper() : undefined;
      const candidateOptions: LinuxSshClientOptions = {
        host,
        username,
        port,
        ...(privateKeyPath ? { privateKeyPath } : {}),
        ...(input.authentication === "password" && askpassPath ? { password: validatePassword(input.password), askpassPath } : {}),
        knownHostsFile,
        strictHostKeyChecking: true,
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.maxOutputBytes !== undefined ? { maxOutputBytes: this.options.maxOutputBytes } : {}),
      };
      const candidate = new LinuxSshClient(candidateOptions);
      const probe = await candidate.execute(probeCommand);
      if (probe.exitCode !== 0 || probe.timedOut) throw new Error(safeSshError(probe));

      const now = new Date().toISOString();
      const previous = this.#profile;
      const profile: StoredLinuxSshProfile = {
        version: 1,
        host,
        username,
        port,
        authentication: input.authentication,
        ...(privateKeyPath ? { privateKeyPath } : {}),
        ...(encryptedPassword ? { encryptedPassword } : {}),
        knownHostsFile,
        keyType,
        fingerprint,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        lastVerifiedAt: now,
      };
      await atomicWrite(this.options.profileFile, JSON.stringify(profile, null, 2), 0o600);
      this.#profile = profile;
      this.client.configure(candidateOptions);
      await this.removeOldCredentialFiles(previous, profile).catch((error) => {
        console.warn(`[LinuxSshProfileStore] could not remove superseded credential files: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { status: this.status(), probe };
    } catch (error) {
      await rm(knownHostsFile, { force: true });
      if (privateKeyPath) await rm(privateKeyPath, { force: true });
      throw error;
    }
  }

  private async clientOptions(profile: StoredLinuxSshProfile): Promise<LinuxSshClientOptions> {
    const password = profile.authentication === "password" && profile.encryptedPassword
      ? await this.decryptSecret(profile.encryptedPassword)
      : undefined;
    const askpassPath = password ? await this.ensureAskpassHelper() : undefined;
    return {
      host: profile.host,
      username: profile.username,
      port: profile.port,
      ...(profile.privateKeyPath ? { privateKeyPath: profile.privateKeyPath } : {}),
      ...(password && askpassPath ? { password, askpassPath } : {}),
      knownHostsFile: profile.knownHostsFile,
      strictHostKeyChecking: true,
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(this.options.maxOutputBytes !== undefined ? { maxOutputBytes: this.options.maxOutputBytes } : {}),
    };
  }

  private async ensureAskpassHelper(): Promise<string> {
    const path = resolve(this.options.keyDirectory, "askpass.sh");
    await atomicWrite(path, "#!/bin/sh\nexec printf '%s\\n' \"$CHERRY_SSH_PASSWORD\"\n", 0o700);
    return path;
  }

  private async encryptionKey(): Promise<Buffer> {
    const path = resolve(this.options.keyDirectory, "master.key");
    await mkdir(this.options.keyDirectory, { recursive: true, mode: 0o700 });
    try {
      const existing = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
      if (existing.length !== 32) throw new Error("SSH credential master key has an invalid length");
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const generated = randomBytes(32);
      try {
        await writeFile(path, generated.toString("base64url"), { mode: 0o600, flag: "wx" });
        return generated;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        const existing = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
        if (existing.length !== 32) throw new Error("SSH credential master key has an invalid length");
        return existing;
      }
    }
  }

  private async encryptSecret(secret: string): Promise<string> {
    const key = await this.encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  private async decryptSecret(value: string): Promise<string> {
    const [version, ivValue, tagValue, encryptedValue] = value.split(".");
    if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) throw new Error("SSH credential payload is invalid");
    const key = await this.encryptionKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
  }

  private async removeOldCredentialFiles(previous: StoredLinuxSshProfile | undefined, current: StoredLinuxSshProfile): Promise<void> {
    if (!previous) return;
    const root = resolve(this.options.keyDirectory) + sep;
    const candidates = [previous.privateKeyPath, previous.knownHostsFile].filter((path): path is string => Boolean(path));
    for (const path of candidates) {
      const absolute = resolve(path);
      if (absolute.startsWith(root) && absolute !== current.privateKeyPath && absolute !== current.knownHostsFile) {
        await rm(absolute, { force: true });
      }
    }
  }
}

export { probeCommand };
