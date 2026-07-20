import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_NAME, DEFAULT_TENANT_PLAN, type TenantPlan } from "../tenancy/constants.js";

export type AuthRole = "admin" | "user" | "viewer";

export type AuthOrganization = {
  id: string;
  name: string;
  slug: string;
  plan: TenantPlan;
  createdAt: string;
  enabled: boolean;
};

export type AuthUser = {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: AuthRole;
  enabled: boolean;
  createdAt: string;
};

export type AuthIdentity = {
  user: AuthUser;
  sessionId: string;
  expiresAt: string;
};

type StoredUser = AuthUser & {
  passwordHash: string;
};

type StoredSession = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
};

type AuthState = {
  version: 2;
  organizations: AuthOrganization[];
  users: StoredUser[];
  sessions: StoredSession[];
};

export type AuthServiceOptions = {
  file: string;
  adminEmail: string;
  adminName: string;
  adminPassword?: string | undefined;
  sessionTtlMs: number;
};

export type LoginResult = AuthIdentity & {
  token: string;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function safeUser(user: StoredUser): AuthUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

function emptyState(): AuthState {
  return { version: 2, organizations: [], users: [], sessions: [] };
}

function defaultOrganization(): AuthOrganization {
  return {
    id: DEFAULT_TENANT_ID,
    name: DEFAULT_TENANT_NAME,
    slug: "cherry-workspace",
    plan: DEFAULT_TENANT_PLAN,
    createdAt: new Date().toISOString(),
    enabled: true,
  };
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "organization";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveScrypt(password, salt, 64, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, saltEncoded, hashEncoded] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltEncoded || !hashEncoded) return false;

  try {
    const salt = Buffer.from(saltEncoded, "base64url");
    const expected = Buffer.from(hashEncoded, "base64url");
    const actual = await deriveScrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 32 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export class AuthService {
  private state: AuthState;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: AuthServiceOptions) {
    this.state = this.loadState();
  }

  async initialize(): Promise<void> {
    let changed = false;
    if (!this.state.organizations.length) {
      this.state.organizations.push(defaultOrganization());
      changed = true;
    }
    for (const user of this.state.users) {
      if (!user.tenantId) {
        user.tenantId = DEFAULT_TENANT_ID;
        changed = true;
      }
    }
    if (this.state.users.some((user) => user.enabled)) {
      if (changed) await this.saveState();
      return;
    }

    const password = this.options.adminPassword?.trim();
    if (!password || password.length < 12) {
      throw new Error(
        "Authentication is enabled but no valid CHERRY_AUTH_ADMIN_PASSWORD was provided. " +
        "Set a password with at least 12 characters before starting CherryAgent.",
      );
    }

    const email = normalizeEmail(this.options.adminEmail);
    const now = new Date().toISOString();
    this.state.users.push({
      id: randomUUID(),
      tenantId: DEFAULT_TENANT_ID,
      email,
      name: this.options.adminName.trim() || email,
      role: "admin",
      enabled: true,
      createdAt: now,
      passwordHash: await hashPassword(password),
    });
    await this.saveState();
  }

  async createOrganization(input: { name: string; slug?: string; plan?: TenantPlan }): Promise<AuthOrganization> {
    const name = input.name.trim();
    if (!name) throw new Error("Organization name is required");
    const slug = normalizeSlug(input.slug ?? name);
    if (this.state.organizations.some((item) => item.slug === slug)) throw new Error(`Organization slug already exists: ${slug}`);
    const organization: AuthOrganization = {
      id: `org-${randomUUID()}`,
      name,
      slug,
      plan: input.plan ?? "pilot",
      createdAt: new Date().toISOString(),
      enabled: true,
    };
    this.state.organizations.push(organization);
    await this.saveState();
    return structuredClone(organization);
  }

  async createMember(input: {
    tenantId: string;
    email: string;
    name: string;
    password: string;
    role?: AuthRole;
  }): Promise<AuthUser> {
    if (!this.state.organizations.some((item) => item.id === input.tenantId && item.enabled)) {
      throw new Error(`Organization not found: ${input.tenantId}`);
    }
    const email = normalizeEmail(input.email);
    if (this.state.users.some((item) => item.email === email)) throw new Error(`User already exists: ${email}`);
    if (input.password.trim().length < 12) throw new Error("Password must contain at least 12 characters");
    const user: StoredUser = {
      id: randomUUID(),
      tenantId: input.tenantId,
      email,
      name: input.name.trim() || email,
      role: input.role ?? "user",
      enabled: true,
      createdAt: new Date().toISOString(),
      passwordHash: await hashPassword(input.password),
    };
    this.state.users.push(user);
    await this.saveState();
    return safeUser(user);
  }

  getOrganization(tenantId: string): AuthOrganization | undefined {
    const organization = this.state.organizations.find((item) => item.id === tenantId && item.enabled);
    return organization ? structuredClone(organization) : undefined;
  }

  listOrganizations(): AuthOrganization[] {
    return this.state.organizations.filter((item) => item.enabled).map((item) => structuredClone(item));
  }

  async login(email: string, password: string): Promise<LoginResult> {
    this.pruneExpiredSessions();
    const user = this.state.users.find((item) => item.email === normalizeEmail(email) && item.enabled);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new Error("Invalid email or password");
    }

    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.options.sessionTtlMs);
    const session: StoredSession = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.state.sessions.push(session);
    await this.saveState();

    return {
      token,
      user: safeUser(user),
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }

  authenticate(token: string | undefined): AuthIdentity | undefined {
    if (!token?.trim()) return undefined;
    const now = Date.now();
    const tokenHash = hashToken(token.trim());
    const session = this.state.sessions.find((item) => {
      if (Date.parse(item.expiresAt) <= now) return false;
      const expected = Buffer.from(item.tokenHash, "hex");
      const actual = Buffer.from(tokenHash, "hex");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    });
    if (!session) return undefined;

    const user = this.state.users.find((item) => item.id === session.userId && item.enabled);
    if (!user) return undefined;
    return { user: safeUser(user), sessionId: session.id, expiresAt: session.expiresAt };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token?.trim()) return;
    const tokenHash = hashToken(token.trim());
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((item) => item.tokenHash !== tokenHash);
    if (this.state.sessions.length !== before) await this.saveState();
  }

  private loadState(): AuthState {
    if (!existsSync(this.options.file)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.options.file, "utf8")) as Partial<AuthState>;
      if (![1, 2].includes(Number(parsed.version)) || !Array.isArray(parsed.users) || !Array.isArray(parsed.sessions)) {
        throw new Error("unsupported auth state version");
      }
      return {
        version: 2,
        organizations: Array.isArray((parsed as Partial<AuthState>).organizations)
          ? (parsed as Partial<AuthState>).organizations as AuthOrganization[]
          : [defaultOrganization()],
        users: (parsed.users as StoredUser[]).map((user) => ({
          ...user,
          tenantId: user.tenantId || DEFAULT_TENANT_ID,
        })),
        sessions: parsed.sessions as StoredSession[],
      };
    } catch (error) {
      throw new Error(`Could not read authentication state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    this.state.sessions = this.state.sessions.filter((item) => Date.parse(item.expiresAt) > now);
  }

  private async saveState(): Promise<void> {
    const serialized = JSON.stringify(this.state, null, 2) + "\n";
    const tempFile = `${this.options.file}.${process.pid}.${randomUUID()}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.options.file), { recursive: true });
      await writeFile(tempFile, serialized, { encoding: "utf8", mode: 0o600 });
      await chmod(tempFile, 0o600);
      await rename(tempFile, this.options.file);
    });
    await this.writeQueue;
  }
}
