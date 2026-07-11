import { SNAP_EVENT } from "@rotorsoft/act";
import type {
  BlockedLease,
  Committed,
  Lease,
  Schemas,
  Store,
} from "@rotorsoft/act/types";
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
 * Known cross-adapter divergences the caller wants the differential to
 * skip until the backing fix lands. Each flag suppresses exactly the
 * assertions that a currently-filed bug makes red, so the differential
 * stays green on master and the gate un-gates itself (delete the flag)
 * when the fix merges. Every flag names its issue so the reason is
 * auditable at the call site.
 */
export type DifferentialSkips = {
  /**
   * #1197 — SQLite `LIKE` is ASCII-case-insensitive, so a **mixed-case
   * regex pattern** filter overmatches vs PG (`~`) / InMemory (`RegExp`),
   * which are case-sensitive. Skips only the pattern-driven mixed-case
   * assertions; exact-match (`stream_exact`) mixed-case still runs, since
   * that path is case-exact on every adapter. Un-gate when #1197 lands.
   */
  readonly caseInsensitivePatterns?: boolean;
  /**
   * #1199 — `names: []` and falsy-zero `before`/`after: 0` guards differ
   * across adapters (`names: []` → PG returns all, InMemory/SQLite return
   * none; `before: 0` / `after: 0` are dropped by some adapters' truthy
   * guards). Skips only those specific edge-input query assertions.
   * Un-gate when #1199 lands.
   */
  readonly queryEdgeInputs?: boolean;
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
  /**
   * Whether the comparand adapters support the optional {@link Store.forget_pii}
   * surface (and the `pii` field on commit). When `true`, the workload
   * commits PII-bearing events and the differential asserts that
   * `forget_pii` wipes them identically across adapters. All in-tree
   * adapters implement it, so it defaults to `true`; a third-party store
   * that opts out sets it `false`. Default `true`.
   */
  readonly piiIsolation?: boolean;
  /**
   * Known-divergence gates — see {@link DifferentialSkips}. Each flag
   * suppresses the assertions a currently-filed bug makes red so the
   * differential stays green until the fix merges. Default: nothing
   * skipped.
   */
  readonly skip?: DifferentialSkips;
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
  /** `true` when the event carried PII on load, `false`/absent otherwise. */
  readonly pii?: boolean;
};

/**
 * Strip the fields that legitimately differ between adapters — absolute
 * event `id`, `created` timestamp, and `meta` (correlation/causation
 * uuids) — leaving only what defines "the right events in the right
 * order": stream, version, name, data, and whether PII was present. Event
 * ordering is preserved by the position of each normalized event in the
 * collected array.
 *
 * PII is normalized to a boolean presence flag rather than its plaintext:
 * the differential's job is "did `forget_pii` erase the same rows on every
 * adapter", not "does every adapter round-trip the same ciphertext" (which
 * the per-adapter `pii_isolation` suite already pins).
 */
const normalize_event = (
  e: Committed<Schemas, keyof Schemas>
): NormalizedEvent => ({
  stream: e.stream,
  version: e.version,
  name: e.name,
  data: e.data,
  pii: e.pii != null,
});

/**
 * Identity-only view (no PII flag). `query_stats` head/tail is a
 * stream-shape summary — whether an adapter hydrates the isolated PII
 * column on the head/tail rows it returns is not part of that contract
 * (the per-adapter `pii_isolation` suite pins hydration on `query` /
 * `commit`, not on `query_stats`). Comparing PII presence here would
 * over-specify and flag a legitimate adapter freedom as a divergence.
 */
