/**
 * Commit-visibility serialization (#1178).
 *
 * `id` is a serial: assigned at INSERT, visible at COMMIT. Watermark
 * consumers (claim's has-work probe, fetch's `after`, the correlate
 * checkpoint) assume id order equals visibility order, so two concurrent
 * commits to different streams surfacing out of id order can push a
 * watermark past an event that is not yet visible — permanently skipping
 * it. The append path closes the gap with a transaction-scoped advisory
 * lock: these tests prove a commit (and a truncate seed) cannot proceed
 * while another append transaction is in flight, which makes the
 * out-of-order interleaving impossible by construction.
 *
 * Requires Postgres on :5431 — same contract as every other act-pg spec.
 */
import type { EventMeta } from "@rotorsoft/act";
import { Pool, type PoolClient } from "pg";
import { PostgresStore } from "../src/index.js";

const PG = { port: 5431, schema: "visibility_test", table: "events" } as const;
const FQT = `"${PG.schema}"."${PG.table}"`;
const META: EventMeta = { correlation: "vis", causation: {} };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pg commit visibility — append serialization (#1178)", () => {
  let store: PostgresStore;
  let pool: Pool;

  beforeAll(async () => {
    store = new PostgresStore({ ...PG });
    await store.drop();
    await store.seed();
    pool = new Pool({
      host: "localhost",
      port: PG.port,
      database: "postgres",
      user: "postgres",
      password: "postgres",
    });
  });

  afterAll(async () => {
    await pool.end();
    await store.drop();
    await store.dispose();
  });

  /** Open a transaction that holds the append visibility lock. */
  async function hold_lock(): Promise<PoolClient> {
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [FQT]);
    return holder;
  }

  it("a commit waits for an in-flight append transaction to finish", async () => {
    const holder = await hold_lock();
    // The holder plays the slow transaction A: it has inserted (and been
    // assigned lower ids) but not committed yet.
    const inserted = await holder.query(
      `INSERT INTO ${FQT}(name, data, stream, version, meta)
       VALUES('Vis', '{}', 'vis-a', 0, $1) RETURNING id`,
      [META]
    );
    const a_id = Number(inserted.rows[0].id);

    let resolved = false;
    const pending = store
      .commit("vis-b", [{ name: "Vis", data: {} }], META)
      .then((c) => {
        resolved = true;
        return c;
      });

    // Pre-#1178 this commit would land immediately with id a_id + 1 and
    // become visible while a_id was still in flight — the gap. Now it
    // blocks on the visibility lock.
    await sleep(200);
    expect(resolved).toBe(false);

    await holder.query("COMMIT");
    holder.release();
    const [b] = await pending;
    // Visibility order == id order: by the time b exists, a_id is visible
    // and strictly below it.
    expect(b.id).toBeGreaterThan(a_id);
    const seen: number[] = [];
    await store.query((e) => seen.push(e.id), { after: -1 });
    expect(seen).toContain(a_id);
    expect(seen).toContain(b.id);
  });

  it("a rolled-back holder releases the lock and the commit proceeds", async () => {
    const holder = await hold_lock();
    const pending = store.commit("vis-c", [{ name: "Vis", data: {} }], META);
    await sleep(100);
    await holder.query("ROLLBACK");
    holder.release();
    const [c] = await pending;
    expect(c.stream).toBe("vis-c");
  });

  it("truncate seeds take the same visibility lock", async () => {
    await store.commit("vis-d", [{ name: "Vis", data: {} }], META);
    const holder = await hold_lock();
    let resolved = false;
    const pending = store.truncate([{ stream: "vis-d" }]).then((r) => {
      resolved = true;
      return r;
    });
    await sleep(200);
    expect(resolved).toBe(false);
    await holder.query("COMMIT");
    holder.release();
    const result = await pending;
    expect(result.get("vis-d")?.committed.name).toBe("__tombstone__");
  });
});

describe("pg commit visibility — end-to-end no-loss (#1178)", () => {
  let store: PostgresStore;
  let pool: Pool;

  beforeAll(async () => {
    store = new PostgresStore({
      port: 5431,
      schema: "visibility_e2e",
      table: "events",
    });
    await store.drop();
    await store.seed();
    pool = new Pool({
      host: "localhost",
      port: 5431,
      database: "postgres",
      user: "postgres",
      password: "postgres",
    });
  });

  afterAll(async () => {
    await pool.end();
    await store.drop();
    await store.dispose();
  });

  it("a consumer never acks past an in-flight event — nothing is lost", async () => {
    const FQ = '"visibility_e2e"."events"';
    // Slow writer A: mid-commit (lock held, id assigned, not yet visible) —
    // the faithful shape of another Act process inside PostgresStore.commit.
    const a = await pool.connect();
    await a.query("BEGIN");
    await a.query("SELECT pg_advisory_xact_lock(hashtext($1))", [FQ]);
    const ins = await a.query(
      `INSERT INTO ${FQ}(name, data, stream, version, meta)
       VALUES('Hit', '{}', 'stream-a', 0, $1) RETURNING id`,
      [META]
    );
    const a_id = Number(ins.rows[0].id);

    // Fast writer B commits to a different stream through the store.
    const pending_b = store.commit(
      "stream-b",
      [{ name: "Hit", data: {} }],
      META
    );

    // A projection-style consumer (no source filter) races the writers:
    // claim whatever is visible and ack to the highest delivered id.
    await store.subscribe([{ stream: "proj-e2e" }]);
    const delivered: number[] = [];
    const consume = async () => {
      const leases = await store.claim(5, 5, "w-e2e", 5000);
      for (const lease of leases) {
        const events: number[] = [];
        await store.query((e) => events.push(e.id), { after: lease.at });
        delivered.push(...events);
        await store.ack([{ ...lease, at: events.at(-1) ?? lease.at }]);
      }
      return leases.length;
    };
    await consume();

    // The slow writer finishes; B unblocks (post-#1178 it was waiting).
    await a.query("COMMIT");
    a.release();
    const [b] = await pending_b;

    // Drain the consumer to idle: every committed event must be delivered.
    for (let i = 0; i < 5; i++) await consume();
    expect(delivered).toContain(a_id);
    expect(delivered).toContain(b.id);
  });
});
