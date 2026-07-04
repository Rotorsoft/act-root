vi.mock("pg", () => {
  const Pool = vi.fn().mockImplementation(function (this: any) {
    return this;
  });
  Pool.prototype.query = () => {};
  Pool.prototype.end = () => {};
  Pool.prototype.connect = () => {};
  return {
    Pool,
    types: { setTypeParser: vi.fn(), builtins: { JSONB: 0 } },
    default: {
      Pool,
      types: { setTypeParser: vi.fn(), builtins: { JSONB: 0 } },
    },
  };
});

import { StoreError } from "@rotorsoft/act";
import * as pg from "pg";
import { PostgresStore } from "../src/postgres-store.js";

const pool_config = () =>
  (pg.Pool as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];

describe("pool defaults (#1119)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lands opinionated defaults on the constructed Pool config", () => {
    new PostgresStore();
    const cfg = pool_config();
    expect(cfg.max).toBe(20);
    expect(cfg.connectionTimeoutMillis).toBe(10_000);
    expect(cfg.idleTimeoutMillis).toBe(30_000);
    expect(cfg.statement_timeout).toBe(60_000);
    // Store-only fields never leak into the pool config.
    expect(cfg.schema).toBeUndefined();
    expect(cfg.table).toBeUndefined();
    expect(cfg.pii_encryption).toBeUndefined();
  });

  it("caller overrides win over every default", () => {
    new PostgresStore({
      max: 5,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 2_000,
      statement_timeout: 3_000,
    });
    const cfg = pool_config();
    expect(cfg.max).toBe(5);
    expect(cfg.connectionTimeoutMillis).toBe(1_000);
    expect(cfg.idleTimeoutMillis).toBe(2_000);
    expect(cfg.statement_timeout).toBe(3_000);
  });

  it("surfaces acquisition failure as StoreError with operation context", async () => {
    // Simulates pool exhaustion past connectionTimeoutMillis — the pg
    // driver rejects connect() with "timeout exceeded when trying to
    // connect"; the store must translate it into StoreError so the
    // operator sees which operation starved.
    vi.spyOn(pg.Pool.prototype, "connect").mockRejectedValue(
      new Error("timeout exceeded when trying to connect")
    );
    const store = new PostgresStore({ port: 5431, table: "pool_defaults" });
    const err = await store
      .commit("stream", [{ name: "E", data: {} }], {
        correlation: "c",
        causation: {},
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err.operation).toBe("commit");
    expect((err.cause as Error).message).toBe(
      "timeout exceeded when trying to connect"
    );
  });

  it("carries the calling operation for lease-pipeline methods", async () => {
    vi.spyOn(pg.Pool.prototype, "connect").mockRejectedValue(
      new Error("pool exhausted")
    );
    const store = new PostgresStore({ port: 5431, table: "pool_defaults" });
    const err = await store.claim(5, 5, "w", 10_000).catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err.operation).toBe("claim");
    // Not double-wrapped: the cause is the driver error itself.
    expect((err.cause as Error).message).toBe("pool exhausted");
  });
});
