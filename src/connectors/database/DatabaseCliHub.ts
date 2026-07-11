import { spawn } from "node:child_process";
import { resolve } from "node:path";

export type DatabaseKind = "postgres" | "mysql" | "sqlite" | "redis";
export type SqlDatabaseKind = Exclude<DatabaseKind, "redis">;
export type SqlRiskClass = "readonly" | "write" | "dangerous";

export type DatabaseCliHubOptions = {
  timeoutMs: number;
  maxOutputBytes?: number;
  postgresUrl?: string;
  mysqlUrl?: string;
  sqlitePath?: string;
  redisUrl?: string;
};

export type DatabaseExecutionResult = {
  kind: DatabaseKind;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  elapsedMs: number;
  truncated: boolean;
};

type CliResult = Omit<DatabaseExecutionResult, "kind" | "command">;

const READONLY_START = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"]);
const WRITE_START = new Set(["INSERT", "UPDATE", "MERGE", "UPSERT", "REPLACE"]);
const DANGEROUS_WORDS = /\b(DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|VACUUM|ATTACH|DETACH|COPY|CALL|EXEC|EXECUTE|DO|REINDEX|CLUSTER)\b/i;
const MUTATION_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|VACUUM|ATTACH|DETACH|COPY|CALL|EXEC|EXECUTE|DO|REINDEX|CLUSTER)\b/i;

const REDIS_READ_COMMANDS = new Set([
  "GET", "MGET", "HGET", "HMGET", "HGETALL", "LRANGE", "SMEMBERS", "ZRANGE",
  "TTL", "PTTL", "TYPE", "EXISTS", "SCAN", "HSCAN", "SSCAN", "ZSCAN", "INFO", "DBSIZE",
]);
const REDIS_WRITE_COMMANDS = new Set([
  "SET", "MSET", "HSET", "HMSET", "LPUSH", "RPUSH", "SADD", "ZADD", "EXPIRE", "PEXPIRE", "PERSIST", "INCR", "DECR",
]);
const REDIS_DANGEROUS_COMMANDS = new Set([
  "DEL", "UNLINK", "FLUSHDB", "FLUSHALL", "RENAME", "RENAMENX", "EVAL", "EVALSHA", "SCRIPT", "CONFIG", "SHUTDOWN",
]);

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .trim();
}

function singleStatement(sql: string): string {
  const cleaned = stripSqlComments(sql).replace(/;+\s*$/, "").trim();
  if (!cleaned) throw new Error("SQL query is required");
  if (cleaned.includes(";")) throw new Error("Multiple SQL statements are not allowed in one tool call");
  return cleaned;
}

export function classifySql(sql: string): SqlRiskClass {
  const cleaned = singleStatement(sql);
  const first = cleaned.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? "";

  if (READONLY_START.has(first)) {
    if (MUTATION_WORDS.test(cleaned)) return "dangerous";
    if (/\bFOR\s+UPDATE\b/i.test(cleaned)) return "dangerous";
    if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(cleaned)) return "dangerous";
    return "readonly";
  }
  if (WRITE_START.has(first)) return DANGEROUS_WORDS.test(cleaned) ? "dangerous" : "write";
  return "dangerous";
}

function requireSqlKind(kind: DatabaseKind): asserts kind is SqlDatabaseKind {
  if (kind === "redis") throw new Error("Use Redis-specific tools for Redis commands");
}

function parseUrl(raw: string, protocols: string[], name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} connection URL is invalid`);
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${name} URL must use ${protocols.join(" or ")}`);
  return url;
}

function decoded(value: string): string {
  return decodeURIComponent(value);
}

