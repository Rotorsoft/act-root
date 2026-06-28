/**
 * Concurrency-contention stress harness for the SKIP-LOCKED claim path
 * (ACT-1058).
 *
 * The competing-consumers model is the load-bearing property of the
 * concurrency design (see `docs/docs/architecture/concurrency-model.md`):
 * scale = more workers racing the same streams through
 * `claim()`/`ack()`/`block()`, each grabbing disjoint streams atomically
 * via `FOR UPDATE SKIP LOCKED`. That property was only ever asserted
 * indirectly. This spec hammers it directly against a real Postgres
 * instance and fails on a regression in the claim / lease invariants.
 *
 * Competing consumers are modelled in-process as N independent
 * `PostgresStore` instances (each with its own connection pool) pointing
 * at the same schema — the faithful production shape (one pool per Node
 * process) minus the process boundary, which `claim()` doesn't observe.
 *
 * Determinism: no wall-clock sleeps. Work runs in lockstep "rounds" —
 * every worker `claim()`s concurrently, then drains+acks what it got —
 * and the loop terminates when a round claims nothing (authoritative:
 * Postgres state, not a timer). Lease expiry is induced by forcing
 * `leased_until` into the past, never by racing a short lease.
 *
 * Requires Postgres on :5431 — provisioned by the `unit-test` CI job in
 * `.github/workflows/ci-cd.yml`. Skipped silently nowhere: when PG is
 * absent the `beforeAll` connection fails loudly, same as every other
 * act-pg spec.
 */

import { randomUUID } from "node:crypto";
import type {
  Committed,
  EventMeta,
  Lease,
  Schemas,
  StreamPosition,
} from "@rotorsoft/act";
import { Pool } from "pg";
import { PostgresStore } from "../src/index.js";

const PG = { port: 5431, schema: "contention_test", table: "events" } as const;
const META: EventMeta = { correlation: "", causation: {} };

/** Unique per-test stream prefix so the file is internally collision-free. */
const uid = (label: string) => `${label}-${randomUUID()}`;

/** Fixed-shape event batch — the Store doesn't validate against a registry. */
const batch = (n: number) =>
  Array.from({ length: n }, (_, k) => ({ name: "Inc", data: { seq: k } }));

