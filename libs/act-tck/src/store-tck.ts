import {
  ConcurrencyError,
  SNAP_EVENT,
  TOMBSTONE_EVENT,
  validateRestoreRow,
} from "@rotorsoft/act";
import type {
  BlockedLease,
  Committed,
  Lease,
  RestoreRow,
  Store,
  StoreNotification,
} from "@rotorsoft/act/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CounterEvents } from "./fixtures/events.js";
import {
  type CommittedCounterEvent,
  collect,
  dec,
  inc,
  makeMeta,
  reset as resetEvent,
  seedStream,
  uid,
} from "./fixtures/helpers.js";

/**
 * Optional features a {@link Store} implementation may or may not
 * support. Default to `false` — only enable a flag when the adapter
 * exposes the corresponding surface and you want the TCK to cover it.
 */
export type StoreCapabilities = {
  /**
   * Adapter implements {@link Store.notify}. When `true`, the TCK runs
   * a basic subscribe/dispose smoke test. Cross-process LISTEN/NOTIFY
   * semantics are not exercised — that needs two processes and stays
   * in the adapter's own suite.
   */
  readonly notify?: boolean;
  /**
   * Adapter implements {@link Store.restore}. When `true`, the TCK
   * runs the full restore suite — empty-source / single-stream /
   * multi-stream happy paths, ISO-string `created`, pre-existing
   * wipe, subscription clearing, causation remap, and atomic
   * rollback on mid-iteration throw.
   */
  readonly restore?: boolean;
};

/**
 * Options for {@link runStoreTck}.
 */
export type StoreTckOptions = {
  /**
   * Display name for the implementation under test.
   */
  readonly name: string;
  /**
   * Returns the {@link Store} instance under test. Called once during
   * `beforeAll`. The TCK does not assume a fresh store per test — each
   * test namespaces its streams via {@link uid} so they don't collide.
   * The TCK calls `store.seed()` once before any test runs and
   * `store.dispose()` after all tests, with `store.drop()` in between
   * if any test needs it.
   */
  readonly factory: () => Store | Promise<Store>;
  /**
   * Optional capabilities flags — see {@link StoreCapabilities}.
   */
  readonly capabilities?: StoreCapabilities;
};

/**
 * Runs the Store contract test compatibility kit against the
 * implementation produced by `options.factory`.
 *
 * The TCK is the executable definition of the {@link Store} contract.
 * Every method on the interface in `libs/act/src/types/ports.ts` has
 * matching cases here:
 *
 * - `commit` — single + multi-event commits, optimistic concurrency
 * - `query` — stream, names, correlation, before, after, created_after,
 *   created_before, limit, with_snaps, stream_exact, backward traversal
 * - `subscribe` — idempotent re-subscribe, watermark return value
 * - `claim` / `ack` — lease lifecycle, dual frontiers, leased streams
 *   not double-claimed
 * - `block` — blocked streams hidden from claim, only same-drainer can block
 * - `reset` — restart watermarks (including blocked), no-op for missing
 * - `prioritize` — bulk priority updates by filter
 * - `truncate` — snapshot vs tombstone seeding, empty inputs, missing streams
 * - `query_streams` — filters, exact-match, pagination, blocked
 * - `notify` (capability-gated) — subscribe + dispose smoke test
 *
 * Tests namespace their streams with a per-test {@link uid} so the
 * suite is parallel-safe against a shared backing store (e.g., a real
 * Postgres instance running tests for the whole monorepo concurrently).
 *
 * @example
 * ```ts
 * import { runStoreTck } from "@rotorsoft/act-tck";
 * import { InMemoryStore } from "@rotorsoft/act";
 *
 * runStoreTck({
 *   name: "InMemoryStore",
 *   factory: () => new InMemoryStore(),
 * });
 * ```
 */
