import { SNAP_EVENT } from "@rotorsoft/act";
import type { Committed, Schemas, Store } from "@rotorsoft/act/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CounterEvents } from "./fixtures/events.js";
import {
  type CounterMessage,
  dec,
  inc,
  make_meta,
  reset as reset_event,
  uid,
} from "./fixtures/helpers.js";

/**
 * One {@link Store} implementation to feed into
 * {@link runStoreDifferentialTck}. The harness drops + seeds each store,
 * replays the identical generated workload against all of them, then
 * compares their normalized outputs.
 */
export type DifferentialStore = {
  /** Display name used in assertion messages and the describe block. */
  readonly name: string;
  /**
   * Produces the store under test. Called once in `beforeAll`; the
   * harness owns its lifecycle (`drop` + `seed`, then `dispose`).
   */
  readonly factory: () => Store | Promise<Store>;
};

/**
 * Options for {@link runStoreDifferentialTck}.
 */
export type StoreDifferentialTckOptions = {
  /** Display name for the differential suite. */
  readonly name: string;
  /**
   * Two or more stores to drive in lockstep and compare. The first
   * entry is the reference; every other store's normalized output must
   * match it exactly. Pass `InMemoryStore` as the reference and the
   * durable adapter(s) as the comparands.
   */
  readonly stores: ReadonlyArray<DifferentialStore>;
  /**
   * PRNG seed for the generated workload. Same seed ⇒ same workload, so
   * a divergence is always reproducible. Default `0xac7`.
   */
  readonly seed?: number;
  /**
   * Number of distinct event-bearing streams in the workload.
   * Default `4`.
   */
  readonly streams?: number;
};

/**
 * Deterministic 32-bit PRNG (mulberry32). Seeded, so the entire workload
 * is reproducible across runs and across the stores under comparison.
 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A single committed event reduced to its store-independent identity. */
type NormalizedEvent = {
  readonly stream: string;
  readonly version: number;
  readonly name: string;
  readonly data: unknown;
};

/**
 * Strip the fields that legitimately differ between adapters — absolute
 * event `id`, `created` timestamp, and `meta` (correlation/causation
 * uuids) — leaving only what defines "the right events in the right
 * order": stream, version, name, and data. Event ordering is preserved
 * by the position of each normalized event in the collected array.
 */
const normalize_event = (
  e: Committed<Schemas, keyof Schemas>
): NormalizedEvent => ({
  stream: e.stream,
  version: e.version,
  name: e.name,
  data: e.data,
});

/** An operation in the generated, replayable workload. */
type PlanOp =
  | {
      readonly t: "commit";
      readonly stream: string;
      readonly msgs: CounterMessage[];
    }
  | { readonly t: "snapshot"; readonly stream: string; readonly count: number }
  | { readonly t: "truncate"; readonly stream: string; readonly count: number };

/** A subscription registered for the `query_streams` comparison. */
type SubSpec = {
  readonly stream: string;
  readonly source: string;
  readonly lane: string;
  readonly priority: number;
};

/** The full generated workload, built once and replayed per store. */
type Plan = {
  readonly event_prefix: string;
  readonly event_streams: string[];
  readonly sub_prefix: string;
  readonly ops: PlanOp[];
  readonly subs: SubSpec[];
};

/**
 * Build a deterministic, seeded workload. The structure is fixed (so the
 * snapshot floor and truncate reset are always exercised) while the event
 * payloads vary by seed. Event types cycle inc → dec → reset so all three
 * are always present regardless of seed.
 *
 * The shape per stream, interleaved across streams phase-by-phase so the
 * global event-id order mixes streams:
 *
 *   batch → inline snapshot → batch → truncate(+snapshot) → batch
 *
 * That covers pre-snapshot events, an inline snapshot floor, post-snapshot
 * events, a truncate that re-bases the floor, and post-truncate events.
 */