describe("pg contention — competing consumers over SKIP LOCKED", () => {
  let control: PostgresStore;
  let pool: Pool;
  const workers: PostgresStore[] = [];

  /** Spawn a competing consumer with its own pool; tracked for cleanup. */
  const newWorker = () => {
    const w = new PostgresStore({ ...PG });
    workers.push(w);
    return w;
  };
  const makeWorkers = (n: number) =>
    Array.from({ length: n }, () => newWorker());

  beforeAll(async () => {
    control = new PostgresStore({ ...PG });
    await control.drop();
    await control.seed();
    pool = new Pool({
      host: "localhost",
      port: PG.port,
      database: "postgres",
      user: "postgres",
      password: "postgres",
    });
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.dispose()));
    await control.dispose();
    await pool.end();
  });

  /** Commit `n` events to `stream` and register it as its own source. */
  const seedStream = async (stream: string, n: number) => {
    const committed = await control.commit(stream, batch(n), META);
    await control.subscribe([{ stream, source: stream }]);
    return committed[committed.length - 1].id;
  };

  /** Read every stream position under a prefix via the introspection port. */
  const watermarks = async (prefix: string) => {
    const map = new Map<string, StreamPosition>();
    await control.query_streams((p) => map.set(p.stream, p), {
      stream: `^${prefix}`,
      limit: 1000,
    });
    return map;
  };

  /** Force a stream's lease into the past — deterministic lease expiry. */
  const expireLease = (stream: string) =>
    pool.query(
      `UPDATE "${PG.schema}"."${PG.table}_streams"
       SET leased_until = NOW() - INTERVAL '1 hour'
       WHERE stream = $1`,
      [stream]
    );

  type Delivery = { id: number; stream: string; by: string };

  /**
   * One drain step for a single worker: claim, fetch each leased stream's
   * unprocessed events, record deliveries, ack the new watermark. Returns
   * the set of streams this worker claimed in the step.
   */
  const drainStep = async (
    w: PostgresStore,
    by: string,
    deliveries: Delivery[],
    opts: { lagging: number; leading: number; leaseMillis: number }
  ): Promise<Set<string>> => {
    const leases = await w.claim(
      opts.lagging,
      opts.leading,
      by,
      opts.leaseMillis
    );
    const claimed = new Set<string>();
    for (const lease of leases) {
      claimed.add(lease.stream);
      const events: Committed<Schemas, keyof Schemas>[] = [];
      await w.query<Schemas>((e) => events.push(e), {
        stream: lease.source ?? lease.stream,
        stream_exact: true,
        after: lease.at,
        limit: 1000,
      });
      for (const e of events)
        deliveries.push({ id: e.id, stream: e.stream, by });
      const at = events.length ? events[events.length - 1].id : lease.at;
      await w.ack([{ ...lease, at }]);
    }
    return claimed;
  };

  it("delivers every event exactly once under N competing consumers", async () => {
    const prefix = uid("c1");
    const S = 24;
    const E = 8;
    const N = 6;
    const streams = Array.from({ length: S }, (_, i) => `${prefix}-s${i}`);
    const lastId = new Map<string, number>();
    for (const s of streams) lastId.set(s, await seedStream(s, E));

    const fleet = makeWorkers(N);
    const deliveries: Delivery[] = [];

    // Lockstep rounds: all workers claim concurrently, then drain+ack.
    let rounds = 0;
    for (; rounds < S * E + 10; rounds++) {
      const perWorker = await Promise.all(
        fleet.map((w, i) =>
          drainStep(w, `c1-w${i}`, deliveries, {
            lagging: 4,
            leading: 4,
            leaseMillis: 30_000,
          })
        )
      );
      // Mutual exclusion: no stream is held by two workers in one round.
      const claimedAcrossFleet = perWorker.flatMap((s) => [...s]);
      expect(new Set(claimedAcrossFleet).size).toBe(claimedAcrossFleet.length);
      if (perWorker.every((s) => s.size === 0)) break;
    }
    expect(rounds).toBeLessThan(S * E + 10); // terminated by drain, not the cap

    // At-least-once AND no double delivery → exactly-once with healthy leases.
    const ids = deliveries.map((d) => d.id).sort((a, b) => a - b);
    const committedIds = [...lastId.values()]
      .flatMap((last) =>
        Array.from({ length: E }, (_, k) => last - (E - 1) + k)
      )
      .sort((a, b) => a - b);
    expect(ids).toEqual(committedIds);
    expect(new Set(ids).size).toBe(S * E); // no duplicates

    // No lost / over-advanced watermark: every stream sits exactly at its head.
    const wm = await watermarks(prefix);
    for (const s of streams) expect(wm.get(s)?.at).toBe(lastId.get(s));
  });

  it("re-claims after induced lease expiry without losing or regressing the watermark", async () => {
    const prefix = uid("c2");
    const stream = `${prefix}-s`;
    const committed = await control.commit(stream, batch(5), META);
    await control.subscribe([{ stream, source: stream }]);
    const lastId = committed[committed.length - 1].id;

    const A = newWorker();
    const B = newWorker();

    // A claims the only claimable stream and holds a long lease.
    const aLeases = await A.claim(4, 4, "c2-A", 30_000);
    const aLease = aLeases.find((l) => l.stream === stream);
    expect(aLease).toBeDefined();
    expect(aLease?.at).toBe(-1);

    // While A holds the lease, B cannot claim the same stream.
    const bDenied = await B.claim(4, 4, "c2-B", 30_000);
    expect(bDenied.map((l) => l.stream)).not.toContain(stream);

    // Induce lease expiry, then B re-claims from the same watermark.
    await expireLease(stream);
    const bLeases = await B.claim(4, 4, "c2-B", 30_000);
    const bLease = bLeases.find((l) => l.stream === stream);
    expect(bLease).toBeDefined();
    expect(bLease?.at).toBe(-1); // no progress was lost on hand-off

    // B delivers the full stream at-least-once and advances the watermark.
    const events: Committed<Schemas, keyof Schemas>[] = [];
    await B.query<Schemas>((e) => events.push(e), {
      stream,
      stream_exact: true,
      after: bLease?.at,
      limit: 100,
    });
    expect(events.map((e) => e.id)).toEqual(committed.map((c) => c.id));
    await B.ack([{ ...(bLease as Lease), at: lastId }]);

    // The evicted holder's stale ack must be a no-op — it no longer owns the
    // lease, so it cannot regress the watermark a competitor advanced.
    const aStaleAck = await A.ack([
      { ...(aLease as Lease), at: committed[1].id },
    ]);
    expect(aStaleAck).toHaveLength(0);

    const wm = await watermarks(prefix);
    expect(wm.get(stream)?.at).toBe(lastId); // advanced once, never regressed

    const drained = await B.claim(4, 4, "c2-B", 30_000);
    expect(drained.map((l) => l.stream)).not.toContain(stream);
  });

  it("blocks a poison stream on induced fault and keeps healthy streams flowing", async () => {
    const prefix = uid("c3");
    const poison = `${prefix}-poison`;

    // Commit the poison stream alone so the first claim is deterministic.
    await seedStream(poison, 4);

    const A = newWorker();
    const B = newWorker();
    const aLeases = await A.claim(4, 4, "c3-A", 30_000);
    const poisonLease = aLeases.find((l) => l.stream === poison);
    expect(poisonLease).toBeDefined();

    // Mutual exclusion on block: a non-holder cannot block A's lease.
    const bBlock = await B.block([
      { ...(poisonLease as Lease), by: "c3-B", error: "not the holder" },
    ]);
    expect(bBlock).toHaveLength(0);
    expect((await watermarks(prefix)).get(poison)?.blocked).toBe(false);

    // The lease holder blocks it on an induced handler fault.
    const aBlock = await A.block([
      { ...(poisonLease as Lease), error: "induced handler fault" },
    ]);
    expect(aBlock).toHaveLength(1);

    // A blocked stream is excluded from subsequent claims.
    const reclaim = await A.claim(4, 4, "c3-A", 30_000);
    expect(reclaim.map((l) => l.stream)).not.toContain(poison);

    // Healthy streams committed afterwards must still drain exactly-once
    // under N competing workers while the poison stream stays quarantined.
    const healthy = Array.from({ length: 6 }, (_, i) => `${prefix}-h${i}`);
    const lastId = new Map<string, number>();
    for (const s of healthy) lastId.set(s, await seedStream(s, 4));

    const fleet = makeWorkers(4);
    const deliveries: Delivery[] = [];
    let rounds = 0;
    for (; rounds < 200; rounds++) {
      const perWorker = await Promise.all(
        fleet.map((w, i) =>
          drainStep(w, `c3-w${i}`, deliveries, {
            lagging: 4,
            leading: 4,
            leaseMillis: 30_000,
          })
        )
      );
      const claimedAcrossFleet = perWorker.flatMap((s) => [...s]);
      expect(new Set(claimedAcrossFleet).size).toBe(claimedAcrossFleet.length);
      expect(claimedAcrossFleet).not.toContain(poison); // never re-served
      if (perWorker.every((s) => s.size === 0)) break;
    }
    expect(rounds).toBeLessThan(200);

    // Healthy streams: exactly-once delivery, watermark at head.
    expect(deliveries.some((d) => d.stream === poison)).toBe(false);
    const wm = await watermarks(prefix);
    for (const s of healthy) expect(wm.get(s)?.at).toBe(lastId.get(s));

    // Poison stayed blocked and never advanced.
    expect(wm.get(poison)?.blocked).toBe(true);
    expect(wm.get(poison)?.at).toBe(-1);
    expect(wm.get(poison)?.error).toBe("induced handler fault");
  });
});
