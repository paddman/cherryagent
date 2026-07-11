import type { AgentTool } from "../../core/types.js";
import {
  DatabaseCliHub,
  classifySql,
  type DatabaseKind,
  type SqlDatabaseKind,
} from "../../connectors/database/DatabaseCliHub.js";

const databaseKinds: DatabaseKind[] = ["postgres", "mysql", "sqlite", "redis"];
const sqlKinds: SqlDatabaseKind[] = ["postgres", "mysql", "sqlite"];

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value.map((item) => item.trim());
}

function parseDatabaseKind(value: unknown): DatabaseKind {
  if (typeof value !== "string" || !databaseKinds.includes(value as DatabaseKind)) {
    throw new Error(`database must be one of: ${databaseKinds.join(", ")}`);
  }
  return value as DatabaseKind;
}

function parseSqlKind(value: unknown): SqlDatabaseKind {
  if (typeof value !== "string" || !sqlKinds.includes(value as SqlDatabaseKind)) {
    throw new Error(`database must be one of: ${sqlKinds.join(", ")}`);
  }
  return value as SqlDatabaseKind;
}

export function createDatabaseTools(database: DatabaseCliHub): AgentTool[] {
  return [
    {
      name: "db_list_connections",
      description: "List which generic database connectors are configured: PostgreSQL, MySQL, SQLite, and Redis. Never exposes credentials.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => database.configured(),
    },
    {
      name: "db_query_readonly",
      description: "Execute exactly one read-only SQL statement against PostgreSQL, MySQL, or SQLite. Only SELECT/WITH/SHOW/DESCRIBE/DESC/EXPLAIN without mutation keywords is allowed.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          database: { type: "string", enum: sqlKinds },
          sql: { type: "string" },
        },
        required: ["database", "sql"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const sql = requiredString(args, "sql");
        const risk = classifySql(sql);
        if (risk !== "readonly") throw new Error(`SQL is classified as ${risk}; read-only tool refused it`);
        return await database.query(parseSqlKind(args.database), sql);
      },
    },
    {
      name: "db_describe_schema",
      description: "Inspect configured PostgreSQL, MySQL, SQLite, or Redis schema/keyspace metadata using read-only queries.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { database: { type: "string", enum: databaseKinds } },
        required: ["database"],
        additionalProperties: false,
      },
      execute: async (args) => database.describeSchema(parseDatabaseKind(args.database)),
    },
    {
      name: "db_explain_query",
      description: "Run EXPLAIN or EXPLAIN QUERY PLAN for one read-only SQL query on PostgreSQL, MySQL, or SQLite.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          database: { type: "string", enum: sqlKinds },
          sql: { type: "string" },
        },
        required: ["database", "sql"],
        additionalProperties: false,
      },
      execute: async (args) => database.explain(parseSqlKind(args.database), requiredString(args, "sql")),
    },
    {
      name: "db_execute_write",
      description: "Execute exactly one non-destructive SQL write statement such as INSERT, UPDATE, MERGE, UPSERT, or REPLACE. Remote data mutation requires external approval.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          database: { type: "string", enum: sqlKinds },
          sql: { type: "string" },
        },
        required: ["database", "sql"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const sql = requiredString(args, "sql");
        const risk = classifySql(sql);
        if (risk !== "write") throw new Error(`SQL is classified as ${risk}; write tool refused it`);
        return await database.query(parseSqlKind(args.database), sql);
      },
    },
    {
      name: "db_execute_dangerous",
      description: "Execute exactly one destructive or schema-changing SQL statement such as DELETE, DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE, or other high-impact SQL. Requires dangerous approval.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          database: { type: "string", enum: sqlKinds },
          sql: { type: "string" },
        },
        required: ["database", "sql"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const sql = requiredString(args, "sql");
        const risk = classifySql(sql);
        if (risk === "readonly") throw new Error("Read-only SQL must use db_query_readonly");
        return await database.query(parseSqlKind(args.database), sql);
      },
    },
    {
      name: "db_redis_read",
      description: "Run an allowlisted read-only Redis command such as GET, HGETALL, LRANGE, SMEMBERS, ZRANGE, TTL, TYPE, EXISTS, SCAN, INFO, or DBSIZE.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const command = requiredString(args, "command").toUpperCase();
        database.assertRedisRisk(command, "readonly");
        return await database.redis(command, stringArray(args.args, "args"));
      },
    },
    {
      name: "db_redis_write",
      description: "Run an allowlisted non-destructive Redis mutation such as SET, HSET, LPUSH, RPUSH, SADD, ZADD, EXPIRE, INCR, or DECR. Requires external approval.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const command = requiredString(args, "command").toUpperCase();
        database.assertRedisRisk(command, "write");
        return await database.redis(command, stringArray(args.args, "args"));
      },
    },
    {
      name: "db_redis_dangerous",
      description: "Run an allowlisted destructive/high-impact Redis command such as DEL, UNLINK, FLUSHDB, FLUSHALL, RENAME, EVAL, CONFIG, or SHUTDOWN. Requires dangerous approval.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const command = requiredString(args, "command").toUpperCase();
        database.assertRedisRisk(command, "dangerous");
        return await database.redis(command, stringArray(args.args, "args"));
      },
    },
  ];
}