export const runStoreTck = (options: StoreTckOptions): void => {
  describe(`TCK / Store / ${options.name}`, () => {
    let store: Store;
    // Spread (rather than `?? {}`) so the default-empty path doesn't
    // create a branch every adapter has to disprove. `{ ...undefined }`
    // is a runtime no-op that yields `{}`.
    const caps: StoreCapabilities = { ...options.capabilities };

    beforeAll(async () => {
      store = await options.factory();
      await store.drop();
      await store.seed();
    });

    afterAll(async () => {
      await store.dispose();
    });

    describe("commit", () => {
      it("returns committed events with sequenced ids and versions", async () => {
        const s = `commit-seq-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2), dec(3)],
          makeMeta({ stream: s })
        );
        expect(committed).toHaveLength(3);
        expect(committed[0].version).toBe(0);
        expect(committed[1].version).toBe(1);
        expect(committed[2].version).toBe(2);
        expect(committed[0].name).toBe("Incremented");
        expect(committed[2].data).toEqual({ amount: 3 });
        for (let i = 1; i < committed.length; i++) {
          expect(committed[i].id).toBeGreaterThan(committed[i - 1].id);
        }
      });

      it("attaches correlation and stream metadata", async () => {
        const s = `commit-meta-${uid()}`;
        const correlation = `cor-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1)],
          makeMeta({ stream: s, correlation })
        );
        expect(committed[0].stream).toBe(s);
        expect(committed[0].meta.correlation).toBe(correlation);
      });

      it("throws ConcurrencyError when expectedVersion is wrong", async () => {
        const s = `commit-cc-${uid()}`;
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          makeMeta({ stream: s }),
          0
        );
        await expect(
          store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }), 0)
        ).rejects.toBeInstanceOf(ConcurrencyError);
      });

      it("preserves prior events when a concurrent commit is rejected", async () => {
        const s = `commit-cc-preserve-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2)],
          makeMeta({ stream: s })
        );
        await expect(
          store.commit<CounterEvents>(s, [inc(3)], makeMeta({ stream: s }), 0)
        ).rejects.toBeInstanceOf(ConcurrencyError);
        const found = await collect(store, { stream: s, stream_exact: true });
        expect(found).toHaveLength(2);
      });
    });

    describe("query", () => {
      it("filters by stream, names, correlation, limit, with_snaps", async () => {
        const s1 = `q-s1-${uid()}`;
        const s2 = `q-s2-${uid()}`;
        const cor = `q-cor-${uid()}`;
        await store.commit<CounterEvents>(
          s1,
          [inc(1), dec(1)],
          makeMeta({ stream: s1, correlation: cor })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(2), dec(2), resetEvent()],
          makeMeta({ stream: s2, correlation: cor })
        );

        const byStream = await collect(store, {
          stream: s1,
          stream_exact: true,
        });
        expect(byStream).toHaveLength(2);

        const byName = await collect(store, {
          stream: s2,
          stream_exact: true,
          names: ["Reset"],
        });
        expect(byName).toHaveLength(1);
        expect(byName[0].name).toBe("Reset");

        const byCorrelation = await collect(store, { correlation: cor });
        expect(byCorrelation).toHaveLength(5);

        const limited = await collect(store, {
          correlation: cor,
          limit: 2,
        });
        expect(limited).toHaveLength(2);
      });

      it("supports backward traversal", async () => {
        const s = `q-back-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2), inc(3)],
          makeMeta({ stream: s })
        );
        const forward = await collect(store, { stream: s, stream_exact: true });
        const backward = await collect(store, {
          stream: s,
          stream_exact: true,
          backward: true,
        });
        expect(forward.map((e) => e.id)).toEqual(committed.map((c) => c.id));
        expect(backward.map((e) => e.id)).toEqual(
          [...committed].reverse().map((c) => c.id)
        );

        // Backward + limit — exercises the limit-break branch in the
        // backward-traversal path. Latest event only.
        const latest = await collect(store, {
          stream: s,
          stream_exact: true,
          backward: true,
          limit: 1,
        });
        expect(latest).toHaveLength(1);
        expect(latest[0].id).toBe(committed.at(-1)!.id);
      });

      it("after/before bound the id range", async () => {
        const s = `q-bounds-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2), inc(3), inc(4)],
          makeMeta({ stream: s })
        );
        const afterFirst = await collect(store, {
          stream: s,
          stream_exact: true,
          after: committed[0].id,
        });
        expect(afterFirst.map((e) => e.id)).toEqual(
          committed.slice(1).map((c) => c.id)
        );
        const beforeLast = await collect(store, {
          stream: s,
          stream_exact: true,
          before: committed[committed.length - 1].id,
        });
        expect(beforeLast.map((e) => e.id)).toEqual(
          committed.slice(0, -1).map((c) => c.id)
        );
      });

      it("created_after/created_before filter by timestamp", async () => {
        const s = `q-ts-${uid()}`;
        const before = new Date(Date.now() - 60_000);
        const future = new Date(Date.now() + 60_000);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const inWindow = await collect(store, {
          stream: s,
          stream_exact: true,
          created_after: before,
          created_before: future,
        });
        expect(inWindow.length).toBe(1);
        const outOfWindow = await collect(store, {
          stream: s,
          stream_exact: true,
          created_after: future,
        });
        expect(outOfWindow.length).toBe(0);
      });

      it("backward traversal short-circuits at `after` id boundary", async () => {
        const s = `q-back-after-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2), inc(3)],
          makeMeta({ stream: s })
        );
        // Backward from the end, but only events newer than committed[0].id.
        const got = await collect(store, {
          stream: s,
          stream_exact: true,
          backward: true,
          after: committed[0].id,
        });
        expect(got.map((e) => e.id)).toEqual([
          committed[2].id,
          committed[1].id,
        ]);
      });

      it("backward traversal short-circuits at `created_after` boundary", async () => {
        const s = `q-back-cafter-${uid()}`;
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        // Asking backward with created_after = now+1m should short-circuit
        // immediately because the only event was created before that bound.
        const future = new Date(Date.now() + 60_000);
        const got = await collect(store, {
          stream: s,
          stream_exact: true,
          backward: true,
          created_after: future,
        });
        expect(got).toHaveLength(0);
      });

      it("backward traversal honors created_before by skipping newer events", async () => {
        const s = `q-back-ts-${uid()}`;
        // `makeMeta()` with no stream — exercises the meta builder's
        // no-causation branch alongside the backward + created_before
        // path inside the adapter.
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta());
        const past = new Date(Date.now() - 60_000);
        const got = await collect(store, {
          stream: s,
          stream_exact: true,
          backward: true,
          created_before: past,
        });
        expect(got).toHaveLength(0);
      });

      it("stream_exact disables regex matching", async () => {
        const tag = uid();
        const a = `q-exact-${tag}`;
        const b = `q-exact-${tag}-extra`;
        await store.commit<CounterEvents>(a, [inc(1)], makeMeta({ stream: a }));
        await store.commit<CounterEvents>(b, [inc(2)], makeMeta({ stream: b }));
        const exact = await collect(store, { stream: a, stream_exact: true });
        expect(exact).toHaveLength(1);
        expect(exact[0].data).toEqual({ amount: 1 });
      });

      // Regex anchor contract — same across every Store. Caller controls
      // anchors. `^foo` for prefix, `foo$` for suffix, `^foo$` for whole-
      // string. A plain `foo` is a substring match. Auto-anchoring by the
      // adapter is a contract violation.
      it("plain regex without anchors is a substring match", async () => {
        const tag = uid();
        const inner = `qr-${tag}-inner`;
        const longer = `qr-${tag}-inner-extra`;
        await store.commit<CounterEvents>(
          inner,
          [inc(1)],
          makeMeta({ stream: inner })
        );
        await store.commit<CounterEvents>(
          longer,
          [inc(2)],
          makeMeta({ stream: longer })
        );
        const got = await collect(store, { stream: `qr-${tag}-inner` });
        expect(got.map((e) => e.stream).sort()).toEqual([inner, longer].sort());
      });

      it("caller-anchored `^name$` matches only the whole string", async () => {
        const tag = uid();
        const inner = `qr-${tag}-anchor`;
        const longer = `qr-${tag}-anchor-extra`;
        await store.commit<CounterEvents>(
          inner,
          [inc(1)],
          makeMeta({ stream: inner })
        );
        await store.commit<CounterEvents>(
          longer,
          [inc(2)],
          makeMeta({ stream: longer })
        );
        const got = await collect(store, { stream: `^qr-${tag}-anchor$` });
        expect(got).toHaveLength(1);
        expect(got[0].stream).toBe(inner);
      });

      it("caller-anchored `^prefix` matches by prefix", async () => {
        const tag = uid();
        const a = `qr-${tag}-pfx-a`;
        const b = `qr-${tag}-pfx-b`;
        const other = `zz-${tag}-other`;
        await store.commit<CounterEvents>(a, [inc(1)], makeMeta({ stream: a }));
        await store.commit<CounterEvents>(b, [inc(2)], makeMeta({ stream: b }));
        await store.commit<CounterEvents>(
          other,
          [inc(3)],
          makeMeta({ stream: other })
        );
        const got = await collect(store, { stream: `^qr-${tag}-pfx-` });
        expect(got.map((e) => e.stream).sort()).toEqual([a, b].sort());
      });
    });

    describe("subscribe + claim + ack", () => {
      it("subscribes new streams and is idempotent on repeat", async () => {
        const s = `sub-${uid()}`;
        const first = await store.subscribe([{ stream: s }]);
        expect(first.subscribed).toBe(1);
        const second = await store.subscribe([{ stream: s }]);
        expect(second.subscribed).toBe(0);
      });

      it("claims a subscribed stream and ack releases the lease", async () => {
        const s = `claim-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const by = `worker-${uid()}`;
        const leased = await store.claim(100, 0, by, 10_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        expect(mine!.by).toBe(by);
        await store.ack([{ ...(mine as Lease), at: mine!.at + 1 }]);
      });

      it("does not double-claim a held lease", async () => {
        const s = `claim-held-${uid()}`;
        const other = `claim-other-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const leasedA = await store.claim(100, 0, `wA-${uid()}`, 100_000);
        const targetA = leasedA.find((l) => l.stream === s);
        expect(targetA).toBeDefined();
        // Subscribe + commit `other` only AFTER A's claim — fresh
        // subscriptions report `at=-1` which adapters treat as
        // claimable. We want `other` to be visible only to B so the
        // negative assertion below runs through a populated array.
        await store.subscribe([{ stream: other }]);
        await store.commit<CounterEvents>(
          other,
          [inc(2)],
          makeMeta({ stream: other })
        );
        const leasedB = await store.claim(100, 0, `wB-${uid()}`, 100_000);
        expect(leasedB.length).toBeGreaterThan(0);
        expect(leasedB.find((l) => l.stream === s)).toBeUndefined();
        expect(leasedB.find((l) => l.stream === other)).toBeDefined();
      });

      it("supports dual frontiers (lagging + leading)", async () => {
        const s = `claim-dual-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2)],
          makeMeta({ stream: s })
        );
        const first = await store.claim(100, 0, `w-${uid()}`, 1);
        const mine = first.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        await store.ack([{ ...(mine as Lease), at: (mine as Lease).at + 1 }]);
        const second = await store.claim(0, 100, `w-${uid()}`, 1);
        expect(second.find((l) => l.stream === s)).toBeDefined();
      });

      it("dedupes when both frontiers would return the same stream", async () => {
        const s = `claim-dedup-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        // Asking for both frontiers with overlapping budgets must not
        // return the same stream twice.
        const claimed = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const matches = claimed.filter((l) => l.stream === s);
        expect(matches).toHaveLength(1);
      });

      it("silently ignores ack from the wrong holder", async () => {
        const s = `ack-wrong-${uid()}`;
        const sibling = `ack-sibling-${uid()}`;
        await store.subscribe([{ stream: s }, { stream: sibling }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        await store.commit<CounterEvents>(
          sibling,
          [inc(2)],
          makeMeta({ stream: sibling })
        );
        const leased = await store.claim(100, 0, `right-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        const siblingLease = leased.find((l) => l.stream === sibling);
        expect(mine).toBeDefined();
        expect(siblingLease).toBeDefined();
        // Mix a correctly-held lease with an imposter ack so `acked`
        // ends up with one entry (the sibling) and the predicate runs.
        const acked = await store.ack([
          { ...(mine as Lease), by: "imposter" },
          siblingLease as Lease,
        ]);
        expect(acked.length).toBeGreaterThan(0);
        expect(acked.find((l) => l.stream === s)).toBeUndefined();
      });

      it("ack with a stale (lower) watermark does not throw", async () => {
        const s = `ack-stale-${uid()}`;
        await store.subscribe([{ stream: s }]);
        const by = `w-${uid()}`;
        const leased = await store.claim(100, 0, by, 100_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        await expect(
          store.ack([{ ...(mine as Lease), at: -5 }])
        ).resolves.toBeDefined();
      });

      it("claim with no subscribed streams returns an empty array", async () => {
        // Use a fresh adapter instance — the parent store is shared across
        // the suite and has subscribed streams already.
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const claimed = await fresh.claim(1, 1, `w-${uid()}`, 1000);
          expect(claimed).toEqual([]);
        } finally {
          await fresh.dispose();
        }
      });
    });

    describe("block", () => {
      it("hides blocked streams from claim", async () => {
        const s = `block-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        const others = leased.filter((l) => l.stream !== s);
        await store.ack(others);
        const blocked = await store.block([
          { ...(mine as Lease), error: "boom" },
        ]);
        expect(blocked).toHaveLength(1);
        expect(blocked[0].error).toBe("boom");
        const again = await store.claim(100, 100, `w2-${uid()}`, 100_000);
        expect(again.find((l) => l.stream === s)).toBeUndefined();
      });

      it("rejects block calls from a different holder", async () => {
        const s = `block-wrong-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const leased = await store.claim(100, 0, `right-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        const others = leased.filter((l) => l.stream !== s);
        await store.ack(others);
        const blocked = await store.block([
          { ...(mine as Lease), by: "imposter", error: "no" },
        ]);
        expect(blocked).toHaveLength(0);
      });
    });

    describe("reset", () => {
      it("rewinds a stream watermark to -1", async () => {
        const s = `reset-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        await store.ack([{ ...(mine as Lease), at: 99 }]);
        expect(await store.reset([s])).toBe(1);
        const after = await store.claim(100, 0, `w2-${uid()}`, 100_000);
        const back = after.find((l) => l.stream === s);
        expect(back).toBeDefined();
        expect(back!.at).toBe(-1);
      });

      it("clears blocked status when resetting", async () => {
        const s = `reset-blk-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        const others = leased.filter((l) => l.stream !== s);
        await store.ack(others);
        await store.block([{ ...(mine as Lease), error: "boom" }]);
        expect(await store.reset([s])).toBe(1);
        const after = await store.claim(100, 0, `w2-${uid()}`, 100_000);
        expect(after.find((l) => l.stream === s)).toBeDefined();
      });

      it("returns 0 for unknown streams and empty input", async () => {
        expect(await store.reset([`missing-${uid()}`])).toBe(0);
        expect(await store.reset([])).toBe(0);
      });
    });

    describe("unblock", () => {
      it("clears blocked flag and preserves the watermark", async () => {
        const s = `unblock-${uid()}`;
        await store.subscribe([{ stream: s }]);
        // Two events so the watermark advances past 0 before block.
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        await store.commit<CounterEvents>(s, [inc(2)], makeMeta({ stream: s }));

        // First lease + ack first event → watermark advances.
        const first = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const m1 = first.find((l) => l.stream === s);
        await store.ack([{ ...(m1 as Lease), at: m1!.at }]);

        // Capture watermark before block.
        const beforeBlock = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const m2 = beforeBlock.find((l) => l.stream === s);
        expect(m2).toBeDefined();
        const watermarkBefore = m2!.at;
        await store.block([{ ...(m2 as Lease), error: "permanent" }]);

        // Stream is now blocked — query_streams must report it as such.
        // (Asserting on `claim()` would be flaky: an empty result is the
        // same as "s not in the result," which short-circuits a find()
        // callback and leaves it uncovered when no other streams happen
        // to be claimable in the fixture.)
        let blockedFlag: boolean | undefined;
        await store.query_streams(
          (p) => {
            blockedFlag = p.blocked;
          },
          { stream: s, stream_exact: true, limit: 1 }
        );
        expect(blockedFlag).toBe(true);

        // Unblock — claim picks it back up at the same watermark.
        expect(await store.unblock([s])).toBe(1);
        const after = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const back = after.find((l) => l.stream === s);
        expect(back).toBeDefined();
        expect(back!.at).toBe(watermarkBefore);
        expect(back!.retry).toBe(0);
      });

      it("returns 0 when the stream is not blocked", async () => {
        const s = `unblock-noop-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        // Stream exists but isn't blocked.
        expect(await store.unblock([s])).toBe(0);
      });

      it("returns 0 for unknown streams and empty input", async () => {
        expect(await store.unblock([`missing-${uid()}`])).toBe(0);
        expect(await store.unblock([])).toBe(0);
      });

      it("only counts streams that were actually blocked", async () => {
        const s1 = `unblock-mix-a-${uid()}`;
        const s2 = `unblock-mix-b-${uid()}`;
        await store.subscribe([{ stream: s1 }, { stream: s2 }]);
        await store.commit<CounterEvents>(
          s1,
          [inc(1)],
          makeMeta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          makeMeta({ stream: s2 })
        );
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const m1 = leased.find((l) => l.stream === s1);
        const others = leased.filter((l) => l.stream !== s1);
        await store.ack(others);
        // Block only s1.
        await store.block([{ ...(m1 as Lease), error: "boom" }]);
        expect(await store.unblock([s1, s2])).toBe(1);
      });

      it("filter form: unblocks by stream pattern", async () => {
        const tag = uid();
        const s1 = `unblock-filter-${tag}-a`;
        const s2 = `unblock-filter-${tag}-b`;
        const s3 = `other-${tag}`;
        await store.subscribe([{ stream: s1 }, { stream: s2 }, { stream: s3 }]);
        await store.commit<CounterEvents>(
          s1,
          [inc(1)],
          makeMeta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          makeMeta({ stream: s2 })
        );
        await store.commit<CounterEvents>(
          s3,
          [inc(1)],
          makeMeta({ stream: s3 })
        );
        // Block all three.
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const blockable: BlockedLease[] = leased
          .filter((l) => l.stream === s1 || l.stream === s2 || l.stream === s3)
          .map((l) => ({ ...(l as Lease), error: "boom" }));
        // Ack any other leases the test fixture's shared store left
        // outstanding so they don't pollute counts below.
        await store.ack(
          leased.filter(
            (l) => !(l.stream === s1 || l.stream === s2 || l.stream === s3)
          )
        );
        await store.block(blockable);

        // Filter targets only `unblock-filter-${tag}-` prefix → 2 of 3.
        const count = await store.unblock({
          stream: `^unblock-filter-${tag}-`,
        });
        expect(count).toBe(2);

        // s3 is still blocked.
        const after = await store.claim(100, 0, `w-${uid()}`, 100_000);
        expect(after.find((l) => l.stream === s3)).toBeUndefined();
        // s1 and s2 are unblocked and claimable.
        expect(after.find((l) => l.stream === s1)).toBeDefined();
        expect(after.find((l) => l.stream === s2)).toBeDefined();
      });

      it("filter form: empty filter unblocks every blocked stream", async () => {
        // Set up an isolated set of blocked streams using a unique tag,
        // then assert the filter unblocks every one. We can't use the
        // truly empty filter `{}` across the shared TCK fixture because
        // other tests may leave blocked rows behind; use the tag as a
        // narrow proxy for "everything in my scope."
        const tag = uid();
        const s1 = `unblock-empty-${tag}-a`;
        const s2 = `unblock-empty-${tag}-b`;
        await store.subscribe([{ stream: s1 }, { stream: s2 }]);
        await store.commit<CounterEvents>(
          s1,
          [inc(1)],
          makeMeta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          makeMeta({ stream: s2 })
        );
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.filter((l) => l.stream === s1 || l.stream === s2);
        await store.ack(leased.filter((l) => !mine.includes(l)));
        await store.block(
          mine.map((l) => ({ ...(l as Lease), error: "boom" }))
        );
        const count = await store.unblock({
          stream: `^unblock-empty-${tag}-`,
        });
        expect(count).toBe(2);
      });

      it("filter form: explicit blocked:false matches nothing", async () => {
        // The implementation forces `blocked = true` regardless of what
        // the caller passed — operators can't accidentally "unblock"
        // already-unblocked streams.
        const tag = uid();
        const s = `unblock-blocked-false-${tag}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        // Stream is registered but not blocked.
        expect(
          await store.unblock({
            stream: `^unblock-blocked-false-${tag}`,
            blocked: false,
          })
        ).toBe(0);
      });
    });

    describe("reset filter form", () => {
      it("resets streams matching a stream pattern", async () => {
        const tag = uid();
        const s1 = `reset-filter-${tag}-a`;
        const s2 = `reset-filter-${tag}-b`;
        const other = `other-reset-${tag}`;
        await store.subscribe([
          { stream: s1 },
          { stream: s2 },
          { stream: other },
        ]);
        await store.commit<CounterEvents>(
          s1,
          [inc(1)],
          makeMeta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          makeMeta({ stream: s2 })
        );
        await store.commit<CounterEvents>(
          other,
          [inc(1)],
          makeMeta({ stream: other })
        );
        // Advance watermarks for all three so the reset is observable.
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.filter(
          (l) => l.stream === s1 || l.stream === s2 || l.stream === other
        );
        await store.ack(mine.map((l) => ({ ...(l as Lease), at: l.at + 100 })));

        // Filter targets only `reset-filter-${tag}-` prefix → 2 of 3.
        const count = await store.reset({ stream: `^reset-filter-${tag}-` });
        expect(count).toBe(2);

        // Inspect via query_streams (doesn't lease, no regex alternation
        // assumptions on SQLite's LIKE-pattern path) — fetch each name
        // by exact match and check the watermark independently.
        const positionFor = async (name: string): Promise<number | null> => {
          let at: number | null = null;
          await store.query_streams(
            (p) => {
              at = p.at;
            },
            { stream: name, stream_exact: true, limit: 1 }
          );
          return at;
        };
        expect(await positionFor(s1)).toBe(-1);
        expect(await positionFor(s2)).toBe(-1);
        expect(await positionFor(other)).toBeGreaterThan(-1);
      });

      it("filter form: resets only blocked streams when blocked:true", async () => {
        const tag = uid();
        const s1 = `reset-blocked-${tag}-blocked`;
        const s2 = `reset-blocked-${tag}-fine`;
        await store.subscribe([{ stream: s1 }, { stream: s2 }]);
        await store.commit<CounterEvents>(
          s1,
          [inc(1)],
          makeMeta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          makeMeta({ stream: s2 })
        );
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const m1 = leased.find((l) => l.stream === s1);
        await store.ack(leased.filter((l) => l.stream !== s1));
        await store.block([{ ...(m1 as Lease), error: "boom" }]);

        const count = await store.reset({
          stream: `^reset-blocked-${tag}-`,
          blocked: true,
        });
        expect(count).toBe(1);
      });
    });

    describe("prioritize", () => {
      it("sets priority directly, overriding subscribe's max() rule", async () => {
        const tag = uid();
        const s1 = `pri-${tag}-a`;
        const s2 = `pri-${tag}-b`;
        await store.subscribe([
          { stream: s1, priority: 5 },
          { stream: s2, priority: 5 },
        ]);
        const updated = await store.prioritize(
          { stream: s1, stream_exact: true },
          3
        );
        expect(updated).toBe(1);
        const got1: { priority?: number } = {};
        const got2: { priority?: number } = {};
        await store.query_streams(
          (p) => {
            if (p.stream === s1) got1.priority = p.priority;
            if (p.stream === s2) got2.priority = p.priority;
          },
          { stream: `pri-${tag}-.*`, limit: 100 }
        );
        expect(got1.priority).toBe(3);
        expect(got2.priority).toBe(5);
      });
    });

    // ACT-1103: drain lanes. The Store contract now carries lane on
    // every persisted-and-returned stream surface. Adapters that
    // haven't migrated will fail these cases — the signal is
    // intentional ("the contract changed, your adapter needs to
    // surface lane"). Lane mutability across subscribe calls is the
    // load-bearing case: the builder config wins on every restart, so
    // operators can move a stream by editing config and restarting
    // without a manual data migration.
    describe("lanes", () => {
      it("subscribe defaults lane to 'default' when omitted", async () => {
        const s = `lane-default-${uid()}`;
        await store.subscribe([{ stream: s }]);
        const seen: string[] = [];
        await store.query_streams((p) => seen.push(p.lane as string), {
          stream: s,
          stream_exact: true,
        });
        expect(seen).toEqual(["default"]);
      });

      it("subscribe records the lane passed in", async () => {
        const s = `lane-set-${uid()}`;
        await store.subscribe([{ stream: s, lane: "slow" }]);
        const seen: string[] = [];
        await store.query_streams((p) => seen.push(p.lane as string), {
          stream: s,
          stream_exact: true,
        });
        expect(seen).toEqual(["slow"]);
      });

      it("subscribe re-lanes existing streams on subsequent calls", async () => {
        const s = `lane-upsert-${uid()}`;
        await store.subscribe([{ stream: s, lane: "slow" }]);
        await store.subscribe([{ stream: s, lane: "fast" }]);
        const seen: string[] = [];
        await store.query_streams((p) => seen.push(p.lane as string), {
          stream: s,
          stream_exact: true,
        });
        expect(seen).toEqual(["fast"]);
      });

      it("claim() filters by lane when supplied and returns lane on the Lease", async () => {
        const tag = uid();
        const src1 = `lane-claim-src1-${tag}`;
        const src2 = `lane-claim-src2-${tag}`;
        const subDefault = `lane-claim-def-${tag}`;
        const subSlow = `lane-claim-slow-${tag}`;
        await store.commit<CounterEvents>(
          src1,
          [inc(1)],
          makeMeta({ stream: src1 })
        );
        await store.commit<CounterEvents>(
          src2,
          [inc(1)],
          makeMeta({ stream: src2 })
        );
        await store.subscribe([
          { stream: subDefault, source: src1 },
          { stream: subSlow, source: src2, lane: "slow" },
        ]);

        const slow = await store.claim(50, 0, `w-slow-${tag}`, 1_000, "slow");
        const slowMine = slow.filter(
          (l) => l.stream === subDefault || l.stream === subSlow
        );
        expect(slowMine.map((l) => l.stream)).toEqual([subSlow]);
        expect(slowMine[0]?.lane).toBe("slow");
        await store.ack(slowMine.map((l) => ({ ...l, at: l.at + 1 })));

        const all = await store.claim(50, 0, `w-all-${tag}`, 1_000);
        const allMine = all
          .filter((l) => l.stream === subDefault || l.stream === subSlow)
          .map((l) => ({ stream: l.stream, lane: l.lane }));
        expect(allMine).toEqual(
          expect.arrayContaining([
            { stream: subDefault, lane: "default" },
            { stream: subSlow, lane: "slow" },
          ])
        );
      });

      it("query_streams filters by lane", async () => {
        const tag = uid();
        const a = `lane-q-a-${tag}`;
        const b = `lane-q-b-${tag}`;
        const c = `lane-q-c-${tag}`;
        await store.subscribe([
          { stream: a, lane: "qslow" },
          { stream: b, lane: "qfast" },
          { stream: c, lane: "qslow" },
        ]);
        const seen: string[] = [];
        await store.query_streams((p) => seen.push(p.stream), {
          lane: "qslow",
          stream: `lane-q-.*-${tag}`,
          limit: 100,
        });
        expect(seen.sort()).toEqual([a, c]);
      });

      it("prioritize filters by lane", async () => {
        const tag = uid();
        const a = `lane-pri-a-${tag}`;
        const b = `lane-pri-b-${tag}`;
        await store.subscribe([
          { stream: a, lane: `pslow-${tag}` },
          { stream: b, lane: `pfast-${tag}` },
        ]);
        const updated = await store.prioritize({ lane: `pslow-${tag}` }, 7);
        expect(updated).toBe(1);
        const seen = new Map<string, number>();
        await store.query_streams((p) => seen.set(p.stream, p.priority), {
          stream: `lane-pri-.*-${tag}`,
          limit: 100,
        });
        expect(seen.get(a)).toBe(7);
        expect(seen.get(b)).toBe(0);
      });

      it("reset filters by lane", async () => {
        const tag = uid();
        const src = `lane-reset-src-${tag}`;
        const a = `lane-reset-a-${tag}`;
        const b = `lane-reset-b-${tag}`;
        await store.commit<CounterEvents>(
          src,
          [inc(1)],
          makeMeta({ stream: src })
        );
        await store.subscribe([
          { stream: a, source: src, lane: `rslow-${tag}` },
          { stream: b, source: src, lane: `rfast-${tag}` },
        ]);
        const leases = await store.claim(50, 0, `w-${tag}`, 5_000);
        const mine = leases.filter((l) => l.stream === a || l.stream === b);
        await store.ack(mine.map((l) => ({ ...l, at: l.at + 1 })));

        const count = await store.reset({ lane: `rslow-${tag}` });
        expect(count).toBe(1);
        // Fetch each stream by exact match — keeps the contract test
        // adapter-agnostic (PG `~` and SQLite anchor-aware LIKE both
        // honor `stream_exact: true` identically).
        const ats = new Map<string, number>();
        for (const name of [a, b]) {
          await store.query_streams((p) => ats.set(p.stream, p.at), {
            stream: name,
            stream_exact: true,
          });
        }
        expect(ats.get(a)).toBe(-1);
        expect(ats.get(b)).toBeGreaterThanOrEqual(0);
      });

      it("unblock filters by lane", async () => {
        const tag = uid();
        const src = `lane-ub-src-${tag}`;
        const a = `lane-ub-a-${tag}`;
        const b = `lane-ub-b-${tag}`;
        await store.commit<CounterEvents>(
          src,
          [inc(1)],
          makeMeta({ stream: src })
        );
        await store.subscribe([
          { stream: a, source: src, lane: `uslow-${tag}` },
          { stream: b, source: src, lane: `ufast-${tag}` },
        ]);
        const leases = await store.claim(50, 0, `w-${tag}`, 5_000);
        const mine = leases.filter((l) => l.stream === a || l.stream === b);
        await store.block(mine.map((l) => ({ ...l, error: "boom" })));

        const count = await store.unblock({ lane: `uslow-${tag}` });
        expect(count).toBe(1);
        const blocked = new Map<string, boolean>();
        for (const name of [a, b]) {
          await store.query_streams((p) => blocked.set(p.stream, p.blocked), {
            stream: name,
            stream_exact: true,
          });
        }
        expect(blocked.get(a)).toBe(false);
        expect(blocked.get(b)).toBe(true);
      });
    });

    describe("truncate", () => {
      it("seeds a tombstone when no snapshot is provided", async () => {
        const s = `trunc-tomb-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2)],
          makeMeta({ stream: s })
        );
        const result = await store.truncate([{ stream: s }]);
        expect(result.get(s)?.deleted).toBe(2);
        const remaining: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            remaining.push(e);
          },
          { stream: s, stream_exact: true }
        );
        expect(remaining).toHaveLength(1);
        expect((remaining[0] as unknown as { name: string }).name).toBe(
          "__tombstone__"
        );
      });

      it("seeds a snapshot when one is provided", async () => {
        const s = `trunc-snap-${uid()}`;
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const result = await store.truncate([
          { stream: s, snapshot: { count: 7 } },
        ]);
        expect(result.get(s)?.deleted).toBe(1);
        const remaining: CommittedCounterEvent[] = [];
        await store.query<CounterEvents>(
          (e) => {
            remaining.push(e as CommittedCounterEvent);
          },
          { stream: s, stream_exact: true, with_snaps: true }
        );
        expect(remaining).toHaveLength(1);
        expect((remaining[0] as unknown as { name: string }).name).toBe(
          "__snapshot__"
        );
        expect(remaining[0].data).toEqual({ count: 7 });
      });

      it("returns an empty map for empty input", async () => {
        const result = await store.truncate([]);
        expect(result.size).toBe(0);
      });

      it("returns 0 deleted for streams that don't exist", async () => {
        const s = `trunc-missing-${uid()}`;
        const result = await store.truncate([{ stream: s }]);
        expect(result.get(s)?.deleted).toBe(0);
      });
    });

    describe("query_streams", () => {
      it("returns positions filtered by stream regex, exact, source, and source_exact", async () => {
        const tag = uid();
        const proj1 = `qs-${tag}-projection-tickets`;
        const proj2 = `qs-${tag}-projection-users`;
        const dyn1 = `qs-${tag}-stats-1`;
        const dyn2 = `qs-${tag}-stats-2`;
        const src1 = `qs-${tag}-src-1`;
        const src2 = `qs-${tag}-src-2`;
        await store.subscribe([
          { stream: proj1 },
          { stream: proj2 },
          { stream: dyn1, source: src1 },
          { stream: dyn2, source: src2 },
        ]);

        const all: Array<{ stream: string; source?: string }> = [];
        const allResult = await store.query_streams(
          (p) => all.push({ stream: p.stream, source: p.source }),
          { stream: `qs-${tag}-.*` }
        );
        expect(allResult.count).toBe(4);
        expect(allResult.maxEventId).toBeGreaterThanOrEqual(-1);
        expect(all.map((p) => p.stream).sort()).toEqual(
          [proj1, proj2, dyn1, dyn2].sort()
        );

        const projections: string[] = [];
        await store.query_streams((p) => projections.push(p.stream), {
          stream: `qs-${tag}-projection-.*`,
        });
        expect(projections.sort()).toEqual([proj1, proj2].sort());

        const exact: string[] = [];
        await store.query_streams((p) => exact.push(p.stream), {
          stream: dyn1,
          stream_exact: true,
        });
        expect(exact).toEqual([dyn1]);

        const bySource: string[] = [];
        await store.query_streams((p) => bySource.push(p.stream), {
          stream: `qs-${tag}-.*`,
          source: `qs-${tag}-src-.*`,
        });
        expect(bySource.sort()).toEqual([dyn1, dyn2].sort());

        const exactSource: string[] = [];
        await store.query_streams((p) => exactSource.push(p.stream), {
          stream: `qs-${tag}-.*`,
          source: src2,
          source_exact: true,
        });
        expect(exactSource).toEqual([dyn2]);
      });

      it("paginates with limit + after (keyset)", async () => {
        const tag = uid();
        const streams = [
          `qp-${tag}-a`,
          `qp-${tag}-b`,
          `qp-${tag}-c`,
          `qp-${tag}-d`,
        ];
        await store.subscribe(streams.map((stream) => ({ stream })));
        const page1: string[] = [];
        await store.query_streams((p) => page1.push(p.stream), {
          stream: `qp-${tag}-.*`,
          limit: 2,
        });
        expect(page1).toHaveLength(2);
        const page2: string[] = [];
        await store.query_streams((p) => page2.push(p.stream), {
          stream: `qp-${tag}-.*`,
          limit: 2,
          after: page1.at(-1),
        });
        expect(page2).toHaveLength(2);
        expect([...page1, ...page2].sort()).toEqual([...streams].sort());
      });

      it("filters by blocked status", async () => {
        const tag = uid();
        const s = `qb-${tag}`;
        const sibling = `qb-${tag}-other`;
        await store.subscribe([{ stream: s }, { stream: sibling }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        const others = leased.filter((l) => l.stream !== s);
        await store.ack(others);
        await store.block([{ ...(mine as Lease), error: "boom" }]);

        const blocked: Array<{ stream: string; error: string }> = [];
        await store.query_streams(
          (p) => blocked.push({ stream: p.stream, error: p.error }),
          { stream: `qb-${tag}.*`, blocked: true }
        );
        expect(blocked).toHaveLength(1);
        expect(blocked[0].error).toBe("boom");

        // blocked: false — must exclude the blocked one but include
        // the sibling, exercising the other arm of the conditional.
        const unblocked: string[] = [];
        await store.query_streams((p) => unblocked.push(p.stream), {
          stream: `qb-${tag}.*`,
          blocked: false,
        });
        expect(unblocked).toEqual([sibling]);
      });
    });

    describe("query_stats", () => {
      it("array input — returns head per stream, absent when not in input", async () => {
        const tag = uid();
        const sA = `qst-${tag}-a`;
        const sB = `qst-${tag}-b`;
        const sUnasked = `qst-${tag}-unasked`;
        await store.commit<CounterEvents>(
          sA,
          [inc(1), inc(2)],
          makeMeta({ stream: sA })
        );
        await store.commit<CounterEvents>(
          sB,
          [dec(5)],
          makeMeta({ stream: sB })
        );
        await store.commit<CounterEvents>(
          sUnasked,
          [inc(99)],
          makeMeta({ stream: sUnasked })
        );

        const stats = await store.query_stats<CounterEvents>([sA, sB]);
        expect(stats.size).toBe(2);
        expect(stats.get(sA)?.head.name).toBe("Incremented");
        expect((stats.get(sA)?.head.data as { amount: number }).amount).toBe(2);
        expect(stats.get(sB)?.head.name).toBe("Decremented");
        expect((stats.get(sB)?.head.data as { amount: number }).amount).toBe(5);
        expect(stats.has(sUnasked)).toBe(false);

        // Empty input — empty result.
        const empty = await store.query_stats([]);
        expect(empty.size).toBe(0);

        // Unknown stream name — absent, not an error.
        const unknown = await store.query_stats([`qst-${tag}-missing`]);
        expect(unknown.size).toBe(0);
      });

      it("tail returns the earliest event per stream", async () => {
        const tag = uid();
        const s = `qst-tail-${tag}`;
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        await store.commit<CounterEvents>(s, [inc(2)], makeMeta({ stream: s }));
        await store.commit<CounterEvents>(s, [inc(3)], makeMeta({ stream: s }));

        const stats = await store.query_stats<CounterEvents>([s], {
          tail: true,
        });
        const r = stats.get(s);
        expect(r?.head.name).toBe("Incremented");
        expect((r?.head.data as { amount: number }).amount).toBe(3);
        expect(r?.tail?.name).toBe("Incremented");
        expect((r?.tail?.data as { amount: number }).amount).toBe(1);
      });

      it("count + names — full aggregates including framework markers", async () => {
        const tag = uid();
        const s = `qst-cn-${tag}`;
        // 1 inc, then truncate (wipes + seeds snap), then 2 more incs + 1 dec
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        await store.truncate([{ stream: s, snapshot: { count: 99 } }]);
        await store.commit<CounterEvents>(
          s,
          [inc(2), inc(3), dec(1)],
          makeMeta({ stream: s })
        );

        const stats = await store.query_stats<CounterEvents>([s], {
          count: true,
          names: true,
        });
        const r = stats.get(s);
        // Post-truncate live events: snap + inc + inc + dec = 4
        expect(r?.count).toBe(4);
        expect(r?.names?.[SNAP_EVENT]).toBe(1);
        expect(r?.names?.Incremented).toBe(2);
        expect(r?.names?.Decremented).toBe(1);
        // Snapshot count is derivable from the names map — no separate field needed.
        expect(r?.names?.[SNAP_EVENT]).toBe(1);
      });

      it("exclude shifts head past filtered events; stream absent when all filtered", async () => {
        const tag = uid();
        const s = `qst-excl-${tag}`;
        const sAllOut = `qst-allout-${tag}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1), dec(2), inc(3)],
          makeMeta({ stream: s })
        );
        await store.commit<CounterEvents>(
          sAllOut,
          [inc(7)],
          makeMeta({ stream: sAllOut })
        );

        // Without exclude — head is the latest Incremented.
        const all = await store.query_stats<CounterEvents>([s]);
        expect(all.get(s)?.head.name).toBe("Incremented");
        expect((all.get(s)?.head.data as { amount: number }).amount).toBe(3);

        // Exclude Incremented — head is now Decremented (the next-latest).
        const excl = await store.query_stats<CounterEvents>([s], {
          exclude: ["Incremented"],
        });
        expect(excl.get(s)?.head.name).toBe("Decremented");
        expect((excl.get(s)?.head.data as { amount: number }).amount).toBe(2);

        // Exclude every name on a stream — that stream is absent from result.
        const wipe = await store.query_stats<CounterEvents>([sAllOut], {
          exclude: ["Incremented", "Decremented", "Reset"],
        });
        expect(wipe.has(sAllOut)).toBe(false);

        // Framework markers are typed in EventName<E> too — close-cycle pattern.
        const noTomb = await store.query_stats<CounterEvents>([s], {
          exclude: [TOMBSTONE_EVENT],
        });
        expect(noTomb.get(s)?.head.name).toBe("Incremented");
      });

      it("before — time travel narrows head/tail/count", async () => {
        const tag = uid();
        const s = `qst-tt-${tag}`;
        const c1 = await store.commit<CounterEvents>(
          s,
          [inc(1)],
          makeMeta({ stream: s })
        );
        const c2 = await store.commit<CounterEvents>(
          s,
          [inc(2)],
          makeMeta({ stream: s })
        );
        await store.commit<CounterEvents>(s, [inc(3)], makeMeta({ stream: s }));

        // Cutoff at id of c2's event — only c1's event is < cutoff
        const before = c2[0].id;
        const stats = await store.query_stats<CounterEvents>([s], {
          tail: true,
          count: true,
          before,
        });
        const r = stats.get(s);
        expect(r?.count).toBe(1);
        expect(r?.head.id).toBe(c1[0].id);
        expect(r?.tail?.id).toBe(c1[0].id);

        // Cutoff before any event — stream absent
        const empty = await store.query_stats<CounterEvents>([s], {
          before: 0,
        });
        expect(empty.has(s)).toBe(false);
      });

      it("filter form — stream regex, stream_exact, empty {} match", async () => {
        const tag = uid();
        const sA = `qsf-${tag}-orders-1`;
        const sB = `qsf-${tag}-orders-2`;
        const sOther = `qsf-${tag}-users-1`;
        await store.commit<CounterEvents>(
          sA,
          [inc(1)],
          makeMeta({ stream: sA })
        );
        await store.commit<CounterEvents>(
          sB,
          [inc(2)],
          makeMeta({ stream: sB })
        );
        await store.commit<CounterEvents>(
          sOther,
          [inc(3)],
          makeMeta({ stream: sOther })
        );

        // Regex match — restrict to this tag's orders.
        const orders = await store.query_stats<CounterEvents>({
          stream: `^qsf-${tag}-orders-`,
        });
        expect([...orders.keys()].sort()).toEqual([sA, sB].sort());

        // Exact match — single stream.
        const exact = await store.query_stats<CounterEvents>({
          stream: sA,
          stream_exact: true,
        });
        expect([...exact.keys()]).toEqual([sA]);

        // Empty filter — matches every event-bearing stream visible to
        // this test's tag (filtered down to avoid sibling-test pollution).
        const all = await store.query_stats<CounterEvents>({
          stream: `^qsf-${tag}-`,
        });
        expect([...all.keys()].sort()).toEqual([sA, sB, sOther].sort());
      });

      it("compose with query_streams for subscription-level filters", async () => {
        // `query_stats` only accepts event-stream selection. For
        // "stats for blocked subscriptions" etc., compose with
        // `query_streams` and pipe the names through. This test asserts
        // that two-call pattern works end-to-end.
        const tag = uid();
        const a = `qsc-${tag}-a`;
        const b = `qsc-${tag}-b`;
        await store.subscribe([{ stream: a }, { stream: b }]);
        await store.commit<CounterEvents>(a, [inc(1)], makeMeta({ stream: a }));
        await store.commit<CounterEvents>(b, [inc(2)], makeMeta({ stream: b }));

        // Block stream `a` via the standard claim → block path.
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === a);
        expect(mine).toBeDefined();
        const others = leased.filter((l) => l.stream !== a);
        await store.ack(others);
        await store.block([{ ...(mine as Lease), error: "boom" }]);

        // Step 1: subscription-level filter via query_streams.
        const blockedNames: string[] = [];
        await store.query_streams((p) => blockedNames.push(p.stream), {
          stream: `^qsc-${tag}-`,
          blocked: true,
        });
        expect(blockedNames).toEqual([a]);

        // Step 2: event-level stats for those streams.
        const stats = await store.query_stats<CounterEvents>(blockedNames);
        expect(stats.get(a)?.head.name).toBe("Incremented");
        expect(stats.has(b)).toBe(false);
      });

      it("empty filter {} — matches every event-bearing stream", async () => {
        const tag = uid();
        const a = `qse-${tag}-a`;
        const b = `qse-${tag}-b`;
        await store.commit<CounterEvents>(a, [inc(1)], makeMeta({ stream: a }));
        await store.commit<CounterEvents>(b, [dec(2)], makeMeta({ stream: b }));

        // {} matches all event-bearing streams globally — the TCK runs
        // against a shared store, so we only assert that this tag's
        // streams are present (other tests' streams may also appear).
        const all = await store.query_stats<CounterEvents>({});
        expect(all.has(a)).toBe(true);
        expect(all.has(b)).toBe(true);
      });

      it("stat-flag combinations — count-only, names-only, tail-only", async () => {
        const tag = uid();
        const s = `qsfl-${tag}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2), dec(3)],
          makeMeta({ stream: s })
        );

        // count only → no names, no tail in result.
        const c = await store.query_stats<CounterEvents>([s], {
          count: true,
        });
        expect(c.get(s)?.count).toBe(3);
        expect(c.get(s)?.names).toBeUndefined();
        expect(c.get(s)?.tail).toBeUndefined();

        // names only → no count, no tail.
        const n = await store.query_stats<CounterEvents>([s], {
          names: true,
        });
        expect(n.get(s)?.names).toEqual({ Incremented: 2, Decremented: 1 });
        expect(n.get(s)?.count).toBeUndefined();
        expect(n.get(s)?.tail).toBeUndefined();

        // tail only → no count, no names. Cheap path (no full scan).
        const t = await store.query_stats<CounterEvents>([s], { tail: true });
        expect(t.get(s)?.tail?.name).toBe("Incremented");
        expect((t.get(s)?.tail?.data as { amount: number }).amount).toBe(1);
        expect(t.get(s)?.count).toBeUndefined();
        expect(t.get(s)?.names).toBeUndefined();
      });
    });

    describe("query_streams anchor contract", () => {
      // Same regex-anchor rules as `query`. Auto-anchoring by an adapter
      // is a contract violation — every store must honor caller-supplied
      // anchors identically.
      it("plain regex without anchors is a substring match", async () => {
        const tag = uid();
        const inner = `qsr-${tag}-inner`;
        const longer = `qsr-${tag}-inner-extra`;
        const other = `zz-${tag}-other`;
        await store.subscribe([
          { stream: inner },
          { stream: longer },
          { stream: other },
        ]);
        const seen: string[] = [];
        await store.query_streams((p) => seen.push(p.stream), {
          stream: `qsr-${tag}-inner`,
        });
        expect(seen.sort()).toEqual([inner, longer].sort());
      });

      it("caller-anchored `^name$` matches only the whole string", async () => {
        const tag = uid();
        const inner = `qsr-${tag}-anchor`;
        const longer = `qsr-${tag}-anchor-extra`;
        await store.subscribe([{ stream: inner }, { stream: longer }]);
        const seen: string[] = [];
        await store.query_streams((p) => seen.push(p.stream), {
          stream: `^qsr-${tag}-anchor$`,
        });
        expect(seen).toEqual([inner]);
      });

      it("caller-anchored `^prefix` matches by prefix", async () => {
        const tag = uid();
        const a = `qsr-${tag}-pfx-a`;
        const b = `qsr-${tag}-pfx-b`;
        const other = `zz-${tag}-pfx-c`;
        await store.subscribe([
          { stream: a },
          { stream: b },
          { stream: other },
        ]);
        const seen: string[] = [];
        await store.query_streams((p) => seen.push(p.stream), {
          stream: `^qsr-${tag}-pfx-`,
        });
        expect(seen.sort()).toEqual([a, b].sort());
      });
    });

    describe("prioritize anchor contract", () => {
      it("caller-anchored `^name$` filter matches only the whole string", async () => {
        const tag = uid();
        const inner = `pr-${tag}-anchor`;
        const longer = `pr-${tag}-anchor-extra`;
        await store.subscribe([
          { stream: inner, priority: 0 },
          { stream: longer, priority: 0 },
        ]);
        const updated = await store.prioritize(
          { stream: `^pr-${tag}-anchor$` },
          7
        );
        expect(updated).toBe(1);
        const seen = new Map<string, number>();
        await store.query_streams((p) => seen.set(p.stream, p.priority), {
          stream: `pr-${tag}-anchor`,
        });
        expect(seen.get(inner)).toBe(7);
        expect(seen.get(longer)).toBe(0);
      });
    });

    describe("query_streams head", () => {
      it("maxEventId tracks the highest committed id", async () => {
        const s = `head-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(s, [inc(1)], makeMeta({ stream: s }));
        const positions: string[] = [];
        const { maxEventId } = await store.query_streams(
          (p) => positions.push(p.stream),
          { stream: s, stream_exact: true, limit: 1 }
        );
        expect(maxEventId).toBeGreaterThanOrEqual(0);
        expect(positions).toEqual([s]);
      });
    });

    describe("seedStream helper coverage", () => {
      it("commits N events with monotonically increasing ids", async () => {
        const s = `seed-${uid()}`;
        const committed = await seedStream(store, s, 3);
        expect(committed).toHaveLength(3);
        for (let i = 1; i < committed.length; i++) {
          expect(committed[i].id).toBeGreaterThan(committed[i - 1].id);
        }
      });
    });

    // Use `describe.skipIf` rather than `if (caps.restore) { describe(...) }`
    // so the gating lives inside vitest's skip mechanism instead of an
    // `if` branch every consumer would have to disprove (all three
    // in-tree adapters opt in to restore).
    describe.skipIf(!caps.restore)("restore (capability)", () => {
      // Restore wipes the whole store — every test starts from a
      // freshly-dropped + seeded baseline so no test inherits
      // another's post-restore state and so subsequent TCK blocks
      // (notify) get a predictable empty store.
      beforeEach(async () => {
        await store.drop();
        await store.seed();
      });

      /** Adapt a row array into the AsyncIterable contract. */
      const asSource = (rows: RestoreRow[]): AsyncIterable<RestoreRow> =>
        (async function* () {
          for (const r of rows) yield r;
        })();

      /**
       * Build a RestoreRow with stub meta + the given created date.
       * `originalId` populates `RestoreRow.id` — used by the adapter
       * to key the causation remap. Tests pass arbitrary values
       * (often a counter) since they're only consumed by the map.
       */
      const row = (
        originalId: number,
        stream: string,
        version: number,
        name: string,
        created: Date,
        data: Record<string, unknown> = {}
      ): RestoreRow => ({
        id: originalId,
        name,
        data,
        stream,
        version,
        created,
        meta: { correlation: "restore-tck", causation: {} },
      });

      it("returns kept=0 on an empty source", async () => {
        const result = await store.restore!(asSource([]));
        expect(result.kept).toBe(0);
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
        expect(result.dry_run).toBe(false);
        expect(result.dropped).toEqual({
          closed_streams: 0,
          snapshots: 0,
          empty_streams: 0,
        });
        // Store ends empty.
        const events = await collect(store, { limit: 10 });
        expect(events).toHaveLength(0);
      });

      it("rebuilds a single stream and preserves `created` verbatim", async () => {
        const s = `restore-single-${uid()}`;
        const t0 = new Date("2020-01-01T00:00:00.000Z");
        const t1 = new Date("2020-01-02T00:00:00.000Z");
        const t2 = new Date("2020-01-03T00:00:00.000Z");
        const rows = [
          row(1, s, 0, "Incremented", t0, { amount: 1 }),
          row(2, s, 1, "Incremented", t1, { amount: 2 }),
          row(3, s, 2, "Decremented", t2, { amount: 1 }),
        ];
        const result = await store.restore!(asSource(rows));
        expect(result.kept).toBe(3);
        const back: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            back.push(e);
          },
          { stream: s, stream_exact: true }
        );
        expect(back).toHaveLength(3);
        expect(
          back.map((e) => ({
            stream: e.stream,
            version: e.version,
            name: e.name,
            created: e.created.toISOString(),
            data: e.data,
          }))
        ).toEqual([
          {
            stream: s,
            version: 0,
            name: "Incremented",
            created: t0.toISOString(),
            data: { amount: 1 },
          },
          {
            stream: s,
            version: 1,
            name: "Incremented",
            created: t1.toISOString(),
            data: { amount: 2 },
          },
          {
            stream: s,
            version: 2,
            name: "Decremented",
            created: t2.toISOString(),
            data: { amount: 1 },
          },
        ]);
      });

      it("rebuilds multiple streams interleaved", async () => {
        const a = `restore-multi-a-${uid()}`;
        const b = `restore-multi-b-${uid()}`;
        const t = new Date("2020-06-01T00:00:00.000Z");
        const rows = [
          row(1, a, 0, "Incremented", t, { amount: 10 }),
          row(2, b, 0, "Incremented", t, { amount: 20 }),
          row(3, a, 1, "Decremented", t, { amount: 5 }),
          row(4, b, 1, "Incremented", t, { amount: 30 }),
        ];
        const result = await store.restore!(asSource(rows));
        expect(result.kept).toBe(4);
        const aBack: Committed<CounterEvents, keyof CounterEvents>[] = [];
        const bBack: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            aBack.push(e);
          },
          { stream: a, stream_exact: true }
        );
        await store.query<CounterEvents>(
          (e) => {
            bBack.push(e);
          },
          { stream: b, stream_exact: true }
        );
        expect(aBack.map((e) => e.version)).toEqual([0, 1]);
        expect(bBack.map((e) => e.version)).toEqual([0, 1]);
      });

      it("accepts ISO string `created` and parses to Date", async () => {
        const s = `restore-isoc-${uid()}`;
        const iso = "2021-07-15T12:34:56.789Z";
        await store.restore!(
          asSource([
            {
              id: 1,
              stream: s,
              version: 0,
              name: "Incremented",
              data: { amount: 1 },
              created: iso,
              meta: { correlation: "restore-tck", causation: {} },
            },
          ])
        );
        const back: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            back.push(e);
          },
          { stream: s, stream_exact: true }
        );
        expect(back).toHaveLength(1);
        expect(back[0].created.toISOString()).toBe(iso);
      });

      it("wipes pre-existing events before inserting", async () => {
        const old = `restore-old-${uid()}`;
        await store.commit<CounterEvents>(
          old,
          [inc(1), inc(2)],
          makeMeta({ stream: old })
        );
        const fresh = `restore-fresh-${uid()}`;
        const t = new Date("2020-01-01T00:00:00.000Z");
        await store.restore!(
          asSource([row(1, fresh, 0, "Incremented", t, { amount: 99 })])
        );
        // The old stream is gone.
        const oldBack = await collect(store, {
          stream: old,
          stream_exact: true,
        });
        expect(oldBack).toHaveLength(0);
        // Only the fresh stream remains.
        const freshBack = await collect(store, {
          stream: fresh,
          stream_exact: true,
        });
        expect(freshBack).toHaveLength(1);
      });

      it("clears subscription/stream-position metadata", async () => {
        const sub = `restore-sub-${uid()}`;
        await store.subscribe([{ stream: sub, source: "anything" }]);
        const collectStreams = async () => {
          const out: string[] = [];
          await store.query_streams((p) => {
            out.push(p.stream);
          });
          return out;
        };
        const before = await collectStreams();
        expect(before.includes(sub)).toBe(true);
        await store.restore!(asSource([]));
        const after = await collectStreams();
        expect(after.includes(sub)).toBe(false);
      });

      it("preserves snapshot events through restore", async () => {
        // SNAP_EVENT is a framework marker — restore writes it
        // through but skips updating the max-non-snap-id indexes.
        // Covers the `row.name !== SNAP_EVENT` false branch.
        const s = `restore-snap-${uid()}`;
        const t = new Date("2020-04-01T00:00:00.000Z");
        await store.restore!(
          asSource([
            {
              id: 1,
              stream: s,
              version: 0,
              name: SNAP_EVENT,
              data: { count: 42 },
              created: t,
              meta: { correlation: "snap", causation: {} },
            },
          ])
        );
        const back = await collect(store, {
          stream: s,
          stream_exact: true,
          with_snaps: true,
        });
        expect(back).toHaveLength(1);
        expect((back[0] as { name: string }).name).toBe(SNAP_EVENT);
      });

      it("rewrites causation refs through the old→new id map", async () => {
        // Sparse source ids (5, 7, 9) — adapter renumbers densely;
        // the row whose causation pointed at original id 5 must end
        // up pointing at the new id assigned to that same row.
        const s = `restore-caus-${uid()}`;
        const t = new Date("2020-08-01T00:00:00.000Z");
        const rows: RestoreRow[] = [
          {
            id: 5,
            stream: s,
            version: 0,
            name: "Incremented",
            data: { amount: 1 },
            created: t,
            meta: { correlation: "c", causation: {} },
          },
          {
            id: 7,
            stream: s,
            version: 1,
            name: "Incremented",
            data: { amount: 2 },
            created: t,
            meta: {
              correlation: "c",
              causation: {
                event: { id: 5, name: "Incremented", stream: s },
              },
            },
          },
          {
            id: 9,
            stream: s,
            version: 2,
            name: "Decremented",
            data: { amount: 1 },
            created: t,
            meta: {
              correlation: "c",
              causation: {
                event: { id: 7, name: "Incremented", stream: s },
              },
            },
          },
        ];
        await store.restore!(asSource(rows));
        const back: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            back.push(e);
          },
          { stream: s, stream_exact: true }
        );
        expect(back).toHaveLength(3);
        // First row's causation is empty.
        expect(back[0].meta.causation.event).toBeUndefined();
        // Second row's causation pointed at original id 5 → new id of row 0.
        expect(back[1].meta.causation.event?.id).toBe(back[0].id);
        // Third row's causation pointed at original id 7 → new id of row 1.
        expect(back[2].meta.causation.event?.id).toBe(back[1].id);
      });

      it("leaves causation refs unmapped when the target isn't in the source", async () => {
        const s = `restore-orphan-${uid()}`;
        const t = new Date("2020-09-01T00:00:00.000Z");
        await store.restore!(
          asSource([
            {
              id: 1,
              stream: s,
              version: 0,
              name: "Incremented",
              data: { amount: 1 },
              created: t,
              meta: {
                correlation: "c",
                causation: {
                  event: { id: 999, name: "Phantom", stream: "ghost" },
                },
              },
            },
          ])
        );
        const back: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            back.push(e);
          },
          { stream: s, stream_exact: true }
        );
        expect(back[0].meta.causation.event?.id).toBe(999);
      });

      it("rolls back atomically when the source throws mid-iteration", async () => {
        // Pre-seed some events the rollback must restore.
        const original = `restore-pre-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          original,
          [inc(1), inc(2), inc(3)],
          makeMeta({ stream: original })
        );
        const explosive: AsyncIterable<RestoreRow> = (async function* () {
          yield row(
            1,
            `restore-explode-${uid()}`,
            0,
            "Incremented",
            new Date(),
            { amount: 1 }
          );
          throw new Error("boom");
        })();
        await expect(store.restore!(explosive)).rejects.toThrow("boom");
        // Pre-call events still there.
        const back: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            back.push(e);
          },
          { stream: original, stream_exact: true }
        );
        expect(back).toHaveLength(3);
        expect(back.map((e) => e.id)).toEqual(committed.map((c) => c.id));
      });

      // ACT-1125 — compaction toggles + dry-run blocker scan + progress.

      it("drop_snapshots: skips SNAP_EVENT rows and counts them", async () => {
        const s = `restore-drop-snap-${uid()}`;
        const t = new Date("2020-10-01T00:00:00.000Z");
        const result = await store.restore!(
          asSource([
            row(1, s, 0, "Incremented", t, { amount: 1 }),
            {
              id: 2,
              stream: s,
              version: 1,
              name: SNAP_EVENT,
              data: { count: 1 },
              created: t,
              meta: { correlation: "snap", causation: {} },
            },
            row(3, s, 2, "Incremented", t, { amount: 2 }),
          ]),
          { drop_snapshots: true }
        );
        expect(result.kept).toBe(2);
        expect(result.dropped.snapshots).toBe(1);
        // Verify the snapshot is gone from the rebuilt store.
        const back = await collect(store, {
          stream: s,
          stream_exact: true,
          with_snaps: true,
        });
        expect(back).toHaveLength(2);
        expect(
          back.every((e) => (e as { name: string }).name !== SNAP_EVENT)
        ).toBe(true);
      });

      it("dry_run: validates without writing; store stays unchanged", async () => {
        // Pre-seed an event the dry-run must NOT touch.
        const original = `restore-pre-dry-${uid()}`;
        await store.commit<CounterEvents>(
          original,
          [inc(1)],
          makeMeta({ stream: original })
        );
        const s = `restore-dryrun-${uid()}`;
        const t = new Date("2020-11-01T00:00:00.000Z");
        // Pass on_progress so the dry-run path's row-by-row callback
        // is exercised in the same call.
        const progressCalls: number[] = [];
        const result = await store.restore!(
          asSource([
            row(1, s, 0, "Incremented", t, { amount: 1 }),
            row(2, s, 1, "Incremented", t, { amount: 2 }),
          ]),
          {
            dry_run: true,
            on_progress: (p) => progressCalls.push(p.processed),
            // Pass the default validator so blocker reporting is
            // exercised end-to-end through the option callback.
            validate: validateRestoreRow(),
          }
        );
        expect(result.dry_run).toBe(true);
        expect(result.kept).toBe(2);
        expect(result.errors).toHaveLength(0);
        expect(progressCalls).toEqual([1, 2]);
        // The pre-existing event must still be there — dry_run never wrote.
        const back = await collect(store, {
          stream: original,
          stream_exact: true,
        });
        expect(back).toHaveLength(1);
      });

      it("dry_run: reports duplicate id + version-contiguity gap + malformed created + negative version", async () => {
        const s = `restore-blockers-${uid()}`;
        const t = new Date("2020-12-01T00:00:00.000Z");
        const result = await store.restore!(
          asSource([
            row(1, s, 0, "Incremented", t, { amount: 1 }),
            row(1, s, 1, "Incremented", t, { amount: 2 }), // duplicate id
            row(3, s, 5, "Incremented", t, { amount: 3 }), // version gap (expected 2)
            row(4, s, -1, "Incremented", t, { amount: 4 }), // negative version
            {
              id: 5,
              stream: s,
              version: 7,
              name: "Incremented",
              data: { amount: 5 },
              // biome-ignore lint/suspicious/noExplicitAny: invalid input
              created: "not-a-date" as any,
              meta: { correlation: "c", causation: {} },
            },
          ]),
          { dry_run: true, validate: validateRestoreRow() }
        );
        const reasons = result.errors.map((e) => e.reason).join("\n");
        expect(reasons).toMatch(/Duplicate id: 1/);
        expect(reasons).toMatch(/Version gap on /);
        expect(reasons).toMatch(/Negative version: -1/);
        expect(reasons).toMatch(/Malformed created: not-a-date/);
      });

      it("dry_run without validate: empty errors (validation is caller-driven)", async () => {
        const s = `restore-no-validator-${uid()}`;
        const t = new Date("2021-04-01T00:00:00.000Z");
        const result = await store.restore!(
          asSource([row(1, s, 0, "Incremented", t, { amount: 1 })]),
          { dry_run: true }
        );
        expect(result.dry_run).toBe(true);
        expect(result.errors).toEqual([]);
      });

      it("live restore returns empty errors", async () => {
        const s = `restore-clean-${uid()}`;
        const t = new Date("2021-01-01T00:00:00.000Z");
        const result = await store.restore!(
          asSource([row(1, s, 0, "Incremented", t, { amount: 1 })])
        );
        expect(result.errors).toEqual([]);
      });

      it("on_progress fires once per row (caller throttles)", async () => {
        const calls: number[] = [];
        const s = `restore-progress-${uid()}`;
        const t = new Date("2021-02-01T00:00:00.000Z");
        await store.restore!(
          asSource([
            row(1, s, 0, "Incremented", t, { amount: 1 }),
            row(2, s, 1, "Incremented", t, { amount: 2 }),
          ]),
          { on_progress: (p) => calls.push(p.processed) }
        );
        // One callback per row; values monotonic.
        expect(calls).toEqual([1, 2]);
      });

      it("dry_run + drop_snapshots: both reported in the result", async () => {
        const s = `restore-dry-drop-${uid()}`;
        const t = new Date("2021-03-01T00:00:00.000Z");
        const result = await store.restore!(
          asSource([
            row(1, s, 0, "Incremented", t, { amount: 1 }),
            {
              id: 2,
              stream: s,
              version: 1,
              name: SNAP_EVENT,
              data: { count: 1 },
              created: t,
              meta: { correlation: "snap", causation: {} },
            },
          ]),
          { dry_run: true, drop_snapshots: true }
        );
        expect(result.dry_run).toBe(true);
        expect(result.kept).toBe(1);
        expect(result.dropped.snapshots).toBe(1);
      });
    });

    if (caps.notify) {
      describe("notify (capability)", () => {
        it("delivers a notification when a different instance commits", async () => {
          // Self-filtering contract: an instance does not see its own
          // commits. So we listen on `store` and write through a fresh
          // sibling instance pointing at the same backend.
          const notify = store.notify;
          expect(notify).toBeDefined();
          const received: StoreNotification[] = [];
          let resolveArrived!: () => void;
          const arrived = new Promise<void>((res) => {
            resolveArrived = res;
          });
          const disposer = await notify!.call(store, (n) => {
            received.push(n);
            resolveArrived();
          });
          const writer = await options.factory();
          try {
            const stream = `notify-${uid()}`;
            await writer.commit<CounterEvents>(
              stream,
              [inc(1)],
              makeMeta({ stream })
            );
            // No explicit timeout — vitest's default test timeout
            // bounds the wait. If notify silently fails to deliver,
            // the test will surface that as a clear timeout failure.
            await arrived;
            expect(received.length).toBeGreaterThanOrEqual(1);
            expect(received[0].stream).toBe(stream);
            expect(received[0].events.length).toBeGreaterThanOrEqual(1);
          } finally {
            await writer.dispose();
            await Promise.resolve(disposer());
          }
        });
      });
    }
  });
};