async function runCli(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<CliResult> {
  const started = Date.now();
  return await new Promise<CliResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
      windowsHide: true,
    });

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let settled = false;

    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike> | string): Buffer<ArrayBufferLike> => {
      const incoming: Buffer<ArrayBufferLike> = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (current.length >= options.maxOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = options.maxOutputBytes - current.length;
      if (incoming.length > remaining) truncated = true;
      return Buffer.concat([current, incoming.subarray(0, remaining)]);
    };

    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike> | string) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike> | string) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      rejectPromise(new Error(`${command} timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rejectPromise(new Error(`${command} CLI is not installed or not available in PATH`));
        return;
      }
      rejectPromise(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? -1;
      const result: CliResult = {
        stdout: stdout.toString("utf8").trim(),
        stderr: stderr.toString("utf8").trim(),
        exitCode,
        elapsedMs: Date.now() - started,
        truncated,
      };
      if (exitCode !== 0) {
        rejectPromise(new Error(`${command} exited with code ${exitCode}: ${result.stderr || result.stdout || "unknown error"}`));
        return;
      }
      resolvePromise(result);
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export class DatabaseCliHub {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly postgresUrl: string | undefined;
  private readonly mysqlUrl: string | undefined;
  private readonly sqlitePath: string | undefined;
  private readonly redisUrl: string | undefined;

  constructor(options: DatabaseCliHubOptions) {
    this.timeoutMs = Math.max(1_000, options.timeoutMs);
    this.maxOutputBytes = Math.max(4_096, options.maxOutputBytes ?? 1_000_000);
    this.postgresUrl = options.postgresUrl;
    this.mysqlUrl = options.mysqlUrl;
    this.sqlitePath = options.sqlitePath ? resolve(options.sqlitePath) : undefined;
    this.redisUrl = options.redisUrl;
  }

  configured(): Record<DatabaseKind, boolean> {
    return {
      postgres: Boolean(this.postgresUrl),
      mysql: Boolean(this.mysqlUrl),
      sqlite: Boolean(this.sqlitePath),
      redis: Boolean(this.redisUrl),
    };
  }

  async query(kind: SqlDatabaseKind, sql: string): Promise<DatabaseExecutionResult> {
    const statement = singleStatement(sql);
    if (kind === "postgres") return await this.runPostgres(statement);
    if (kind === "mysql") return await this.runMysql(statement);
    return await this.runSqlite(statement);
  }

  async describeSchema(kind: DatabaseKind): Promise<DatabaseExecutionResult> {
    if (kind === "redis") return await this.redis("INFO", ["keyspace"]);
    requireSqlKind(kind);
    if (kind === "postgres") {
      return await this.query(kind, "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position LIMIT 2000");
    }
    if (kind === "mysql") {
      return await this.query(kind, "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position LIMIT 2000");
    }
    return await this.query(kind, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','view','index') ORDER BY type, name");
  }

  async explain(kind: SqlDatabaseKind, sql: string): Promise<DatabaseExecutionResult> {
    if (classifySql(sql) !== "readonly") throw new Error("EXPLAIN is limited to read-only SQL");
    const statement = singleStatement(sql);
    return await this.query(kind, kind === "sqlite" ? `EXPLAIN QUERY PLAN ${statement}` : `EXPLAIN ${statement}`);
  }

  async redis(command: string, args: string[]): Promise<DatabaseExecutionResult> {
    if (!this.redisUrl) throw new Error("Redis connection is not configured");
    const url = parseUrl(this.redisUrl, ["redis:", "rediss:"], "Redis");
    const database = url.pathname.replace(/^\//, "") || "0";
    const cliArgs = ["--raw", "-h", url.hostname, "-p", url.port || "6379", "-n", database];
    if (url.username) cliArgs.push("--user", decoded(url.username));
    if (url.protocol === "rediss:") cliArgs.push("--tls");
    cliArgs.push(command.toUpperCase(), ...args);
    const result = await runCli("redis-cli", cliArgs, {
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      env: {
        ...process.env,
        ...(url.password ? { REDISCLI_AUTH: decoded(url.password) } : {}),
      },
    });
    return { kind: "redis", command: command.toUpperCase(), ...result };
  }

  assertRedisRisk(command: string, expected: "readonly" | "write" | "dangerous"): void {
    const normalized = command.trim().toUpperCase();
    const actual = REDIS_READ_COMMANDS.has(normalized)
      ? "readonly"
      : REDIS_WRITE_COMMANDS.has(normalized)
        ? "write"
        : REDIS_DANGEROUS_COMMANDS.has(normalized)
          ? "dangerous"
          : "dangerous";
    if (actual !== expected) throw new Error(`Redis command ${normalized} is classified as ${actual}, not ${expected}`);
  }

  private async runPostgres(sql: string): Promise<DatabaseExecutionResult> {
    if (!this.postgresUrl) throw new Error("PostgreSQL connection is not configured");
    const url = parseUrl(this.postgresUrl, ["postgres:", "postgresql:"], "PostgreSQL");
    const database = decoded(url.pathname.replace(/^\//, ""));
    if (!database) throw new Error("PostgreSQL URL must include a database name");
    const args = ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--csv", "-h", url.hostname, "-p", url.port || "5432"];
    if (url.username) args.push("-U", decoded(url.username));
    args.push("-d", database, "-c", sql);
    const sslMode = url.searchParams.get("sslmode") ?? process.env.PGSSLMODE;
    const result = await runCli("psql", args, {
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      env: {
        ...process.env,
        ...(url.password ? { PGPASSWORD: decoded(url.password) } : {}),
        ...(sslMode ? { PGSSLMODE: sslMode } : {}),
      },
    });
    return { kind: "postgres", command: sql, ...result };
  }

  private async runMysql(sql: string): Promise<DatabaseExecutionResult> {
    if (!this.mysqlUrl) throw new Error("MySQL connection is not configured");
    const url = parseUrl(this.mysqlUrl, ["mysql:"], "MySQL");
    const database = decoded(url.pathname.replace(/^\//, ""));
    if (!database) throw new Error("MySQL URL must include a database name");
    const args = ["--batch", "--raw", `--host=${url.hostname}`, `--port=${url.port || "3306"}`];
    if (url.username) args.push(`--user=${decoded(url.username)}`);
    args.push(database, `--execute=${sql}`);
    const result = await runCli("mysql", args, {
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      env: {
        ...process.env,
        ...(url.password ? { MYSQL_PWD: decoded(url.password) } : {}),
      },
    });
    return { kind: "mysql", command: sql, ...result };
  }

  private async runSqlite(sql: string): Promise<DatabaseExecutionResult> {
    if (!this.sqlitePath) throw new Error("SQLite database path is not configured");
    const result = await runCli("sqlite3", ["-json", this.sqlitePath, sql], {
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    return { kind: "sqlite", command: sql, ...result };
  }
}