const build_plan = (seed: number, stream_count: number): Plan => {
  const rng = mulberry32(seed);
  const tag = uid();
  const event_prefix = `diff-${tag}-evt-`;
  const sub_prefix = `diff-${tag}-sub-`;
  const event_streams = Array.from(
    { length: stream_count },
    (_, i) => `${event_prefix}${i}`
  );

  let type_cursor = 0;
  const next_msg = (): CounterMessage => {
    const kind = type_cursor++ % 3;
    const amount = 1 + Math.floor(rng() * 9);
    return kind === 0 ? inc(amount) : kind === 1 ? dec(amount) : reset_event();
  };
  const batch = (): CounterMessage[] =>
    Array.from({ length: 1 + Math.floor(rng() * 3) }, next_msg);

  const ops: PlanOp[] = [];
  // Phase 1: every stream commits a batch.
  for (const stream of event_streams)
    ops.push({ t: "commit", stream, msgs: batch() });
  // Phase 2: every stream gets an inline snapshot.
  for (const stream of event_streams)
    ops.push({ t: "snapshot", stream, count: Math.floor(rng() * 1000) });
  // Phase 3: every stream commits another batch (after the snapshot floor).
  for (const stream of event_streams)
    ops.push({ t: "commit", stream, msgs: batch() });
  // Phase 4: every stream is truncated (re-bases the snapshot floor).
  for (const stream of event_streams)
    ops.push({ t: "truncate", stream, count: Math.floor(rng() * 1000) });
  // Phase 5: every stream commits a final batch (after the truncate floor).
  for (const stream of event_streams)
    ops.push({ t: "commit", stream, msgs: batch() });

  // Subscriptions for query_streams: each targets one event stream as its
  // source, with a rotating lane and priority. No claims are issued, so
  // every watermark stays at -1 and nothing is blocked — fully
  // deterministic regardless of adapter clocks.
  const lanes = ["default", "slow", "fast"];
  const subs: SubSpec[] = event_streams.map((source, i) => ({
    stream: `${sub_prefix}${i}`,
    source,
    lane: lanes[i % lanes.length],
    priority: i % 4,
  }));

  return { event_prefix, event_streams, sub_prefix, ops, subs };
};

/** Replay the generated workload against a single store. */
const apply_plan = async (store: Store, plan: Plan): Promise<void> => {
  for (const op of plan.ops) {
    if (op.t === "commit") {
      await store.commit<CounterEvents>(
        op.stream,
        op.msgs,
        make_meta({ stream: op.stream })
      );
    } else if (op.t === "snapshot") {
      await store.commit(
        op.stream,
        [{ name: SNAP_EVENT, data: { count: op.count } }],
        make_meta({ stream: op.stream })
      );
    } else {
      await store.truncate([
        { stream: op.stream, snapshot: { count: op.count } },
      ]);
    }
  }
  await store.subscribe(
    plan.subs.map((s) => ({
      stream: s.stream,
      source: s.source,
      lane: s.lane,
      priority: s.priority,
    }))
  );
};

/**
 * Cross-adapter differential contract (#1030).
 *
 * Adapters can drift in ways per-adapter cases don't catch — event
 * ordering, the `with_snaps` snapshot floor, the exact shape of
 * `query_stats` / `query_streams` output. This harness drives the **same**
 * deterministic, seeded workload (commits, inline snapshots, truncates,
 * subscriptions) against every store in `options.stores`, then asserts
 * their **normalized** outputs are byte-for-byte identical.
 *
 * Normalization drops only the fields that legitimately differ between
 * stores (absolute event ids, `created` timestamps, correlation/causation
 * uuids) and keeps everything that defines correctness (stream, version,
 * name, data, and emission order). A one-adapter `with_snaps` regression —
 * the canonical failure mode — surfaces as a diff against the in-memory
 * reference.
 *
 * Wire it with the in-memory store as the reference and one or more
 * durable adapters as comparands:
 *
 * @example
 * ```ts
 * import { runStoreDifferentialTck } from "@rotorsoft/act-tck";
 * import { InMemoryStore } from "@rotorsoft/act";
 * import { PostgresStore } from "../src/index.js";
 *
 * runStoreDifferentialTck({
 *   name: "InMemory vs Postgres",
 *   stores: [
 *     { name: "InMemoryStore", factory: () => new InMemoryStore() },
 *     { name: "PostgresStore", factory: () => new PostgresStore({ ... }) },
 *   ],
 * });
 * ```
 */
