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
   * Base PRNG seed. Workload `r` of {@link StoreDifferentialTckOptions.runs}
   * is built from `seed + r`, so the whole fuzz campaign is reproducible:
   * the same `seed` ⇒ the same family of workloads ⇒ any divergence is
   * deterministically replayable. Default `0xac7`.
   */
  readonly seed?: number;
  /**
   * Number of distinct event-bearing streams per workload.
   * Default `4`.
   */
  readonly streams?: number;
  /**
   * How many independent randomized workloads to generate and compare,
   * each from a distinct seed (`seed`, `seed + 1`, …, `seed + runs - 1`).
   * More runs widen the slice of the input space the differential
   * explores; fewer keep durable-adapter suites fast. Default `8`.
   */
  readonly runs?: number;
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
 * Build a deterministic, seeded workload with a **randomized** operation
 * sequence. Unlike a fixed script, the middle of each plan is a seeded
 * shuffle of `commit` / `snapshot` / `truncate` across random streams, so
 * different seeds probe different interleavings — pre/post-snapshot
 * commits, back-to-back truncates, a snapshot landing immediately after a
 * truncate, and so on. The same seed always reproduces the same sequence,
 * so any divergence the fuzz finds is replayable.
 *
 * Two invariants are pinned regardless of seed so the comparison stays
 * well-defined across adapters:
 *
 *   - an **opening** commit per stream — every stream is non-empty before
 *     a snapshot or truncate can reference it;
 *   - a **closing** commit per stream — every stream ends with real
 *     (non-snapshot) events, so `query_stats` head/tail are defined even
 *     when a truncate was the last randomized touch.
 *
 * Event types cycle inc → dec → reset via a shared cursor, so all three
 * payload shapes appear in every plan.
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
  const pick_stream = (): string =>
    event_streams[Math.floor(rng() * event_streams.length)];

  const ops: PlanOp[] = [];
  // Opening: every stream commits a batch so it exists before any
  // snapshot/truncate references it.
  for (const stream of event_streams)
    ops.push({ t: "commit", stream, msgs: batch() });

  // Randomized middle: a seeded sequence of commits, inline snapshots, and
  // truncates against random streams. Length varies by seed (8..23) so the
  // operation count itself is part of the explored input space.
  const middle = 8 + Math.floor(rng() * 16);
  for (let i = 0; i < middle; i++) {
    const stream = pick_stream();
    const kind = Math.floor(rng() * 3);
    if (kind === 0) ops.push({ t: "commit", stream, msgs: batch() });
    else if (kind === 1)
      ops.push({ t: "snapshot", stream, count: Math.floor(rng() * 1000) });
    else ops.push({ t: "truncate", stream, count: Math.floor(rng() * 1000) });
  }

  // Closing: every stream commits a final batch so it ends with real
  // events — keeps query_stats head/tail well-defined after any truncate.
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
 * Cross-adapter differential contract (#1030, fuzz workloads #1057).
 *
 * Adapters can drift in ways per-adapter cases don't catch — event
 * ordering, the `with_snaps` snapshot floor, the exact shape of
 * `query_stats` / `query_streams` output. This harness drives a **family
 * of randomized, seeded workloads** (commits, inline snapshots, truncates,
 * subscriptions) against every store in `options.stores`, then asserts
 * their **normalized** outputs are byte-for-byte identical for every
 * workload.
 *
 * Each workload is its own seeded plan (`seed`, `seed + 1`, …): the
 * operation sequence — and even its length — varies by seed, so divergence
 * is hunted across a slice of the input space rather than one fixed script.
 * The seeds are deterministic, so a failing workload is always replayable.
 *
 * Normalization drops only the fields that legitimately differ between
 * stores (absolute event ids, `created` timestamps, correlation/causation
 * uuids) and keeps everything that defines correctness (stream, version,
 * name, data, and emission order). A one-adapter `with_snaps` regression —
 * the canonical failure mode — surfaces as a diff against the in-memory
 * reference, with the offending seed in the describe block.
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
 *   runs: 6, // durable adapter: fewer workloads keep the suite fast
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
    const base_seed = options.seed ?? 0xac7;
    const stream_count = options.streams ?? 4;
    const plans = Array.from({ length: options.runs ?? 8 }, (_, r) =>
      build_plan(base_seed + r, stream_count)
    );
    const live: Array<{ name: string; store: Store }> = [];

    beforeAll(async () => {
      for (const spec of options.stores) {
        const store = await spec.factory();
        await store.drop();
        await store.seed();
        // Each plan namespaces its streams with a unique tag, so every
        // workload coexists in one store — a single drop+seed per store
        // keeps the durable-adapter cost flat regardless of `runs`.
        for (const plan of plans) await apply_plan(store, plan);
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

    plans.forEach((plan, run) => {
      const seed_hex = `0x${(base_seed + run).toString(16)}`;
      describe(`workload ${run} (seed ${seed_hex})`, () => {
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
              // `tail: true` is requested, so every returned stream carries
              // a tail. A store that omits it is itself a divergence — let
              // the non-null access surface it loudly rather than masking it
              // with a fallback the workload can never otherwise reach.
              content[stream] = {
                head: normalize_event(s.head),
                tail: normalize_event(
                  s.tail as Committed<Schemas, keyof Schemas>
                ),
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
            // through. The differential still catches drift in how a
            // provided source/lane is stored and returned across adapters.
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
    });
  });
};
