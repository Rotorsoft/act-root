import type { Cache, CacheEntry } from "@rotorsoft/act/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uid } from "./fixtures/helpers.js";

/**
 * One {@link Cache} implementation to feed into
 * {@link runCacheDifferentialTck}. The harness drives the identical
 * generated workload against all of them, then compares the observable
 * `get()` snapshot after every operation.
 */
export type DifferentialCache = {
  /** Display name used in assertion messages and the describe block. */
  readonly name: string;
  /**
   * Produces the cache under test. Called once in `beforeAll`; the
   * harness owns its lifecycle (`dispose`). Must return an empty cache
   * with capacity for at least {@link CacheDifferentialTckOptions.streams}
   * entries so nothing is evicted mid-comparison.
   */
  readonly factory: () => Cache | Promise<Cache>;
};

/**
 * Options for {@link runCacheDifferentialTck}.
 */
export type CacheDifferentialTckOptions = {
  /** Display name for the differential suite. */
  readonly name: string;
  /**
   * Two or more caches to drive in lockstep and compare. The first entry
   * is the reference; every other cache's observable `get()` snapshot
   * must match it exactly after every operation.
   */
  readonly caches: ReadonlyArray<DifferentialCache>;
  /**
   * Base PRNG seed. Workload `r` of {@link CacheDifferentialTckOptions.runs}
   * is built from `seed + r`, so the campaign is reproducible. Default
   * `0xcac`.
   */
  readonly seed?: number;
  /**
   * Number of distinct streams (cache keys) per workload. Kept small so a
   * bounded cache never evicts during the comparison. Default `6`.
   */
  readonly streams?: number;
  /**
   * How many independent randomized workloads to generate and compare,
   * each from a distinct seed. Default `8`.
   */
  readonly runs?: number;
};

/**
 * Deterministic 32-bit PRNG (mulberry32). Seeded, so the entire workload
 * is reproducible across runs and across the caches under comparison.
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

type Entry = CacheEntry<Record<string, unknown>>;

/** An operation in the generated, replayable cache workload. */
type CacheOp =
  | { readonly t: "set"; readonly stream: string; readonly entry: Entry }
  | { readonly t: "invalidate"; readonly stream: string }
  | { readonly t: "clear" };

/** The full generated workload, built once and replayed per cache. */
type CachePlan = {
  readonly streams: string[];
  readonly ops: CacheOp[];
};

/**
 * Build a deterministic, seeded cache workload with a randomized operation
 * sequence. Opens by `set`-ting every stream (so `get()` snapshots start
 * populated), then a seeded shuffle of `set` / `invalidate` / `clear`
 * across random streams. The same seed reproduces the same sequence.
 */
const build_cache_plan = (seed: number, stream_count: number): CachePlan => {
  const rng = mulberry32(seed);
  const prefix = `cdiff-${uid()}-`;
  const streams = Array.from(
    { length: stream_count },
    (_, i) => `${prefix}${i}`
  );

  const make_entry = (): Entry => {
    const v = Math.floor(rng() * 1000);
    return {
      state: { count: v, label: `k${v % 7}` },
      version: v,
      event_id: v,
      patches: 1 + Math.floor(rng() * 5),
      snaps: Math.floor(rng() * 3),
    };
  };
  const pick_stream = (): string => streams[Math.floor(rng() * streams.length)];

  const ops: CacheOp[] = [];
  // Opening: populate every stream so the first snapshots aren't all-empty.
  for (const stream of streams)
    ops.push({ t: "set", stream, entry: make_entry() });

  // Randomized middle: seeded set / invalidate / clear. Length varies by
  // seed so the operation count is part of the explored input space.
  const middle = 6 + Math.floor(rng() * 14);
  for (let i = 0; i < middle; i++) {
    const kind = Math.floor(rng() * 3);
    if (kind === 0)
      ops.push({ t: "set", stream: pick_stream(), entry: make_entry() });
    else if (kind === 1) ops.push({ t: "invalidate", stream: pick_stream() });
    else ops.push({ t: "clear" });
  }

  return { streams, ops };
};

/** Apply one operation to a single cache. */
const apply_op = async (cache: Cache, op: CacheOp): Promise<void> => {
  if (op.t === "set") await cache.set(op.stream, op.entry);
  else if (op.t === "invalidate") await cache.invalidate(op.stream);
  else await cache.clear();
};

/** The observable state of a cache reduced to a stream→entry map. */
const snapshot = async (
  cache: Cache,
  streams: string[]
): Promise<Record<string, Entry | undefined>> => {
  const out: Record<string, Entry | undefined> = {};
  for (const stream of streams)
    out[stream] = await cache.get<Record<string, unknown>>(stream);
  return out;
};

/**
 * Cross-implementation differential contract for the {@link Cache} port
 * (#1057).
 *
 * Where {@link runCacheTck} pins each method's contract against a single
 * implementation, this harness drives a **family of randomized, seeded
 * workloads** (`set` / `invalidate` / `clear`) against two or more caches
 * in lockstep and asserts their observable `get()` snapshot is identical
 * after **every** operation. A cache that mishandles overwrite ordering,
 * leaks an invalidated key, or clears partially diverges from the
 * reference on the exact operation that broke it — with the seed in the
 * describe block for replay.
 *
 * Streams stay within the cache's capacity, so eviction (an adapter
 * policy, not a contract guarantee) never enters the comparison.
 *
 * @example
 * ```ts
 * import { runCacheDifferentialTck } from "@rotorsoft/act-tck";
 * import { InMemoryCache } from "@rotorsoft/act";
 * import { RedisCache } from "../src/index.js";
 *
 * runCacheDifferentialTck({
 *   name: "InMemory vs Redis",
 *   caches: [
 *     { name: "InMemoryCache", factory: () => new InMemoryCache({ maxSize: 1000 }) },
 *     { name: "RedisCache", factory: () => new RedisCache({ url: process.env.REDIS_URL }) },
 *   ],
 * });
 * ```
 */
export const runCacheDifferentialTck = (
  options: CacheDifferentialTckOptions
): void => {
  describe(`TCK / Cache differential / ${options.name}`, () => {
    const base_seed = options.seed ?? 0xcac;
    const stream_count = options.streams ?? 6;
    const plans = Array.from({ length: options.runs ?? 8 }, (_, r) =>
      build_cache_plan(base_seed + r, stream_count)
    );
    const live: Array<{ name: string; cache: Cache }> = [];

    beforeAll(async () => {
      for (const spec of options.caches) {
        live.push({ name: spec.name, cache: await spec.factory() });
      }
    });

    afterAll(async () => {
      for (const { cache } of live) await cache.dispose();
    });

    plans.forEach((plan, run) => {
      const seed_hex = `0x${(base_seed + run).toString(16)}`;
      it(`agrees on get() after every op (workload ${run}, seed ${seed_hex})`, async () => {
        for (const op of plan.ops) {
          // Apply the same op to every cache, then compare snapshots — so a
          // divergence is pinned to the exact operation that introduced it.
          for (const { cache } of live) await apply_op(cache, op);
          const reference = await snapshot(live[0].cache, plan.streams);
          for (let i = 1; i < live.length; i++) {
            const actual = await snapshot(live[i].cache, plan.streams);
            expect(
              actual,
              `${live[i].name} diverged from ${live[0].name} after ${op.t}`
            ).toEqual(reference);
          }
        }
      });
    });
  });
};