export const runStoreDifferentialTck = (
  options: StoreDifferentialTckOptions
): void => {
  describe(`TCK / Store differential / ${options.name}`, () => {
    const plan = build_plan(options.seed ?? 0xac7, options.streams ?? 4);
    const live: Array<{ name: string; store: Store }> = [];

    beforeAll(async () => {
      for (const spec of options.stores) {
        const store = await spec.factory();
        await store.drop();
        await store.seed();
        await apply_plan(store, plan);
        live.push({ name: spec.name, store });
      }
    });

    afterAll(async () => {
      for (const { store } of live) await store.dispose();
    });

    /**
     * Run `produce` against every store and assert each comparand's
     * result deep-equals the reference (the first store). The store name
     * rides along in the assertion message so a divergence names the
     * culprit.
     */
    const assert_identical = async <T>(
      label: string,
      produce: (store: Store) => Promise<T>
    ): Promise<void> => {
      const reference = await produce(live[0].store);
      for (let i = 1; i < live.length; i++) {
        const actual = await produce(live[i].store);
        expect(
          actual,
          `${live[i].name} diverged from ${live[0].name} on "${label}"`
        ).toEqual(reference);
      }
    };

    it("yields identical event order under a global forward query", async () => {
      await assert_identical("forward query", async (store) => {
        const out: NormalizedEvent[] = [];
        await store.query<Schemas>(
          (e) => {
            out.push(normalize_event(e));
          },
          { stream: `^${plan.event_prefix}` }
        );
        return out;
      });
    });

    it("yields identical snapshot floors under with_snaps", async () => {
      await assert_identical("with_snaps floor", async (store) => {
        const by_stream: Record<string, NormalizedEvent[]> = {};
        for (const stream of plan.event_streams) {
          const out: NormalizedEvent[] = [];
          await store.query<Schemas>(
            (e) => {
              out.push(normalize_event(e));
            },
            { stream, stream_exact: true, with_snaps: true }
          );
          by_stream[stream] = out;
        }
        return by_stream;
      });
    });

    it("yields identical order under backward traversal", async () => {
      await assert_identical("backward query", async (store) => {
        const by_stream: Record<string, NormalizedEvent[]> = {};
        for (const stream of plan.event_streams) {
          const out: NormalizedEvent[] = [];
          await store.query<Schemas>(
            (e) => {
              out.push(normalize_event(e));
            },
            { stream, stream_exact: true, backward: true }
          );
          by_stream[stream] = out;
        }
        return by_stream;
      });
    });

    it("yields identical query_stats output (head/tail/count/names)", async () => {
      await assert_identical("query_stats", async (store) => {
        const stats = await store.query_stats<Schemas>(
          { stream: `^${plan.event_prefix}` },
          { tail: true, count: true, names: true }
        );
        // Capture key order (query_stats filter form orders by stream
        // name — a contract) alongside normalized per-stream content.
        const keys = [...stats.keys()];
        const content: Record<
          string,
          {
            head: NormalizedEvent;
            tail: NormalizedEvent;
            count: number | undefined;
            names: Readonly<Record<string, number>> | undefined;
          }
        > = {};
        for (const [stream, s] of stats) {
          // `tail: true` is requested, so every returned stream carries a
          // tail. A store that omits it is itself a divergence — let the
          // non-null access surface it loudly rather than masking it with a
          // fallback the workload can never otherwise reach.
          content[stream] = {
            head: normalize_event(s.head),
            tail: normalize_event(s.tail as Committed<Schemas, keyof Schemas>),
            count: s.count,
            names: s.names as Record<string, number> | undefined,
          };
        }
        return { keys, content };
      });
    });

    it("yields identical query_streams output", async () => {
      await assert_identical("query_streams", async (store) => {
        const rows: Array<{
          stream: string;
          source: string | undefined;
          at: number;
          blocked: boolean;
          priority: number;
          lane: string | undefined;
        }> = [];
        // Every subscription in the plan carries an explicit source and
        // lane, so both are always present here — read them straight
        // through. The differential still catches drift in how a provided
        // source/lane is stored and returned across adapters.
        const { count } = await store.query_streams(
          (p) => {
            rows.push({
              stream: p.stream,
              source: p.source,
              at: p.at,
              blocked: p.blocked,
              priority: p.priority,
              lane: p.lane,
            });
          },
          { stream: `^${plan.sub_prefix}`, limit: 1000 }
        );
        // Branchless, locale-stable ordering so the comparison is
        // independent of whatever order each adapter streams rows in.
        rows.sort((a, b) => a.stream.localeCompare(b.stream));
        return { count, rows };
      });
    });
  });
};
