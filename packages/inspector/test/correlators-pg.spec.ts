/**
 * The Postgres correlators reader (#1554) — TLS, and what an empty panel
 * is allowed to mean.
 *
 * The panel reads the framework's `*_correlated` table directly, with its
 * own client, from the connection details the inspector already holds. TLS
 * was the one detail those did not include: `connect` handed the store its
 * SSL settings and then dropped them on the floor, so on any Postgres that
 * requires TLS — RDS, Neon, Supabase — the store connected and the reader
 * never could, leaving the panel permanently dark.
 *
 * Both ends are mocked: `pg` captures the options each client is built
 * with, and `@rotorsoft/act-pg` stands in for a reachable server so the
 * spec exercises the wiring rather than a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pgClients = vi.hoisted(() => [] as Array<Record<string, unknown>>);
/** Set to make the next query fail, standing in for a real server's refusal. */
const queryFault = vi.hoisted(() => ({ error: null as unknown }));

vi.mock("pg", () => {
  class Client {
    constructor(options: Record<string, unknown>) {
      pgClients.push(options);
    }
    async connect() {}
    async query() {
      if (queryFault.error) throw queryFault.error;
      return { rows: [] };
    }
    async end() {}
  }
  return { default: { Client } };
});

vi.mock("@rotorsoft/act-pg", () => {
  class PostgresStore {
    async query() {
      return 0;
    }
    async query_streams() {
      return { maxEventId: 7 };
    }
    async dispose() {}
  }
  return { PostgresStore };
});

const { inspectorRouter } = await import("../src/server/router.js");
const { readCorrelators } = await import("../src/server/correlators.js");
const caller = inspectorRouter.createCaller({});

const pgConnect = {
  adapter: "pg" as const,
  host: "db.example",
  port: 5432,
  database: "app",
  user: "app_user",
  password: "secret",
  schema: "public",
  table: "events",
};

beforeEach(() => {
  pgClients.length = 0;
  queryFault.error = null;
  // `sslInsecure` logs a deliberate downgrade warning on every connect.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await caller.disconnect();
  vi.restoreAllMocks();
});

describe("browse_correlators over a TLS Postgres", () => {
  it("carries verified TLS through to the reader", async () => {
    await caller.connect({ ...pgConnect, ssl: true, sslInsecure: false });
    await caller.browse_correlators();
    expect(pgClients.at(-1)).toMatchObject({
      host: "db.example",
      database: "app",
      user: "app_user",
      ssl: { rejectUnauthorized: true },
    });
  });

  it("carries the explicit verification opt-out through to the reader", async () => {
    await caller.connect({ ...pgConnect, ssl: true, sslInsecure: true });
    await caller.browse_correlators();
    expect(pgClients.at(-1)).toMatchObject({
      ssl: { rejectUnauthorized: false },
    });
  });

  it("leaves TLS off when the store connected without it", async () => {
    await caller.connect({ ...pgConnect, ssl: false, sslInsecure: false });
    await caller.browse_correlators();
    expect(pgClients.at(-1)!.ssl).toBeUndefined();
  });
});

/**
 * An empty panel says "this store has nothing to record". Only a store
 * that really has nothing to record is allowed to produce one.
 */
describe("what an empty result is allowed to mean", () => {
  const config = { ...pgConnect, adapter: "pg" as const };

  it("reads an absent table as nothing to show", async () => {
    // 42P01 — the store predates the table, or keeps it elsewhere.
    queryFault.error = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    expect(await readCorrelators(config)).toEqual([]);
  });

  it("reads the older single-row shape as nothing to show", async () => {
    // 42703 — the table is there, without the `key` column #1532 added.
    queryFault.error = Object.assign(new Error("column key does not exist"), {
      code: "42703",
    });
    expect(await readCorrelators(config)).toEqual([]);
  });

  it("raises a permission error instead of calling it nothing to show", async () => {
    queryFault.error = Object.assign(new Error("permission denied"), {
      code: "42501",
    });
    await expect(readCorrelators(config)).rejects.toThrow("permission denied");
  });

  it("raises a failure that carries no code at all", async () => {
    queryFault.error = "connection terminated unexpectedly";
    await expect(readCorrelators(config)).rejects.toBe(
      "connection terminated unexpectedly"
    );
  });
});