const normalize_identity = (
  e: Committed<Schemas, keyof Schemas>
): Omit<NormalizedEvent, "pii"> => ({
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
      /** When set, the batch's first message carries this PII payload. */
      readonly pii?: Record<string, unknown>;
    }
  | { readonly t: "snapshot"; readonly stream: string; readonly count: number }
  | { readonly t: "truncate"; readonly stream: string; readonly count: number }
  // Windowed truncate: prefix-delete below the closest safe boundary
  // snapshot with `created < before` (and `id <= max_id` when set). The
  // op writes a snapshot first (in `apply_plan`) so a boundary always
  // exists, making the prune deterministic across adapters.
  | {
      readonly t: "truncate_windowed";
      readonly stream: string;
      readonly max_id: boolean;
    }
  // Lease lifecycle against a subscription stream (indexed into
  // `plan.subs`). `claim` leases every claimable stream under a fresh
  // holder; `apply_plan` records which holder now owns each stream so the
  // finalize verbs (`ack` / `defer` / `block`) target the *real* current
  // holder on each adapter. That makes the durable outcome (watermark,
  // retry, blocked, error, deferred) a deterministic function of the op
  // sequence — independent of the exact holder UUID (normalized away) and
  // of any adapter's claim-frontier tie-break. A verb whose target stream
  // is not currently held is a no-op on every adapter, identically.
  | { readonly t: "claim"; readonly millis: number }
  | { readonly t: "ack"; readonly sub: number }
  | { readonly t: "defer"; readonly sub: number; readonly due: number }
  | { readonly t: "block"; readonly sub: number; readonly error: string }
  | { readonly t: "unblock"; readonly sub: number }
  | { readonly t: "reset_sub"; readonly sub: number }
  | {
      readonly t: "prioritize";
      readonly sub: number;
      readonly priority: number;
    };

/** A subscription registered for the `query_streams` comparison. */
type SubSpec = {
  readonly stream: string;
  readonly source: string;
  readonly lane: string;
  readonly priority: number;
};

/** A query-option matrix entry compared under a global forward scan. */
type QueryCase = {
  readonly label: string;
  readonly query: Record<string, unknown>;
  /**
   * When set, this case is only well-defined once the named fix lands;
   * the harness skips it while the matching {@link DifferentialSkips}
   * flag is on.
   */
  readonly gated?: keyof DifferentialSkips;
};

/** The full generated workload, built once and replayed per store. */
type Plan = {
  readonly event_prefix: string;
  readonly event_streams: string[];
  readonly sub_prefix: string;
  readonly ops: PlanOp[];
  readonly subs: SubSpec[];
  readonly correlation: string;
  readonly pii_stream: string;
  readonly query_cases: QueryCase[];
  /** The single event name guaranteed to appear (for `names` filters). */
  readonly filter_name: string;
};

/**
 * Build a deterministic, seeded workload with a **randomized** operation
 * sequence. Unlike a fixed script, the middle of each plan is a seeded
 * shuffle of `commit` / `snapshot` / `truncate` (full + windowed) plus the
 * **lease lifecycle** (`claim` / `ack` / `defer` / `block` / `unblock` /
 * `reset` / `prioritize`) across random streams, so different seeds probe
 * different interleavings — pre/post-snapshot commits, a claim landing
 * between two truncates, a block-then-unblock, and so on. The same seed
 * always reproduces the same sequence, so any divergence the fuzz finds is
 * replayable.
 *
 * Stream names carry **mixed case** so a case-sensitivity divergence in a
 * pattern filter surfaces as a diff (the whole point of #1197's coverage).
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
const build_plan = (
  seed: number,
  stream_count: number,
  pii_isolation: boolean
): Plan => {
  const rng = mulberry32(seed);
  const tag = uid();
  // Mixed-case prefixes: an upper-cased segment lands inside every stream
  // and subscription name, so a case-insensitive pattern filter (SQLite
  // LIKE, #1197) overmatches and diverges from the case-sensitive
  // reference. A lower-only corpus can never surface that class of bug.
  const event_prefix = `Diff-${tag}-Evt-`;
  const sub_prefix = `Diff-${tag}-Sub-`;
  const event_streams = Array.from(
    { length: stream_count },
    (_, i) => `${event_prefix}S${i}`
  );
  const correlation = `corr-${tag}`;

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
  // Each subscription consumes from its **own dedicated source stream**
  // that only ever receives a single opening commit and is never truncated.
  // Decoupling the lease sources from the truncate-churned `event_streams`
  // is what makes `claim` eligibility identical across adapters: every
  // subscription has exactly one unit of work at watermark -1, so a wide-
  // budget claim leases the same set on every store — the lease-lifecycle
  // diff then reflects only the ack/block/unblock/reset ops, not adapter
  // differences in "does this source still have events after a truncate".
  const lanes = ["default", "slow", "fast"];
  const lease_prefix = `Diff-${tag}-Src-`;
  const lease_sources = event_streams.map((_, i) => `${lease_prefix}S${i}`);
  const subs: SubSpec[] = lease_sources.map((source, i) => ({
    stream: `${sub_prefix}S${i}`,
    source,
    lane: lanes[i % lanes.length],
    priority: i % 4,
  }));
  const pick_sub = (): number => Math.floor(rng() * subs.length);

  const ops: PlanOp[] = [];
  // Opening: every stream commits a batch so it exists before any
  // snapshot/truncate references it. The first stream's opening batch
  // carries PII (when the adapter supports it) so `forget_pii` has
  // something to erase.
  const pii_stream = event_streams[0];
  event_streams.forEach((stream, i) => {
    ops.push({
      t: "commit",
      stream,
      msgs: batch(),
      pii:
        pii_isolation && i === 0
          ? { email: `u-${tag}@example.com`, name: "Ursula" }
          : undefined,
    });
  });
  // One commit per lease source so every subscription starts with exactly
  // one unit of work at watermark -1. These streams are never truncated.
  for (const src of lease_sources)
    ops.push({ t: "commit", stream: src, msgs: [inc(1)] });

  // Register every subscription up front so the lease-lifecycle ops in the
  // middle have claimable streams. A fresh subscription's watermark is -1.
  // (Applied via `subscribe` before the ops loop in `apply_plan`.)

  // Randomized middle: a seeded sequence over the full op vocabulary.
  const middle = 12 + Math.floor(rng() * 20);
  for (let i = 0; i < middle; i++) {
    const kind = Math.floor(rng() * 10);
    if (kind === 0) {
      ops.push({ t: "commit", stream: pick_stream(), msgs: batch() });
    } else if (kind === 1) {
      ops.push({
        t: "snapshot",
        stream: pick_stream(),
        count: Math.floor(rng() * 1000),
      });
    } else if (kind === 2) {
      ops.push({
        t: "truncate",
        stream: pick_stream(),
        count: Math.floor(rng() * 1000),
      });
    } else if (kind === 3) {
      ops.push({
        t: "truncate_windowed",
        stream: pick_stream(),
        max_id: rng() < 0.5,
      });
    } else if (kind === 4) {
      // Large lease window so the claim holds; retry counters advance
      // deterministically (claim increments, ack resets).
      ops.push({ t: "claim", millis: 100_000 });
    } else if (kind === 5) {
      ops.push({ t: "ack", sub: pick_sub() });
    } else if (kind === 6) {
      // Deterministic due-time relative to a fixed epoch so `deferred_at`
      // is identical on every adapter. Far in the future so the deferred
      // stream stays held-out.
      ops.push({
        t: "defer",
        sub: pick_sub(),
        due: 4_102_444_800_000 + Math.floor(rng() * 1000),
      });
    } else if (kind === 7) {
      ops.push({
        t: "block",
        sub: pick_sub(),
        error: `boom-${Math.floor(rng() * 100)}`,
      });
    } else if (kind === 8) {
      ops.push({ t: "unblock", sub: pick_sub() });
    } else {
      // reset / prioritize share the last bucket via a sub-toss.
      if (rng() < 0.5) ops.push({ t: "reset_sub", sub: pick_sub() });
      else
        ops.push({
          t: "prioritize",
          sub: pick_sub(),
          priority: Math.floor(rng() * 10),
        });
    }
  }

  // Closing: every stream commits a final batch so it ends with real
  // events — keeps query_stats head/tail well-defined after any truncate.
  const filter_name = "Incremented";
  for (const stream of event_streams)
    ops.push({ t: "commit", stream, msgs: [inc(1)] });

  // Query-option matrix compared under a global forward/backward scan.
  // Each case exercises a distinct filter dimension; the normalized event
  // list must match across adapters. Edge-input cases (`names: []`,
  // falsy-zero bounds) are gated behind #1199 until the guards converge.
  const query_cases: QueryCase[] = [
    {
      label: "names filter (single event name)",
      query: { stream: `^${event_prefix}`, names: [filter_name] },
    },
    {
      label: "correlation filter",
      query: { stream: `^${event_prefix}`, correlation },
    },
    {
      label: "limit bound",
      query: { stream: `^${event_prefix}`, limit: 3 },
    },
    {
      label: "backward + limit",
      query: { stream: `^${event_prefix}`, backward: true, limit: 4 },
    },
    // Absolute `id` bounds (`after`/`before` with positive ids) are
    // deliberately absent: event ids are the canonical "legitimately
    // differs between adapters" field (see `normalize_event`), and full
    // truncates renumber them differently per store, so a positive id
    // bound selects a different absolute window on each adapter. The
    // gated falsy-zero cases below compare only the *guard* behavior
    // (filter applied → subset, vs filter dropped → all), which stays a
    // well-defined divergence regardless of the concrete id values.
    // #1199 edge inputs — opposite semantics across adapters today.
    {
      label: "empty names filter",
      query: { stream: `^${event_prefix}`, names: [] as string[] },
      gated: "queryEdgeInputs",
    },
    {
      label: "before: 0 (falsy-zero guard)",
      query: { stream: `^${event_prefix}`, before: 0 },
      gated: "queryEdgeInputs",
    },
    {
      label: "backward + after: 0 (falsy-zero guard)",
      query: { stream: `^${event_prefix}`, backward: true, after: 0 },
      gated: "queryEdgeInputs",
    },
  ];

  return {
    event_prefix,
    event_streams,
    sub_prefix,
    ops,
    subs,
    correlation,
    pii_stream,
    query_cases,
    filter_name,
  };
};

/** Replay the generated workload against a single store. */
const apply_plan = async (
  store: Store,
  plan: Plan,
  pii_isolation: boolean
): Promise<void> => {
  // Register subscriptions first so the lease-lifecycle ops have targets.
  await store.subscribe(
    plan.subs.map((s) => ({
      stream: s.stream,
      source: s.source,
      lane: s.lane,
      priority: s.priority,
    }))
  );

  // Adapter-local map of the lease holder currently owning each of *this
  // plan's* subscription streams, kept in sync from `claim` results. The
  // finalize verbs read the real current holder so their durable effect is
  // a deterministic function of the op sequence — the holder UUID itself is
  // an adapter detail (normalized away in the assertions). A verb whose
  // target isn't held is skipped, exactly as an unheld `ack`/`block` would
  // no-op inside the adapter.
  const held = new Map<string, string>();
  const owned = new Set(plan.subs.map((s) => s.stream));

  for (const op of plan.ops) {
    if (op.t === "commit") {
      const msgs =
        op.pii && pii_isolation
          ? op.msgs.map((m, i) => (i === 0 ? { ...m, pii: op.pii } : m))
          : op.msgs;
      await store.commit<CounterEvents>(
        op.stream,
        msgs as CounterMessage[],
        make_meta({ stream: op.stream, correlation: plan.correlation })
      );
    } else if (op.t === "snapshot") {
      await store.commit(
        op.stream,
        [{ name: SNAP_EVENT, data: { count: op.count } }],
        make_meta({ stream: op.stream, correlation: plan.correlation })
      );
    } else if (op.t === "truncate") {
      await store.truncate([
        { stream: op.stream, snapshot: { count: op.count } },
      ]);
    } else if (op.t === "truncate_windowed") {
      // Write a boundary snapshot, then prefix-delete below it. `before`
      // sits just after the snapshot's commit time; `max_id` (when set) is
      // wide so it never excludes the boundary. Deterministic across
      // adapters: the boundary is a real event the workload wrote.
      await store.commit(
        op.stream,
        [{ name: SNAP_EVENT, data: { count: 1 } }],
        make_meta({ stream: op.stream, correlation: plan.correlation })
      );
      await store.truncate([
        {
          stream: op.stream,
          before: new Date(Date.now() + 60_000),
          // A wide cap that still fits a 32-bit event-id column, so it
          // never excludes the boundary snapshot on any adapter.
          ...(op.max_id ? { max_id: 2_147_483_647 } : {}),
        },
      ]);
    } else if (op.t === "claim") {
      // Budget wide enough to lease every claimable stream in one call, so
      // *which* streams get leased never depends on an adapter's frontier
      // tie-break order — every unleased, unblocked, non-deferred stream is
      // claimed under a fresh holder. Record the new holder for this plan's
      // streams; the finalize verbs read it back.
      const by = uid();
      const leased = await store.claim(100_000, 100_000, by, op.millis);
      for (const l of leased) if (owned.has(l.stream)) held.set(l.stream, by);
    } else if (op.t === "ack") {
      const stream = plan.subs[op.sub].stream;
      const by = held.get(stream);
      if (by) {
        // Advance the watermark to 0 (the opening event) and release.
        await store.ack([{ stream, at: 0, by, retry: 0, lagging: true }]);
        held.delete(stream);
      }
    } else if (op.t === "defer") {
      const stream = plan.subs[op.sub].stream;
      const by = held.get(stream);
      if (by) {
        const lease: Lease = {
          stream,
          at: 0,
          by,
          retry: 0,
          lagging: true,
          due: op.due,
        };
        await store.ack([lease]);
        held.delete(stream);
      }
    } else if (op.t === "block") {
      const stream = plan.subs[op.sub].stream;
      const by = held.get(stream);
      if (by) {
        const lease: BlockedLease = {
          stream,
          at: 0,
          by,
          retry: 0,
          lagging: true,
          error: op.error,
        };
        await store.block([lease]);
        held.delete(stream);
      }
    } else if (op.t === "unblock") {
      const stream = plan.subs[op.sub].stream;
      await store.unblock([stream]);
      held.delete(stream);
    } else if (op.t === "reset_sub") {
      const stream = plan.subs[op.sub].stream;
      await store.reset([stream]);
      held.delete(stream);
    } else {
      await store.prioritize(
        { stream: plan.subs[op.sub].stream, stream_exact: true },
        op.priority
      );
    }
  }
};

/**
 * Cross-adapter differential contract (#1030, fuzz workloads #1057,
 * lease/truncate/pii/query fuzz #1200).
 *
 * Adapters can drift in ways per-adapter cases don't catch — event
 * ordering, the `with_snaps` snapshot floor, the exact shape of
 * `query_stats` / `query_streams` output, the lease lifecycle's effect on
 * a stream's `retry`/`blocked`/`error`, windowed-truncate boundaries,
 * `forget_pii` erasure, and query-option edge cases. This harness drives a
 * **family of randomized, seeded workloads** — commits (some PII-bearing),
 * inline + windowed truncates, subscriptions, and the full lease lifecycle
 * (`claim` / `ack` / `defer` / `block` / `unblock` / `reset` /
 * `prioritize`) — against every store in `options.stores`, then asserts
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
 * uuids, lease holder UUIDs, and wall-clock lease expiries) and keeps
 * everything that defines correctness (stream, version, name, data,
 * emission order, and the durable subscription state a lease op leaves
 * behind: watermark, retry, blocked, error, priority, lane). Stream names
 * carry mixed case so a case-insensitive pattern filter (#1197) surfaces as
 * a diff.
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
    const pii_isolation = options.piiIsolation ?? true;
    // Spread-merge (not `?? {}`) so an absent `skip` carries no branch: the
    // spread of `undefined` yields `{}` with nothing for coverage to owe —
    // mirrors `store-tck.ts`'s `{ ...options.capabilities }`.
    const skip: DifferentialSkips = { ...options.skip };
    const plans = Array.from({ length: options.runs ?? 8 }, (_, r) =>
      build_plan(base_seed + r, stream_count, pii_isolation)
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
        for (const plan of plans) await apply_plan(store, plan, pii_isolation);
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

        // Query-option matrix (#1200): each filter dimension must select
        // the same normalized events on every adapter. Gated edge-input
        // cases (#1199) are skipped while the matching flag is on.
        plan.query_cases.forEach((qc) => {
          const gated = qc.gated && skip[qc.gated];
          it.skipIf(gated)(
            `yields identical events under ${qc.label}`,
            async () => {
              await assert_identical(`query / ${qc.label}`, async (store) => {
                const out: NormalizedEvent[] = [];
                await store.query<Schemas>((e) => {
                  out.push(normalize_event(e));
                }, qc.query);
                return out;
              });
            }
          );
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
                head: Omit<NormalizedEvent, "pii">;
                tail: Omit<NormalizedEvent, "pii">;
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
                head: normalize_identity(s.head),
                tail: normalize_identity(
                  s.tail as Committed<Schemas, keyof Schemas>
                ),
                count: s.count,
                names: s.names as Record<string, number> | undefined,
              };
            }
            return { keys, content };
          });
        });

        it("yields identical query_streams output (incl. lease-lifecycle state)", async () => {
          await assert_identical("query_streams", async (store) => {
            const rows: Array<{
              stream: string;
              source: string | undefined;
              at: number;
              blocked: boolean;
              priority: number;
              lane: string | undefined;
              retry: number;
              error: string;
              // Lease holder UUID + expiry are non-portable; normalize to
              // a presence flag so "is this stream currently leased" is
              // compared without depending on the exact holder/clock.
              leased: boolean;
            }> = [];
            const { count } = await store.query_streams(
              (p) => {
                rows.push({
                  stream: p.stream,
                  source: p.source,
                  at: p.at,
                  blocked: p.blocked,
                  priority: p.priority,
                  lane: p.lane,
                  retry: p.retry,
                  error: p.error,
                  leased: p.leased_by != null,
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

        // Case-sensitivity of the pattern filter (#1197): the subscription
        // streams are mixed-case (`Diff-…-Sub-S{i}`); filtering with the
        // **lower-cased** form of the same pattern must select the *same*
        // set on every adapter. On case-sensitive engines (PG `~`, InMemory
        // `RegExp`) that set is empty — the case doesn't match. SQLite's
        // ASCII-case-insensitive `LIKE` overmatches and returns the whole
        // family, so the differential goes red until #1197 flips it to a
        // case-sensitive matcher. Gated behind `caseInsensitivePatterns`.
        it.skipIf(skip.caseInsensitivePatterns)(
          "matches case-sensitively under a lower-cased pattern filter",
          async () => {
            await assert_identical(
              "query_streams lower-cased pattern",
              async (store) => {
                const collect_streams = async (
                  pattern: string
                ): Promise<string[]> => {
                  const streams: string[] = [];
                  await store.query_streams(
                    (p) => {
                      streams.push(p.stream);
                    },
                    { stream: pattern, limit: 1000 }
                  );
                  streams.sort((a, b) => a.localeCompare(b));
                  return streams;
                };
                // Correctly-cased control: returns the whole sub family on
                // every adapter (exercises the match path). Lower-cased
                // discriminator: empty on a case-sensitive matcher,
                // overmatched to the full family on SQLite's LIKE. Both
                // ride in the compared payload so the control proves the
                // corpus is matchable while the discriminator surfaces
                // #1197.
                const matched = await collect_streams(`^${plan.sub_prefix}S`);
                const lowered = await collect_streams(
                  `^${plan.sub_prefix.toLowerCase()}s`
                );
                return { matched, lowered };
              }
            );
          }
        );

        // Exact-match mixed-case: case-exact on every adapter, so it runs
        // unconditionally — the control that proves the mixed-case corpus
        // itself round-trips even where the pattern path is gated.
        it("yields identical events under an exact mixed-case stream lookup", async () => {
          await assert_identical("query exact mixed-case", async (store) => {
            const out: NormalizedEvent[] = [];
            await store.query<Schemas>(
              (e) => {
                out.push(normalize_event(e));
              },
              { stream: plan.event_streams[0], stream_exact: true }
            );
            return out;
          });
        });

        // forget_pii erasure (#1200): wipe PII on the seeded stream and
        // assert every adapter reports the same erased-count and that the
        // reload shows PII gone identically. Only runs when the adapters
        // implement the optional surface.
        it.skipIf(!pii_isolation)(
          "erases pii identically via forget_pii",
          async () => {
            await assert_identical("forget_pii erase", async (store) => {
              // forget_pii is capability-gated on the port; the caller
              // declared support via `piiIsolation`, so it is present.
              // Call it as a method (not a detached reference) so adapters
              // that read `this` keep their binding.
              const erased = await store.forget_pii!(plan.pii_stream);
              const after: NormalizedEvent[] = [];
              await store.query<Schemas>(
                (e) => {
                  after.push(normalize_event(e));
                },
                { stream: plan.pii_stream, stream_exact: true }
              );
              return { erased, after };
            });
          }
        );
      });
    });
  });
};
