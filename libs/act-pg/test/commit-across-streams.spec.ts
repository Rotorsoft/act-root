/**
 * A commit across streams that fails part-way stores nothing.
 *
 * Every append's rows go into one INSERT, so a failure on any append's row
 * aborts them all. These cases fail the second of two appends on a real
 * Postgres, after the head probe passed: a concurrent commit that takes
 * its version first, and a NUL byte only Postgres refuses. Each one must
 * leave the first append unstored and name the stream that failed.
 *
 * Requires Postgres on :5431 — same contract as every other act-pg spec.
 */
import {
  ConcurrencyError,
  type EventMeta,
  StoreError,
  ValidationError,
} from "@rotorsoft/act";
import type { PoolClient } from "pg";
import { PostgresStore } from "../src/index.js";
import { schema } from "./schema.js";

const PG = {
  port: 5431,
  schema: schema("commit_across_test"),
  table: "events",
} as const;
const META: EventMeta = { correlation: "across", causation: {} };
const ev = (data: Record<string, unknown> = {}) => [{ name: "E", data }];

describe("commit across streams, failing part-way", () => {
  let store: PostgresStore;
  let rival: PostgresStore;

  beforeAll(async () => {
    store = new PostgresStore({ ...PG });
    rival = new PostgresStore({ ...PG });
    await store.drop();
    await store.seed();
  });

  afterAll(async () => {
    await store.drop();
    await store.dispose();
    await rival.dispose();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Runs `before` right before the commit's INSERT, after its head probe.
  function before_insert(before: () => Promise<unknown>) {
    const checkout = (
      store as unknown as { _client: (op: string) => Promise<PoolClient> }
    )._client.bind(store);
    vi.spyOn(
      store as unknown as { _client: (op: string) => Promise<PoolClient> },
      "_client"
    ).mockImplementation(async (op) => {
      const client = await checkout(op);
      const query = client.query.bind(client) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (
        ...args: unknown[]
      ) => {
        if (String(args[0]).startsWith("WITH l AS")) await before();
        return query(...args);
      };
      return client;
    });
  }

  const stored = async (stream: string) => {
    const events: unknown[] = [];
    await store.query((e) => events.push(e), { stream });
    return events;
  };

  it("names the second stream when a concurrent commit takes its version, and stores nothing", async () => {
    before_insert(() =>
      rival.commit([{ stream: "race-second", msgs: ev() }], META)
    );
    const err = await store
      .commit(
        [
          { stream: "race-first", msgs: ev() },
          { stream: "race-second", msgs: ev() },
        ],
        META
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurrencyError);
    expect((err as ConcurrencyError).stream).toBe("race-second");
    expect(await stored("race-first")).toEqual([]);
    expect(await stored("race-second")).toHaveLength(1);
  });

  it("stores nothing when only the second append carries a NUL byte", async () => {
    const err = await store
      .commit(
        [
          { stream: "nul-first", msgs: ev() },
          { stream: "nul-second", msgs: ev({ note: "a\u0000b" }) },
        ],
        META
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(await stored("nul-first")).toEqual([]);
  });

  it("stores nothing when the connection fails at the INSERT", async () => {
    before_insert(() => Promise.reject(new Error("connection reset")));
    const err = await store
      .commit(
        [
          { stream: "drop-first", msgs: ev() },
          { stream: "drop-second", msgs: ev() },
        ],
        META
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(((err as StoreError).cause as Error).message).toBe(
      "connection reset"
    );
    vi.restoreAllMocks();
    expect(await stored("drop-first")).toEqual([]);
    expect(await stored("drop-second")).toEqual([]);
  });
});
