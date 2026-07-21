import {
  act,
  ConcurrencyError,
  InMemoryCache,
  SNAP_EVENT,
  TOMBSTONE_EVENT,
  ValidationError,
} from "@rotorsoft/act";
import type {
  BlockedLease,
  Committed,
  EventSource,
  Lease,
  ScanOptions,
  ScanResult,
  Schemas,
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
  make_meta,
  reset as reset_event,
  seed_stream,
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
   * the cross-instance conformance cases: a listener receives commits
   * from a *sibling* instance produced by the same `factory`, never its
   * own commits (the port's self-filtering MUST), and exactly one
   * notification per commit transaction carrying the full event batch.
   * Requires the `factory` to produce instances sharing one backing
   * store — e.g. two PostgresStores on the same schema/table, or two
   * `withBroker` decorators on one broker. True cross-*process*
   * LISTEN/NOTIFY plumbing needs two processes and stays in the
   * adapter's own suite.
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
  /**
   * Adapter supports sensitive-data isolation (#566): accepts the
   * optional `pii` field on commit messages, returns it on load
   * outputs, and implements {@link Store.forget_pii}. When `true`,
   * the TCK runs the PII isolation suite — commit-with-pii
   * round-trip, commit-without-pii passthrough, `forget_pii` happy
   * path, idempotency, and isolation across streams.
   */
  readonly pii_isolation?: boolean;
  /**
   * Adapter supports competing consumers — two workers may call
   * `claim()` concurrently and the store hands each stream to at most
   * one of them (PostgreSQL via `FOR UPDATE SKIP LOCKED`; the in-memory
   * store via single-threaded atomic claim). When `true`, the TCK runs
   * the concurrency suite. Single-writer embedded stores (e.g. SQLite,
   * where concurrent write transactions raise `SQLITE_BUSY` rather than
   * serializing) leave this `false`: their deployment model is a single
   * drain worker per database file.
   */
  readonly concurrent_claim?: boolean;
  /**
   * Adapter implements the {@link QueryStreams.source_matches} reverse-
   * match filter — "subscriptions whose stored `source` pattern matches
   * at least one of these names" (`name ~ source`). When `true`, the TCK
   * runs the `source_matches` suite. Stores that can't express reverse-
   * regex (e.g. an anchor-aware `LIKE` approximation) leave it `false`;
   * the close-cycle safety probe then falls back to an unfiltered scan,
   * so correctness never depends on this flag — only probe cost.
   */
  readonly source_matches?: boolean;
  /**
   * Adapter matches a **pattern** reaction `source` (one carrying regex
   * metacharacters, e.g. the calculator's `^(A|B)$`) as a full RegExp in
   * claim()'s has-work probe, so a stream whose max event id exceeds the
   * subscription watermark is claimed when its name matches the pattern.
   * When `true`, the TCK runs the pattern-source claim suite. Literal
   * sources stay exact everywhere regardless of this flag — the fast,
   * index-friendly path.
   *
   * Stores that cannot run an arbitrary regex against candidate streams
   * (e.g. SQLite, whose libsql build has no `REGEXP` and whose portable
   * `LIKE` grammar cannot express alternation/grouping) leave this
   * `false` and instead reject a non-portable claim source at
   * {@link subscribe} time — see {@link rejects_nonportable_claim_source}.
   */
  readonly pattern_claim_source?: boolean;
  /**
   * Adapter cannot faithfully match every regex claim `source`, so it
   * fails loud at registration: {@link subscribe} throws
   * {@link ValidationError} for a source outside its portable subset
   * (alternation/grouping like `^(A|B)$`), rather than silently never
   * claiming the stream. When `true`, the TCK runs the reject-at-subscribe
   * case. Currently only SQLite sets this — its message points operators
   * to InMemory/PG for full regex claim sources.
   */
  readonly rejects_nonportable_claim_source?: boolean;
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
 * - stream filter grammar — the portable regex subset (`^`, `$`, `.`,
 *   `.*`, literal characters) matches identically everywhere; richer
 *   patterns either match with full regex semantics or throw
 *   `ValidationError` — never a silent approximation
 * - `subscribe` — idempotent re-subscribe, watermark return value
 * - `claim` / `ack` — lease lifecycle, dual frontiers, leased streams
 *   not double-claimed, exact-source has-work matching, timed-out-lease
 *   retry accounting
 * - `block` — blocked streams hidden from claim, only same-drainer can block
 * - `reset` — restart watermarks (including blocked), no-op for missing
 * - `prioritize` — bulk priority updates by filter
 * - `truncate` — snapshot vs tombstone seeding, empty inputs, missing
 *   streams; windowed boundaries (`before`/`max_id`) — prefix deleted
 *   behind the closest safe snapshot, tail + subscriptions kept,
 *   no-snapshot no-op, mixed full + windowed targets
 * - `query_streams` — filters, exact-match, pagination, blocked
 * - `notify` (capability-gated) — cross-instance delivery, self-filtering
 *   (an instance never receives its own commits), one notification per
 *   commit transaction with the full event batch
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
          make_meta({ stream: s })
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
          make_meta({ stream: s, correlation })
        );
        expect(committed[0].stream).toBe(s);
        expect(committed[0].meta.correlation).toBe(correlation);
      });

      it("throws ConcurrencyError when expectedVersion is wrong", async () => {
        const s = `commit-cc-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s }),
          0
        );
        await expect(
          store.commit<CounterEvents>(s, [inc(1)], make_meta({ stream: s }), 0)
        ).rejects.toBeInstanceOf(ConcurrencyError);
      });

      it("preserves prior events when a concurrent commit is rejected", async () => {
        const s = `commit-cc-preserve-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2)],
          make_meta({ stream: s })
        );
        await expect(
          store.commit<CounterEvents>(s, [inc(3)], make_meta({ stream: s }), 0)
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
          make_meta({ stream: s1, correlation: cor })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(2), dec(2), reset_event()],
          make_meta({ stream: s2, correlation: cor })
        );

        const by_stream = await collect(store, {
          stream: s1,
          stream_exact: true,
        });
        expect(by_stream).toHaveLength(2);

        const by_name = await collect(store, {
          stream: s2,
          stream_exact: true,
          names: ["Reset"],
        });
        expect(by_name).toHaveLength(1);
        expect(by_name[0].name).toBe("Reset");

        const by_correlation = await collect(store, { correlation: cor });
        expect(by_correlation).toHaveLength(5);

        const limited = await collect(store, {
          correlation: cor,
          limit: 2,
        });
        expect(limited).toHaveLength(2);
      });

      it("with_snaps resumes from the latest snapshot per stream", async () => {
        const s = `q-snap-${uid()}`;
        // 2 pre-snapshot domain events ...
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(1)],
          make_meta({ stream: s })
        );
        // ... a snapshot ...
        const [snap] = await store.commit(
          s,
          [{ name: SNAP_EVENT, data: { count: 2 } }],
          make_meta({ stream: s })
        );
        // ... and 3 events after it.
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(1), inc(1)],
          make_meta({ stream: s })
        );

        // with_snaps resumes AT the latest snapshot: snapshot + the 3 after
        // it, never the 2 pre-snapshot events.
        const from_snap = await collect(store, {
          stream: s,
          stream_exact: true,
          with_snaps: true,
        });
        expect(from_snap).toHaveLength(4);
        expect(from_snap[0].name).toBe(SNAP_EVENT);

        // Without with_snaps: the 5 domain events, snapshot excluded.
        const domain = await collect(store, { stream: s, stream_exact: true });
        expect(domain).toHaveLength(5);

        // An explicit `after` overrides the snapshot floor.
        const after_snap = await collect(store, {
          stream: s,
          stream_exact: true,
          with_snaps: true,
          after: snap.id,
        });
        expect(after_snap).toHaveLength(3);

        // A stream with no snapshot returns its full history under with_snaps.
        const s2 = `q-nosnap-${uid()}`;
        await store.commit<CounterEvents>(
          s2,
          [inc(1), inc(1)],
          make_meta({ stream: s2 })
        );
        const full = await collect(store, {
          stream: s2,
          stream_exact: true,
          with_snaps: true,
        });
        expect(full).toHaveLength(2);
      });

      it("with_snaps applies the resume floor on a backward scan too", async () => {
        const s = `q-snap-back-${uid()}`;
        // 2 pre-snapshot events, a snapshot, then 3 after it.
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(1)],
          make_meta({ stream: s })
        );
        const [snap] = await store.commit(
          s,
          [{ name: SNAP_EVENT, data: { count: 2 } }],
          make_meta({ stream: s })
        );
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(1), inc(1)],
          make_meta({ stream: s })
        );

        // The floor is direction-agnostic: forward resumes AT the snapshot,
        // backward stops AT it. Either way, only the snapshot + the 3 events
        // after it — never the 2 pre-snapshot events.
        const backward = await collect(store, {
          stream: s,
          stream_exact: true,
          with_snaps: true,
          backward: true,
        });
        expect(backward).toHaveLength(4);
        // DESC → the snapshot (lowest id in the floored set) comes last.
        expect(backward[backward.length - 1].name).toBe(SNAP_EVENT);
        expect(backward.every((e) => e.id >= snap.id)).toBe(true);

        // No snapshot → full history under with_snaps + backward.
        const s2 = `q-nosnap-back-${uid()}`;
        await store.commit<CounterEvents>(
          s2,
          [inc(1), inc(1)],
          make_meta({ stream: s2 })
        );
        const full = await collect(store, {
          stream: s2,
          stream_exact: true,
          with_snaps: true,
          backward: true,
        });
        expect(full).toHaveLength(2);
      });

      it("supports backward traversal", async () => {
        const s = `q-back-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2), inc(3)],
          make_meta({ stream: s })
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
          make_meta({ stream: s })
        );
        const after_first = await collect(store, {
          stream: s,
          stream_exact: true,
          after: committed[0].id,
        });
        expect(after_first.map((e) => e.id)).toEqual(
          committed.slice(1).map((c) => c.id)
        );
        const before_last = await collect(store, {
          stream: s,
          stream_exact: true,
          before: committed[committed.length - 1].id,
        });
        expect(before_last.map((e) => e.id)).toEqual(
          committed.slice(0, -1).map((c) => c.id)
        );
      });

      // #1199: `names: []` means "match no event names" on every adapter.
      // An empty allow-list is an explicit "nothing passes" — the opposite
      // of an omitted `names` (which matches all). PG historically dropped
      // the empty filter (returned ALL); this pins the sane semantics.
      it("names:[] matches no events", async () => {
        const s = `q-names-empty-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1), dec(1)],
          make_meta({ stream: s })
        );
        const none = await collect(store, {
          stream: s,
          stream_exact: true,
          names: [],
        });
        expect(none).toHaveLength(0);
        // Omitting `names` still returns everything — the contrast case.
        const all = await collect(store, { stream: s, stream_exact: true });
        expect(all).toHaveLength(2);
      });

      // #1199: falsy-zero `after`/`before` are honored, not dropped by a
      // truthy guard. `after: 0` means strictly "id > 0"; `before: 0`
      // means strictly "id < 0" (matches nothing). InMemory ids start at
      // 0, so a truthy `if (after)` guard would leak id 0 on the backward
      // path — this pins `!== undefined` semantics across adapters.
      it("after:0 and before:0 are honored as id bounds", async () => {
        const s = `q-zero-bound-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2), inc(3)],
          make_meta({ stream: s })
        );
        // before:0 → nothing has an id below 0.
        expect(
          await collect(store, { stream: s, stream_exact: true, before: 0 })
        ).toHaveLength(0);
        // before:0 on the backward path is equally empty.
        expect(
          await collect(store, {
            stream: s,
            stream_exact: true,
            before: 0,
            backward: true,
          })
        ).toHaveLength(0);
        // after:0 → strictly id > 0. On adapters whose ids start at 0 the
        // first event (id 0) is excluded; on 1-based adapters every event
        // survives. Either way no event with id <= 0 is returned.
        const forward = await collect(store, {
          stream: s,
          stream_exact: true,
          after: 0,
        });
        expect(forward.every((e) => e.id > 0)).toBe(true);
        // Backward path with after:0 must apply the same exclusive bound —
        // never leak an id-0 event.
        const backward = await collect(store, {
          stream: s,
          stream_exact: true,
          after: 0,
          backward: true,
        });
        expect(backward.every((e) => e.id > 0)).toBe(true);
      });

      it("created_after/created_before filter by timestamp", async () => {
        const s = `q-ts-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        // Build the window from the event's OWN `created` (whatever clock
        // the store stamped it with) so the assertion can't flake on a
        // skew between the store's clock and the test runner's clock.
        const ts = committed[0].created.getTime();
        const before = new Date(ts - 60_000);
        const future = new Date(ts + 60_000);
        const in_window = await collect(store, {
          stream: s,
          stream_exact: true,
          created_after: before,
          created_before: future,
        });
        expect(in_window.length).toBe(1);
        const out_of_window = await collect(store, {
          stream: s,
          stream_exact: true,
          created_after: future,
        });
        expect(out_of_window.length).toBe(0);
      });

      it("backward traversal short-circuits at `after` id boundary", async () => {
        const s = `q-back-after-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2), inc(3)],
          make_meta({ stream: s })
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
        // `make_meta()` with no stream — exercises the meta builder's
        // no-causation branch alongside the backward + created_before
        // path inside the adapter.
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta()
        );
        // `created_before` strictly before the event's own timestamp, so
        // it must be skipped — relative to the store's clock, not the
        // host's, to avoid clock-skew flakiness.
        const past = new Date(committed[0].created.getTime() - 60_000);
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
        await store.commit<CounterEvents>(
          a,
          [inc(1)],
          make_meta({ stream: a })
        );
        await store.commit<CounterEvents>(
          b,
          [inc(2)],
          make_meta({ stream: b })
        );
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
          make_meta({ stream: inner })
        );
        await store.commit<CounterEvents>(
          longer,
          [inc(2)],
          make_meta({ stream: longer })
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
          make_meta({ stream: inner })
        );
        await store.commit<CounterEvents>(
          longer,
          [inc(2)],
          make_meta({ stream: longer })
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
        await store.commit<CounterEvents>(
          a,
          [inc(1)],
          make_meta({ stream: a })
        );
        await store.commit<CounterEvents>(
          b,
          [inc(2)],
          make_meta({ stream: b })
        );
        await store.commit<CounterEvents>(
          other,
          [inc(3)],
          make_meta({ stream: other })
        );
        const got = await collect(store, { stream: `^qr-${tag}-pfx-` });
        expect(got.map((e) => e.stream).sort()).toEqual([a, b].sort());
      });
    });

    // Stream-filter grammar conformance. The portable subset — `^` / `$`
    // anchors, `.` (any single character), `.*` (any run), and literal
    // characters — must produce identical matches on every adapter
    // (PG POSIX `~`, InMemory `RegExp`, SQLite anchor-aware `LIKE`).
    // Richer regex is adapter-optional: an adapter either matches it
    // with full regex semantics or throws `ValidationError`. Silently
    // returning wrong rows (e.g. from a lossy LIKE approximation) is a
    // contract violation — and the worst one available when the filter
    // drives `reset` / `unblock`.
    describe("stream filter grammar", () => {
      const seed_streams = async (streams: string[]) => {
        for (const s of streams)
          await store.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
      };

      const streams_matching = async (pattern: string) =>
        (await collect(store, { stream: pattern })).map((e) => e.stream).sort();

      // A non-portable pattern must never silently mis-match: the store
      // either returns exactly the full-regex-semantics result set or
      // throws ValidationError at the call site.
      const match_exactly_or_throw = async (
        pattern: string,
        expected: string[]
      ) => {
        let matched: string[] | undefined;
        let error: unknown;
        try {
          matched = await streams_matching(pattern);
        } catch (e) {
          error = e;
        }
        if (error !== undefined) expect(error).toBeInstanceOf(ValidationError);
        else expect(matched).toEqual(expected.sort());
      };

      it("portable subset: anchors, `.`, and `.*` match identically", async () => {
        const tag = uid();
        const plain = `g-${tag}-plain`;
        const dotted = `g-${tag}.dot`;
        const scored = `g-${tag}_us`;
        const pct = `g-${tag}%pc`;
        await seed_streams([plain, dotted, scored, pct]);

        // ^prefix — all four, regex-significant literals included
        expect(await streams_matching(`^g-${tag}`)).toEqual(
          [plain, dotted, scored, pct].sort()
        );
        // suffix$ — one
        expect(await streams_matching(`${tag}-plain$`)).toEqual([plain]);
        // ^exact$ — one
        expect(await streams_matching(`^g-${tag}-plain$`)).toEqual([plain]);
        // single `.` is a one-character wildcard: matches the literal
        // dot in `dotted` and the `-` in `plain`
        expect(await streams_matching(`^g-${tag}.dot$`)).toEqual([dotted]);
        expect(await streams_matching(`^g-${tag}.plain$`)).toEqual([plain]);
        // `.*` — any run
        expect(await streams_matching(`^g-${tag}.*dot$`)).toEqual([dotted]);
      });

      it("literal `_` and `%` in patterns are not wildcards", async () => {
        const tag = uid();
        const scored = `u-${tag}_x`;
        const scored_decoy = `u-${tag}Zx`;
        const pct = `p-${tag}%y`;
        const pct_decoy = `p-${tag}ZZy`;
        await seed_streams([scored, scored_decoy, pct, pct_decoy]);

        // `_` is a literal in the regex grammar — a store translating to
        // LIKE must escape it or it single-char-wildcards into the decoy
        expect(await streams_matching(`^u-${tag}_x$`)).toEqual([scored]);
        // `%` is a literal in the regex grammar — unescaped LIKE would
        // any-run-wildcard into the decoy
        expect(await streams_matching(`^p-${tag}%y$`)).toEqual([pct]);
      });

      it("portable subset applies to stream-position filters", async () => {
        const tag = uid();
        const scored = `sf-${tag}_a`;
        const decoy = `sf-${tag}Za`;
        await store.subscribe([{ stream: scored }, { stream: decoy }]);

        const got: string[] = [];
        await store.query_streams((p) => got.push(p.stream), {
          stream: `^sf-${tag}_a$`,
        });
        expect(got).toEqual([scored]);
      });

      it("non-portable patterns match with full regex semantics or throw", async () => {
        const tag = uid();
        const a = `np-${tag}-a`;
        const b = `np-${tag}-b`;
        const c = `np-${tag}-c`;
        const one = `np-${tag}-1`;
        const aaa = `np-${tag}-aaa`;
        const dot = `e-${tag}.d`;
        const dot_decoy = `e-${tag}xd`;
        await seed_streams([a, b, c, one, aaa, dot, dot_decoy]);

        // alternation
        await match_exactly_or_throw(`^np-${tag}-(a|b)$`, [a, b]);
        // character class
        await match_exactly_or_throw(`^np-${tag}-[0-9]$`, [one]);
        // quantifier
        await match_exactly_or_throw(`^np-${tag}-a+$`, [a, aaa]);
        // escaped dot — a literal-dot match, not a one-char wildcard
        await match_exactly_or_throw(`^e-${tag}\\.d$`, [dot]);
      });

      it("bulk stream ops reject non-portable filters instead of mis-matching", async () => {
        const tag = uid();
        const s = `bo-${tag}-a`;
        await store.subscribe([{ stream: s }]);

        let count: number | undefined;
        let error: unknown;
        try {
          count = await store.reset({ stream: `^bo-${tag}-(a|b)$` });
        } catch (e) {
          error = e;
        }
        if (error !== undefined) expect(error).toBeInstanceOf(ValidationError);
        else expect(count).toBe(1);
      });

      // #1197: stream filters are case-SENSITIVE across every adapter.
      // PG (`~`) and InMemory (RegExp) are case-sensitive; a store that
      // translates to `LIKE` must not let SQLite's ASCII-insensitive LIKE
      // overmatch a differently-cased sibling. A `^order-` prefix must
      // match `order-x` but never `Order-x`.
      it("stream filters match case-sensitively (query)", async () => {
        const tag = uid();
        const lower = `order-${tag}`;
        const upper = `Order-${tag}`;
        await seed_streams([lower, upper]);

        // ^prefix — only the lower-cased stream, never the capitalized one
        expect(await streams_matching(`^order-${tag}`)).toEqual([lower]);
        // ^exact$ — the capitalized name never matches a lower-cased pattern
        expect(await streams_matching(`^Order-${tag}$`)).toEqual([upper]);
        // contains — case-sensitive substring
        expect(await streams_matching(`order-${tag}`)).toEqual([lower]);
      });

      it("stream filters match case-sensitively (position filters)", async () => {
        const tag = uid();
        const lower = `csp-order-${tag}`;
        const upper = `csp-Order-${tag}`;
        await store.subscribe([{ stream: lower }, { stream: upper }]);

        const got: string[] = [];
        await store.query_streams((p) => got.push(p.stream), {
          stream: `^csp-order-${tag}`,
        });
        expect(got).toEqual([lower]);
      });

      it("bulk stream ops match case-sensitively", async () => {
        const tag = uid();
        const lower = `bcs-order-${tag}`;
        const upper = `bcs-Order-${tag}`;
        await store.subscribe([{ stream: lower }, { stream: upper }]);

        // reset by pattern touches only the exactly-cased stream
        const count = await store.reset({ stream: `^bcs-order-${tag}` });
        expect(count).toBe(1);
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

      // Backs the port-doc contract on `subscribe`'s `priority` param:
      // "When the same stream is subscribed by multiple reactions with
      // different priorities, implementations must keep the maximum so
      // the highest-priority reaction wins." Without this test the merge
      // could silently regress to last-write-wins on any adapter.
      it("keeps the maximum priority when a stream is re-subscribed", async () => {
        const s = `sub-pri-${uid()}`;
        const read = async () => {
          const got: { priority?: number } = {};
          await store.query_streams(
            (p) => {
              got.priority = p.priority;
            },
            { stream: s, stream_exact: true }
          );
          return got.priority;
        };

        await store.subscribe([{ stream: s, priority: 3 }]);
        expect(await read()).toBe(3);

        // Higher priority wins.
        await store.subscribe([{ stream: s, priority: 10 }]);
        expect(await read()).toBe(10);

        // Lower priority must NOT lower the stored value.
        await store.subscribe([{ stream: s, priority: 1 }]);
        expect(await read()).toBe(10);

        // Default priority (0, omitted) must NOT lower it either.
        await store.subscribe([{ stream: s }]);
        expect(await read()).toBe(10);
      });

      it("claims a subscribed stream and ack releases the lease", async () => {
        const s = `claim-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
          make_meta({ stream: other })
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
          make_meta({ stream: s })
        );
        const first = await store.claim(100, 0, `w-${uid()}`, 1);
        const mine = first.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        await store.ack([{ ...(mine as Lease), at: (mine as Lease).at + 1 }]);
        const second = await store.claim(0, 100, `w-${uid()}`, 1);
        expect(second.find((l) => l.stream === s)).toBeDefined();
      });

      it("does not starve a default-priority lagging stream under sustained high-priority load (ACT-1223)", async () => {
        // A fresh adapter so only these streams compete for the frontier.
        // Six priority-100 streams that always have fresh work plus one
        // never-processed priority-0 stream. The lagging selection orders
        // by priority DESC, at ASC, so without a fairness reserve the four
        // lagging slots are forever taken by the high-priority streams and
        // the low one starves. The reserve (ACT-1223) carves one slot for
        // pure watermark order, so the most-behind stream is claimed within
        // a bounded window regardless of priority.
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const suffix = uid();
          const highs = Array.from(
            { length: 6 },
            (_, i) => `hi-${i}-${suffix}`
          );
          const low = `lo-${suffix}`;
          await fresh.subscribe([
            ...highs.map((stream) => ({ stream, priority: 100 })),
            { stream: low, priority: 0 },
          ]);
          for (const stream of highs)
            await fresh.commit<CounterEvents>(
              stream,
              [inc(1)],
              make_meta({ stream })
            );
          await fresh.commit<CounterEvents>(
            low,
            [inc(1)],
            make_meta({ stream: low })
          );

          const by = `w-${uid()}`;
          let low_claimed = false;
          const MAX_CYCLES = 20;
          for (let cycle = 0; cycle < MAX_CYCLES && !low_claimed; cycle++) {
            const leases = await fresh.claim(4, 0, by, 1000);
            if (leases.some((l) => l.stream === low)) {
              low_claimed = true;
              break;
            }
            // Ack each high stream forward, then commit a fresh event so it
            // is lagging again next cycle — sustained high-priority load.
            for (const l of leases) {
              await fresh.ack([{ ...l, at: l.at + 1 }]);
              await fresh.commit<CounterEvents>(
                l.stream,
                [inc(1)],
                make_meta({ stream: l.stream })
              );
            }
          }

          expect(low_claimed).toBe(true);
        } finally {
          await fresh.dispose();
        }
      });

      it("dedupes when both frontiers would return the same stream", async () => {
        const s = `claim-dedup-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await store.commit<CounterEvents>(
          sibling,
          [inc(2)],
          make_meta({ stream: sibling })
        );
        const leased = await store.claim(100, 0, `right-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        const sibling_lease = leased.find((l) => l.stream === sibling);
        expect(mine).toBeDefined();
        expect(sibling_lease).toBeDefined();
        // Mix a correctly-held lease with an imposter ack so `acked`
        // ends up with one entry (the sibling) and the predicate runs.
        const acked = await store.ack([
          { ...(mine as Lease), by: "imposter" },
          sibling_lease as Lease,
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

    // ACT-980: the TCK previously asserted only the *shape* of claim()
    // results, letting adapters diverge on `Lease.retry` and `Lease.lagging`
    // — the two signals the drain controller reads to time `blockOnError`
    // and to balance frontiers. These cases pin the *semantics* so every
    // adapter is interchangeable, not merely structurally conformant.
    describe("lease semantics", () => {
      // Frontier budgets (`lagging`/`leading`) apply across every claimable
      // stream in the store, so these cases run against a fresh, isolated
      // instance with exactly one subscribed stream — that makes the
      // budgets deterministic regardless of what the shared suite left
      // behind.
      it("returns retry=0 on first claim and increments on re-claim without ack", async () => {
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const s = `lease-retry-${uid()}`;
          await fresh.subscribe([{ stream: s }]);
          await fresh.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
          // First claim = first attempt. A 0ms lease is released
          // immediately, so the re-claim below sees a claimable stream
          // deterministically (no wall-clock race on lease expiry).
          const first = await fresh.claim(1, 0, `w-${uid()}`, 0);
          const f = first.find((l) => l.stream === s);
          expect(f).toBeDefined();
          expect(f!.retry).toBe(0);
          // Re-claim without an intervening ack = the first retry.
          const second = await fresh.claim(1, 0, `w-${uid()}`, 100_000);
          const sec = second.find((l) => l.stream === s);
          expect(sec).toBeDefined();
          expect(sec!.retry).toBe(1);
        } finally {
          await fresh.dispose();
        }
      });

      it("reports lagging=true from the lagging frontier and false from the leading frontier", async () => {
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const s = `lease-lag-${uid()}`;
          await fresh.subscribe([{ stream: s }]);
          await fresh.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
          // Lagging-only budget: the stream is claimed from the lagging
          // frontier → lagging must be true.
          const lag = await fresh.claim(1, 0, `w-${uid()}`, 0);
          expect(lag.find((l) => l.stream === s)?.lagging).toBe(true);
          // Leading-only budget on the released lease: claimed from the
          // leading frontier → lagging must be false. `lagging` is
          // frontier membership, not a function of the stream's watermark.
          const lead = await fresh.claim(0, 1, `w-${uid()}`, 100_000);
          expect(lead.find((l) => l.stream === s)?.lagging).toBe(false);
        } finally {
          await fresh.dispose();
        }
      });

      // ACT-1183: a lease timeout is not a free pass. Every claim()
      // increments the stream's retry counter and only ack resets it, so
      // a stream whose workers keep dying marches toward `blockOnError`
      // exactly like one whose handlers keep throwing — repeated worker
      // deaths on one stream are poison-adjacent, and quarantining beats
      // an infinite crash loop. The 0ms lease is the deterministic
      // stand-in for "worker died mid-lease" (no wall-clock race).
      it("counts a timed-out lease reclaimed by another worker against the retry budget; ack resets it", async () => {
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const s = `lease-timeout-${uid()}`;
          await fresh.subscribe([{ stream: s }]);
          const [e1] = await seed_stream(fresh, s, 1);
          // Worker A claims and "dies" — its 0ms lease is already expired.
          const a = await fresh.claim(1, 0, `wA-${uid()}`, 0);
          expect(a.find((l) => l.stream === s)?.retry).toBe(0);
          // Worker B reclaims after the timeout: the budget marches.
          const b = await fresh.claim(1, 0, `wB-${uid()}`, 30_000);
          const b_lease = b.find((l) => l.stream === s);
          expect(b_lease).toBeDefined();
          expect(b_lease!.retry).toBe(1);
          // Ack resets the budget: the next claim is a first attempt again.
          await fresh.ack([{ ...(b_lease as Lease), at: e1.id }]);
          await seed_stream(fresh, s, 1);
          const c = await fresh.claim(1, 0, `wC-${uid()}`, 30_000);
          expect(c.find((l) => l.stream === s)?.retry).toBe(0);
        } finally {
          await fresh.dispose();
        }
      });
    });

    // ACT-1182: a subscription's `source` is an **exact stream name** in
    // claim()'s has-work probe — never a regex, LIKE pattern, or substring.
    // Every shipped resolver (autoclose, dynamic per-aggregate reactions)
    // produces exact names, and exact equality keeps the probe on the
    // adapter's stream index. Pattern matching belongs to the StreamFilter
    // surfaces (`query_streams`, `reset`, `unblock`), not to claim. Before
    // these cases, InMemory compiled `source` into an unanchored RegExp and
    // SQLite into a contains-LIKE — both silently overmatched sibling
    // streams sharing a prefix.
    describe("claim source matching", () => {
      it("treats source as an exact stream name — no substring or pattern overmatch", async () => {
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const base = `src-${uid()}`;
          const sibling = `${base}2`; // `base` is a strict prefix of `sibling`
          const target = `agg-${uid()}`;
          const control = `ctl-${uid()}`;
          await fresh.subscribe([
            { stream: target, source: base },
            // Control subscription sourced from the sibling — it DOES see
            // the sibling commit below, so the negative assertion runs
            // through a populated claim result.
            { stream: control, source: sibling },
          ]);
          // Advance the watermarks past -1 first — fresh subscriptions are
          // claimable unconditionally on some adapters.
          const [seeded] = await seed_stream(fresh, base, 1);
          const [ctl_seeded] = await seed_stream(fresh, sibling, 1);
          const first = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
          const mine = first.find((l) => l.stream === target);
          const ctl = first.find((l) => l.stream === control);
          expect(mine).toBeDefined();
          expect(ctl).toBeDefined();
          await fresh.ack([
            { ...(mine as Lease), at: seeded.id },
            { ...(ctl as Lease), at: ctl_seeded.id },
          ]);
          // New events land only on the *sibling* stream. An exact-source
          // subscription on `base` must not see them as work; the control
          // sourced from the sibling must.
          await seed_stream(fresh, sibling, 1);
          const second = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
          expect(second.find((l) => l.stream === control)).toBeDefined();
          expect(second.find((l) => l.stream === target)).toBeUndefined();
        } finally {
          await fresh.dispose();
        }
      });

      it("receives exactly its source stream's events", async () => {
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const base = `src-${uid()}`;
          const target = `agg-${uid()}`;
          await fresh.subscribe([{ stream: target, source: base }]);
          const [e1] = await seed_stream(fresh, base, 1);
          const first = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
          const f = first.find((l) => l.stream === target);
          expect(f).toBeDefined();
          expect(f!.source).toBe(base);
          await fresh.ack([{ ...(f as Lease), at: e1.id }]);
          // A fresh commit on the exact source makes the stream claimable
          // again, and the fetch window (source + after watermark) yields
          // exactly the new event.
          const [e2] = await seed_stream(fresh, base, 1);
          const second = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
          const sec = second.find((l) => l.stream === target);
          expect(sec).toBeDefined();
          expect(sec!.at).toBe(e1.id);
          const events = await collect(fresh, {
            stream: sec!.source,
            after: sec!.at,
          });
          expect(events.map((e) => e.id)).toEqual([e2.id]);
        } finally {
          await fresh.dispose();
        }
      });

      // ACT-1220: an exact (literal) source must never fetch events from a
      // sibling stream sharing its prefix. Guards the drain fetch path: an
      // exact source `s1` claimed as work must, when queried, receive only
      // `s1`'s events — not `s12`'s. Pre-#1215 fetch treated `source` as an
      // unanchored regex, so `s1` would have pulled `s12`'s events into the
      // handler.
      it("fetches only the exact source stream's events, never a sibling prefix", async () => {
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const base = `fx-${uid()}`;
          const sibling = `${base}2`;
          const target = `agg-${uid()}`;
          await fresh.subscribe([{ stream: target, source: base }]);
          const [b1] = await seed_stream(fresh, base, 1);
          await seed_stream(fresh, sibling, 1);
          const claimed = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
          const lease = claimed.find((l) => l.stream === target);
          expect(lease).toBeDefined();
          const events = await collect(fresh, {
            stream: lease!.source,
            stream_exact: true,
            after: -1,
          });
          expect(events.map((e) => e.stream)).toEqual([base]);
          expect(events.map((e) => e.id)).toEqual([b1.id]);
        } finally {
          await fresh.dispose();
        }
      });
    });

    // ACT-1220: a **pattern** source (one carrying regex metacharacters) is
    // matched as a full RegExp against candidate streams. This restores the
    // calculator's shipped `source: "^(A|B)$"` static reaction, which
    // #1215's exact-only claim contract silently broke — the Board
    // projection stopped being claimed because `_max_event_id_by_stream.get(
    // "^(A|B)$")` is always undefined. Literal sources keep the fast exact
    // path; only sources with metacharacters compile to a RegExp.
    describe.skipIf(!caps.pattern_claim_source)(
      "claim pattern source matching (capability)",
      () => {
        it("claims a pattern-source target when any matched stream has work (^(A|B)$)", async () => {
          const fresh = await options.factory();
          try {
            await fresh.drop();
            await fresh.seed();
            const a = `A-${uid()}`;
            const b = `B-${uid()}`;
            const target = `board-${uid()}`;
            const pattern = `^(${a}|${b})$`;
            await fresh.subscribe([{ stream: target, source: pattern }]);
            // Commit to A only — the pattern must match it and claim.
            const [ea] = await seed_stream(fresh, a, 1);
            const first = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
            const l1 = first.find((s) => s.stream === target);
            expect(l1).toBeDefined();
            await fresh.ack([{ ...(l1 as Lease), at: ea.id }]);
            // Now commit to B — the same pattern-source target must claim
            // again for the second matched stream.
            const [eb] = await seed_stream(fresh, b, 1);
            const second = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
            expect(second.find((s) => s.stream === target)).toBeDefined();
            expect(eb.stream).toBe(b);
          } finally {
            await fresh.dispose();
          }
        });

        it("does not claim a pattern-source target when no matched stream has work", async () => {
          const fresh = await options.factory();
          try {
            await fresh.drop();
            await fresh.seed();
            const a = `A-${uid()}`;
            const b = `B-${uid()}`;
            const other = `Z-${uid()}`;
            const target = `board-${uid()}`;
            const control = `ctl-${uid()}`;
            const pattern = `^(${a}|${b})$`;
            // The control target sources from `other` (a literal). It DOES
            // see the `other` commit below, so the second claim is
            // non-empty and the negative assertion runs through a
            // populated result — the pattern target must simply be absent.
            await fresh.subscribe([
              { stream: target, source: pattern },
              { stream: control, source: other },
            ]);
            // Advance the target's watermark past -1 first: a fresh
            // subscription is claimable unconditionally on some adapters,
            // so the negative assertion must run against a settled stream.
            const [ea] = await seed_stream(fresh, a, 1);
            const first = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
            const l1 = first.find((s) => s.stream === target);
            expect(l1).toBeDefined();
            // Ack both the pattern target and the fresh control lease so
            // neither is held into the second claim; the control becomes
            // claimable again only when `other` gets a commit below. Both
            // are fresh subscriptions, so both are in the first claim.
            const c1 = first.find((s) => s.stream === control);
            expect(c1).toBeDefined();
            await fresh.ack([
              { ...(l1 as Lease), at: ea.id },
              { ...(c1 as Lease), at: -1 },
            ]);
            // Now activity on a stream the pattern does NOT match must not
            // make the target claimable again — but the control sourced
            // from that stream must.
            await seed_stream(fresh, other, 1);
            const claimed = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
            const streams = claimed.map((s) => s.stream);
            expect(streams).toContain(control);
            expect(streams).not.toContain(target);
          } finally {
            await fresh.dispose();
          }
        });
      }
    );

    // ACT-1220: adapters that cannot faithfully run an arbitrary regex in
    // claim reject a non-portable claim source loudly at subscribe() —
    // failing at registration, not silently never claiming the stream.
    describe.skipIf(!caps.rejects_nonportable_claim_source)(
      "claim source registration (capability)",
      () => {
        it("throws at subscribe for a non-portable (alternation) claim source", async () => {
          const fresh = await options.factory();
          try {
            await fresh.drop();
            await fresh.seed();
            await expect(
              fresh.subscribe([
                { stream: `board-${uid()}`, source: `^(${uid()}|${uid()})$` },
              ])
            ).rejects.toThrow(ValidationError);
          } finally {
            await fresh.dispose();
          }
        });

        it("accepts a portable-subset pattern claim source (^prefix.*) and claims on match", async () => {
          const fresh = await options.factory();
          try {
            await fresh.drop();
            await fresh.seed();
            const prefix = `pfx${uid()}`.replace(/-/g, "");
            const matched = `${prefix}child`;
            const target = `board-${uid()}`;
            await fresh.subscribe([{ stream: target, source: `^${prefix}.*` }]);
            const [e] = await seed_stream(fresh, matched, 1);
            const claimed = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
            expect(claimed.find((s) => s.stream === target)).toBeDefined();
            expect(e.stream).toBe(matched);
          } finally {
            await fresh.dispose();
          }
        });
      }
    );

    // ACT-982: competing-consumer correctness was previously proven only by
    // the PG-specific multi-process stress harness. This makes it a portable
    // contract for adapters that support concurrent claimers (gated by
    // `concurrent_claim`): two distinct workers claiming the same candidate
    // set concurrently must never both lease the same stream within the
    // lease window. Single-writer stores (SQLite) opt out — see the
    // capability docs.
    describe.skipIf(!caps.concurrent_claim)("concurrency (capability)", () => {
      it("never double-leases a stream across concurrent claimers", async () => {
        // Fresh isolated instance: the two workers below claim with large
        // budgets across every claimable stream, so a shared store would
        // both perturb this test and leave 60s leases that pollute later
        // suites. Mirrors the lease-semantics cases.
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const streams = Array.from(
            { length: 8 },
            () => `concurrent-${uid()}`
          );
          await fresh.subscribe(streams.map((stream) => ({ stream })));
          for (const stream of streams) {
            await fresh.commit<CounterEvents>(
              stream,
              [inc(1)],
              make_meta({ stream })
            );
          }
          const owned = new Set(streams);
          // Overlapping budgets so both workers target the same set;
          // SKIP LOCKED (pg) / atomic lease (in-memory) must hand each
          // stream to at most one worker.
          const [a, b] = await Promise.all([
            fresh.claim(100, 100, `wA-${uid()}`, 60_000),
            fresh.claim(100, 100, `wB-${uid()}`, 60_000),
          ]);
          // Combine both workers' leases. Operating on the union (rather
          // than per-worker sets) keeps the callbacks covered even when one
          // worker wins every stream and the other comes back empty.
          const claimed = [...a, ...b]
            .map((l) => l.stream)
            .filter((stream) => owned.has(stream));
          // No stream leased twice (no double-lease across workers)...
          expect(new Set(claimed).size).toBe(claimed.length);
          // ...and every stream leased exactly once (none lost).
          expect(claimed.length).toBe(owned.size);
        } finally {
          await fresh.dispose();
        }
      });

      // ACT-1184: lease expiry under competing claimers. An unexpired
      // lease is invisible to every other worker; an expired one is
      // handed to exactly one of them.
      it("does not hand an unexpired lease to a competing claimer", async () => {
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const s = `unexpired-${uid()}`;
          const other = `unexpired-other-${uid()}`;
          await fresh.subscribe([{ stream: s }]);
          await seed_stream(fresh, s, 1);
          const a = await fresh.claim(100, 100, `wA-${uid()}`, 60_000);
          expect(a.find((l) => l.stream === s)).toBeDefined();
          // Subscribe `other` only AFTER A's claim so B's claim comes back
          // populated and the negative assertion runs through a non-empty
          // array (mirrors "does not double-claim a held lease").
          await fresh.subscribe([{ stream: other }]);
          await seed_stream(fresh, other, 1);
          const b = await fresh.claim(100, 100, `wB-${uid()}`, 60_000);
          expect(b.find((l) => l.stream === other)).toBeDefined();
          expect(b.find((l) => l.stream === s)).toBeUndefined();
        } finally {
          await fresh.dispose();
        }
      });

      it("hands an expired lease to exactly one competing claimer, with retry accounting shared across workers", async () => {
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const s = `expired-${uid()}`;
          await fresh.subscribe([{ stream: s }]);
          const [e1] = await seed_stream(fresh, s, 1);
          // The original holder "dies": a 0ms lease is expired on arrival.
          const dead = await fresh.claim(100, 0, `wDead-${uid()}`, 0);
          expect(dead.find((l) => l.stream === s)?.retry).toBe(0);
          // Two workers race for the expired lease — exactly one wins,
          // and the shared retry counter (ACT-1183) reflects the reclaim
          // regardless of which worker performs it.
          const [b, c] = await Promise.all([
            fresh.claim(100, 100, `wB-${uid()}`, 60_000),
            fresh.claim(100, 100, `wC-${uid()}`, 60_000),
          ]);
          const winners = [...b, ...c].filter((l) => l.stream === s);
          expect(winners).toHaveLength(1);
          expect(winners[0].retry).toBe(1);
          // Ack by the winning worker resets the shared budget.
          await fresh.ack([{ ...winners[0], at: e1.id }]);
          await seed_stream(fresh, s, 1);
          const again = await fresh.claim(100, 0, `wNext-${uid()}`, 60_000);
          expect(again.find((l) => l.stream === s)?.retry).toBe(0);
        } finally {
          await fresh.dispose();
        }
      });
    });

    describe("block", () => {
      it("hides blocked streams from claim", async () => {
        const s = `block-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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

      it("re-blocking an already-blocked stream is a no-op (#1263)", async () => {
        const s = `block-twice-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        await store.ack(leased.filter((l) => l.stream !== s));
        const first = await store.block([
          { ...(mine as Lease), error: "boom" },
        ]);
        expect(first).toHaveLength(1);
        // Second block of the same already-blocked lease affects nothing —
        // no spurious duplicate `blocked` event.
        const second = await store.block([
          { ...(mine as Lease), error: "boom" },
        ]);
        expect(second).toHaveLength(0);
      });
    });

    describe("defer", () => {
      it("hides a stream from claim until its deferred_at passes", async () => {
        const s = `defer-${uid()}`;
        // A claimable control stream guarantees the claim result is non-empty,
        // so the membership checks below actually run (and prove `s` is the one
        // being skipped, not that nothing was claimable).
        const ctl = `defer-ctl-${uid()}`;
        await store.subscribe([{ stream: s }, { stream: ctl }]);
        for (const st of [s, ctl])
          await store.commit<CounterEvents>(
            st,
            [inc(1)],
            make_meta({ stream: st })
          );
        // Defer far into the future — claim must skip it.
        expect(await store.defer([s], Date.now() + 3_600_000)).toBe(1);
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        expect(leased.find((l) => l.stream === ctl)).toBeDefined();
        expect(leased.find((l) => l.stream === s)).toBeUndefined();
      });

      it("makes a stream claimable once the deferred_at is in the past", async () => {
        const s = `defer-past-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        // A due-time already in the past is not a constraint.
        expect(await store.defer([s], Date.now() - 1_000)).toBe(1);
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        // ack clears the schedule and does not bump retry past the claim.
        await store.ack(
          leased.filter((l) => l.stream !== s).concat(mine as Lease)
        );
      });

      it("does not bump retry while a stream is deferred", async () => {
        const s = `defer-retry-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await store.defer([s], Date.now() + 3_600_000);
        // Several claim attempts while deferred — none should touch the row.
        await store.claim(100, 100, `w1-${uid()}`, 100_000);
        await store.claim(100, 100, `w2-${uid()}`, 100_000);
        // Re-defer into the past so it becomes claimable, then observe retry.
        await store.defer([s], Date.now() - 1_000);
        const leased = await store.claim(100, 100, `w3-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        // First real claim → retry 0, proving the deferred claims didn't bump it.
        expect(mine!.retry).toBe(0);
        await store.ack(
          leased.filter((l) => l.stream !== s).concat(mine as Lease)
        );
      });

      it("reset clears a pending defer", async () => {
        const s = `defer-reset-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await store.defer([s], Date.now() + 3_600_000);
        expect(await store.reset([s])).toBe(1);
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        expect(leased.find((l) => l.stream === s)).toBeDefined();
      });

      it("exposes a future deferred_at via query_streams (#1221)", async () => {
        // The cold-start defer re-seed reads the persisted schedule back
        // through query_streams: a stream with a future deferred_at must
        // surface the ms-since-epoch value so the orchestrator can re-arm
        // the drain at the due-time. A stream with no active defer omits it.
        const deferred = `defer-qs-${uid()}`;
        const plain = `defer-qs-plain-${uid()}`;
        await store.subscribe([{ stream: deferred }, { stream: plain }]);
        for (const s of [deferred, plain])
          await store.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
        const due = Date.now() + 3_600_000;
        await store.defer([deferred], due);

        const seen = new Map<string, number | undefined>();
        await store.query_streams((p) => {
          if (p.stream === deferred || p.stream === plain)
            seen.set(p.stream, p.deferred_at);
        });
        // The deferred stream reports its schedule; adapters persist at
        // second/ms precision, so allow a small rounding tolerance.
        const got = seen.get(deferred);
        expect(got).toBeDefined();
        expect(Math.abs((got as number) - due)).toBeLessThan(2_000);
        // The undeferred stream omits the field.
        expect(seen.get(plain)).toBeUndefined();
      });

      it("defers streams matching a filter and counts matches", async () => {
        const tag = uid();
        const a = `deferfilter-${tag}-a`;
        const b = `deferfilter-${tag}-b`;
        await store.subscribe([{ stream: a }, { stream: b }]);
        for (const s of [a, b])
          await store.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
        // A claimable control stream outside the filter keeps the claim result
        // non-empty, so the membership checks below run against real rows.
        const ctl = `defer-filterctl-${tag}`;
        await store.subscribe([{ stream: ctl }]);
        await store.commit<CounterEvents>(
          ctl,
          [inc(1)],
          make_meta({ stream: ctl })
        );
        const n = await store.defer(
          { stream: `^deferfilter-${tag}-`, stream_exact: false },
          Date.now() + 3_600_000
        );
        expect(n).toBe(2);
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        expect(leased.find((l) => l.stream === ctl)).toBeDefined();
        expect(leased.find((l) => l.stream === a)).toBeUndefined();
        expect(leased.find((l) => l.stream === b)).toBeUndefined();
      });

      it("returns 0 for unknown streams and empty input", async () => {
        expect(await store.defer([`missing-${uid()}`], Date.now())).toBe(0);
        expect(await store.defer([], Date.now())).toBe(0);
      });
    });

    describe("ack finalize (due-marked leases)", () => {
      it("defers a due-marked lease instead of acking it", async () => {
        // One finalize call carries both outcomes: the control stream acks
        // (watermark advances), the due-marked stream defers (schedule set,
        // watermark held). Deferred entries are not part of the return value.
        const s = `ackdefer-${uid()}`;
        const ctl = `ackdefer-ctl-${uid()}`;
        await store.subscribe([{ stream: s }, { stream: ctl }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const [ctl_head] = await store.commit<CounterEvents>(
          ctl,
          [inc(1)],
          make_meta({ stream: ctl })
        );
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const s_lease = leased.find((l) => l.stream === s)!;
        const ctl_lease = leased.find((l) => l.stream === ctl)!;
        const acked = await store.ack([
          { ...ctl_lease, at: ctl_head.id },
          { ...s_lease, due: Date.now() + 3_600_000 },
        ]);
        expect(acked.find((l) => l.stream === ctl)).toBeDefined();
        expect(acked.find((l) => l.stream === s)).toBeUndefined();
        // The schedule holds: claim skips the deferred stream. A fresh
        // commit on the control keeps the claim result non-empty, so the
        // membership check proves the deferred stream is the one skipped.
        await store.commit<CounterEvents>(
          ctl,
          [inc(2)],
          make_meta({ stream: ctl })
        );
        const again = await store.claim(100, 100, `w-${uid()}`, 100_000);
        expect(again.find((l) => l.stream === ctl)).toBeDefined();
        expect(again.find((l) => l.stream === s)).toBeUndefined();
      });

      it("holds the watermark and resets retry on an explicit-defer due lease (retry: -1)", async () => {
        // A due-time already in the past makes the stream immediately
        // re-claimable — proving the finalize released the lease. The lease
        // carries `at` = the claim watermark (no events handled), so the
        // advance is a no-op and the watermark holds. An explicit defer passes
        // `retry: -1` (a defer is not a failure), so the persisted retry resets
        // and the next claim bumps it to 0.
        const s = `ackdefer-past-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s)!;
        await store.ack([{ ...mine, due: Date.now() - 1_000, retry: -1 }]);
        const again = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const re = again.find((l) => l.stream === s);
        expect(re).toBeDefined();
        expect(re!.at).toBe(mine.at); // watermark held — events still pending
        expect(re!.retry).toBe(0); // reset by the defer, bumped by claim
        await store.ack([{ ...re!, at: 1_000_000 }]);
      });

      it("persists the lease's retry on a backoff-style due lease (#1262)", async () => {
        // A retry-with-backoff passes the climbing counter (not -1) on the
        // due-marked lease, so the retry budget survives the defer window —
        // the persisted value plus the next claim's bump keep it accruing
        // toward the block threshold across windows.
        const s = `ackdefer-retry-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s)!;
        // Persist retry 3 with a past due-time so it's immediately re-claimable.
        // `at` = the claim watermark (no progress), so the advance is a no-op.
        await store.ack([{ ...mine, due: Date.now() - 1_000, retry: 3 }]);
        const again = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const re = again.find((l) => l.stream === s);
        expect(re).toBeDefined();
        expect(re!.at).toBe(mine.at); // watermark unchanged — no-op advance
        expect(re!.retry).toBe(4); // persisted 3, bumped to 4 by claim
        await store.ack([{ ...re!, at: 1_000_000 }]);
      });

      it("advances the watermark to `at` while persisting the schedule on a partial-progress due lease (#1278)", async () => {
        // Advance and defer are independent ack legs: a partial-progress
        // backoff/defer moves the watermark past the events handled this cycle
        // (`at`) AND persists the window in one call, so the handled prefix
        // never re-runs. Distinct from the hold cases above, which pass
        // `at` = the claim watermark (a no-op advance).
        const s = `ackadvance-${uid()}`;
        await store.subscribe([{ stream: s }]);
        // e1 is the "handled prefix"; a second event keeps the stream pending.
        const [e1] = await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s)!;
        expect(mine.at).toBeLessThan(e1.id); // fresh stream — floor below e1
        // Advance to e1 (last succeeded) AND defer with a past due-time (so it's
        // immediately re-claimable) carrying the climbing retry.
        await store.ack([
          { ...mine, at: e1.id, due: Date.now() - 1_000, retry: 2 },
        ]);
        const again = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const re = again.find((l) => l.stream === s);
        expect(re).toBeDefined();
        expect(re!.at).toBe(e1.id); // advanced past the succeeded event, NOT held
        expect(re!.retry).toBe(3); // persisted 2, bumped by claim
        await store.ack([{ ...re!, at: 1_000_000 }]);
      });

      it("ignores due-marked entries from a non-holder", async () => {
        // Same ownership rule as plain acks: only the lease holder can
        // finalize, so a stale worker cannot overwrite a live schedule.
        const s = `ackdefer-owner-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s)!;
        await store.ack([
          { ...mine, by: `stale-${uid()}`, due: Date.now() + 3_600_000 },
        ]);
        // No schedule was written: the holder can still finalize normally.
        const acked = await store.ack([{ ...mine, at: 1_000_000 }]);
        expect(acked.find((l) => l.stream === s)).toBeDefined();
      });
    });

    describe("reset", () => {
      it("rewinds a stream watermark to -1", async () => {
        const s = `reset-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await store.commit<CounterEvents>(
          s,
          [inc(2)],
          make_meta({ stream: s })
        );

        // First lease + ack first event → watermark advances.
        const first = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const m1 = first.find((l) => l.stream === s);
        await store.ack([{ ...(m1 as Lease), at: m1!.at }]);

        // Capture watermark before block.
        const before_block = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const m2 = before_block.find((l) => l.stream === s);
        expect(m2).toBeDefined();
        const watermark_before = m2!.at;
        await store.block([{ ...(m2 as Lease), error: "permanent" }]);

        // Stream is now blocked — query_streams must report it as such.
        // (Asserting on `claim()` would be flaky: an empty result is the
        // same as "s not in the result," which short-circuits a find()
        // callback and leaves it uncovered when no other streams happen
        // to be claimable in the fixture.)
        let blocked_flag: boolean | undefined;
        await store.query_streams(
          (p) => {
            blocked_flag = p.blocked;
          },
          { stream: s, stream_exact: true, limit: 1 }
        );
        expect(blocked_flag).toBe(true);

        // Unblock — claim picks it back up at the same watermark.
        expect(await store.unblock([s])).toBe(1);
        const after = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const back = after.find((l) => l.stream === s);
        expect(back).toBeDefined();
        expect(back!.at).toBe(watermark_before);
        expect(back!.retry).toBe(0);
      });

      it("returns 0 when the stream is not blocked", async () => {
        const s = `unblock-noop-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
          make_meta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          make_meta({ stream: s2 })
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
          make_meta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          make_meta({ stream: s2 })
        );
        await store.commit<CounterEvents>(
          s3,
          [inc(1)],
          make_meta({ stream: s3 })
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
          make_meta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          make_meta({ stream: s2 })
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
          make_meta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          make_meta({ stream: s2 })
        );
        await store.commit<CounterEvents>(
          other,
          [inc(1)],
          make_meta({ stream: other })
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
        const position_for = async (name: string): Promise<number | null> => {
          let at: number | null = null;
          await store.query_streams(
            (p) => {
              at = p.at;
            },
            { stream: name, stream_exact: true, limit: 1 }
          );
          return at;
        };
        expect(await position_for(s1)).toBe(-1);
        expect(await position_for(s2)).toBe(-1);
        expect(await position_for(other)).toBeGreaterThan(-1);
      });

      it("filter form: resets only blocked streams when blocked:true", async () => {
        const tag = uid();
        const s1 = `reset-blocked-${tag}-blocked`;
        const s2 = `reset-blocked-${tag}-fine`;
        await store.subscribe([{ stream: s1 }, { stream: s2 }]);
        await store.commit<CounterEvents>(
          s1,
          [inc(1)],
          make_meta({ stream: s1 })
        );
        await store.commit<CounterEvents>(
          s2,
          [inc(1)],
          make_meta({ stream: s2 })
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
        const sub_default = `lane-claim-def-${tag}`;
        const sub_slow = `lane-claim-slow-${tag}`;
        await store.commit<CounterEvents>(
          src1,
          [inc(1)],
          make_meta({ stream: src1 })
        );
        await store.commit<CounterEvents>(
          src2,
          [inc(1)],
          make_meta({ stream: src2 })
        );
        await store.subscribe([
          { stream: sub_default, source: src1 },
          { stream: sub_slow, source: src2, lane: "slow" },
        ]);

        const slow = await store.claim(50, 0, `w-slow-${tag}`, 1_000, "slow");
        const slow_mine = slow.filter(
          (l) => l.stream === sub_default || l.stream === sub_slow
        );
        expect(slow_mine.map((l) => l.stream)).toEqual([sub_slow]);
        expect(slow_mine[0]?.lane).toBe("slow");
        await store.ack(slow_mine.map((l) => ({ ...l, at: l.at + 1 })));

        const all = await store.claim(50, 0, `w-all-${tag}`, 1_000);
        const all_mine = all
          .filter((l) => l.stream === sub_default || l.stream === sub_slow)
          .map((l) => ({ stream: l.stream, lane: l.lane }));
        expect(all_mine).toEqual(
          expect.arrayContaining([
            { stream: sub_default, lane: "default" },
            { stream: sub_slow, lane: "slow" },
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
          make_meta({ stream: src })
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
          make_meta({ stream: src })
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
          make_meta({ stream: s })
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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

      // Windowed truncation (#1011): a `before` boundary prunes the
      // prefix below the closest safe `__snapshot__` — a pure prefix
      // delete behind a real snapshot; no seed, no tombstone.
      describe("windowed (before boundary)", () => {
        // Layout: inc, inc, snapA{2}, inc, snapB{3}, inc — returns the
        // stream name plus the two snapshot events for boundary asserts.
        async function seed_windowed(s: string) {
          await store.commit<CounterEvents>(
            s,
            [inc(1), inc(1)],
            make_meta({ stream: s })
          );
          const [snap_a] = await store.commit(
            s,
            [{ name: SNAP_EVENT, data: { count: 2 } }],
            make_meta({ stream: s })
          );
          await store.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
          const [snap_b] = await store.commit(
            s,
            [{ name: SNAP_EVENT, data: { count: 3 } }],
            make_meta({ stream: s })
          );
          await store.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
          return { snap_a, snap_b };
        }

        it("deletes the prefix below the closest safe snapshot and keeps the snapshot + tail", async () => {
          const s = `trunc-win-${uid()}`;
          const { snap_b } = await seed_windowed(s);
          const before = new Date(Date.now() + 60_000);
          const result = await store.truncate([{ stream: s, before }]);
          const entry = result.get(s);
          // 4 events below snapB: inc, inc, snapA, inc
          expect(entry?.deleted).toBe(4);
          // committed is the SURVIVING boundary snapshot, not a new seed
          expect(entry?.committed.id).toBe(snap_b.id);
          expect(entry?.committed.name).toBe(SNAP_EVENT);
          expect(entry?.committed.data).toEqual({ count: 3 });
          // windowed entries echo the boundary
          expect(entry?.before).toEqual(before);
          const remaining = await collect(store, {
            stream: s,
            stream_exact: true,
            with_snaps: true,
            after: -1,
          });
          expect(remaining.map((e) => e.name)).toEqual([
            SNAP_EVENT,
            "Incremented",
          ]);
          expect(remaining[0].id).toBe(snap_b.id);
        });

        it("honors the max_id cap — boundary never rises past a lagging consumer", async () => {
          const s = `trunc-win-cap-${uid()}`;
          const { snap_a, snap_b } = await seed_windowed(s);
          const before = new Date(Date.now() + 60_000);
          const result = await store.truncate([
            { stream: s, before, max_id: snap_a.id },
          ]);
          const entry = result.get(s);
          // snapB is newer but above the cap — snapA is the closest safe
          expect(entry?.committed.id).toBe(snap_a.id);
          expect(entry?.deleted).toBe(2);
          const remaining = await collect(store, {
            stream: s,
            stream_exact: true,
            with_snaps: true,
            after: -1,
          });
          expect(remaining.map((e) => e.id)).toContain(snap_b.id);
          expect(remaining[0].id).toBe(snap_a.id);
          expect(remaining).toHaveLength(4);
        });

        it("no-ops when no snapshot qualifies — stream absent from the result, events untouched", async () => {
          const s = `trunc-win-noop-${uid()}`;
          await store.commit<CounterEvents>(
            s,
            [inc(1), inc(1)],
            make_meta({ stream: s })
          );
          // no snapshot at all
          const none = await store.truncate([
            { stream: s, before: new Date(Date.now() + 60_000) },
          ]);
          expect(none.has(s)).toBe(false);
          // snapshot exists but the cutoff predates it
          await store.commit(
            s,
            [{ name: SNAP_EVENT, data: { count: 2 } }],
            make_meta({ stream: s })
          );
          const too_early = await store.truncate([
            { stream: s, before: new Date(0) },
          ]);
          expect(too_early.has(s)).toBe(false);
          // missing stream no-ops too
          const missing = await store.truncate([
            { stream: `trunc-win-missing-${uid()}`, before: new Date() },
          ]);
          expect(missing.size).toBe(0);
          const remaining = await collect(store, {
            stream: s,
            stream_exact: true,
            with_snaps: true,
            after: -1,
          });
          expect(remaining).toHaveLength(3);
        });

        it("leaves subscriptions untouched, unlike a full truncate", async () => {
          const s = `trunc-win-subs-${uid()}`;
          await seed_windowed(s);
          await store.subscribe([{ stream: s }]);
          await store.truncate([
            { stream: s, before: new Date(Date.now() + 60_000) },
          ]);
          const positions: string[] = [];
          await store.query_streams((p) => positions.push(p.stream), {
            stream: s,
            stream_exact: true,
          });
          expect(positions).toEqual([s]);
        });

        it("mixes full and windowed targets in one call", async () => {
          const w = `trunc-win-mix-w-${uid()}`;
          const f = `trunc-win-mix-f-${uid()}`;
          const { snap_b } = await seed_windowed(w);
          await store.commit<CounterEvents>(
            f,
            [inc(1)],
            make_meta({ stream: f })
          );
          const result = await store.truncate([
            { stream: w, before: new Date(Date.now() + 60_000) },
            { stream: f },
          ]);
          expect(result.get(w)?.committed.id).toBe(snap_b.id);
          expect(result.get(w)?.before).toBeInstanceOf(Date);
          expect(result.get(f)?.deleted).toBe(1);
          expect(result.get(f)?.committed.name).toBe("__tombstone__");
          expect(result.get(f)?.before).toBeUndefined();
        });

        it("keeps the stream writable and readable after a prune", async () => {
          const s = `trunc-win-cont-${uid()}`;
          const { snap_b } = await seed_windowed(s);
          await store.truncate([
            { stream: s, before: new Date(Date.now() + 60_000) },
          ]);
          // versions continue from the surviving tail; ids never reuse
          // a pruned id
          const [next] = await store.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
          expect(next.version).toBe(6);
          expect(next.id).toBeGreaterThan(snap_b.id);
          // with_snaps replay anchors on the surviving boundary snapshot
          const replay = await collect(store, {
            stream: s,
            stream_exact: true,
            with_snaps: true,
          });
          expect(replay[0].id).toBe(snap_b.id);
          expect(replay).toHaveLength(3);
        });
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
        const all_result = await store.query_streams(
          (p) => all.push({ stream: p.stream, source: p.source }),
          { stream: `qs-${tag}-.*` }
        );
        expect(all_result.count).toBe(4);
        expect(all_result.maxEventId).toBeGreaterThanOrEqual(-1);
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

        const by_source: string[] = [];
        await store.query_streams((p) => by_source.push(p.stream), {
          stream: `qs-${tag}-.*`,
          source: `qs-${tag}-src-.*`,
        });
        expect(by_source.sort()).toEqual([dyn1, dyn2].sort());

        const exact_source: string[] = [];
        await store.query_streams((p) => exact_source.push(p.stream), {
          stream: `qs-${tag}-.*`,
          source: src2,
          source_exact: true,
        });
        expect(exact_source).toEqual([dyn2]);
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
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
          make_meta({ stream: sA })
        );
        await store.commit<CounterEvents>(
          sB,
          [dec(5)],
          make_meta({ stream: sB })
        );
        await store.commit<CounterEvents>(
          sUnasked,
          [inc(99)],
          make_meta({ stream: sUnasked })
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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await store.commit<CounterEvents>(
          s,
          [inc(2)],
          make_meta({ stream: s })
        );
        await store.commit<CounterEvents>(
          s,
          [inc(3)],
          make_meta({ stream: s })
        );

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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await store.truncate([{ stream: s, snapshot: { count: 99 } }]);
        await store.commit<CounterEvents>(
          s,
          [inc(2), inc(3), dec(1)],
          make_meta({ stream: s })
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
          make_meta({ stream: s })
        );
        await store.commit<CounterEvents>(
          sAllOut,
          [inc(7)],
          make_meta({ stream: sAllOut })
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
        const no_tomb = await store.query_stats<CounterEvents>([s], {
          exclude: [TOMBSTONE_EVENT],
        });
        expect(no_tomb.get(s)?.head.name).toBe("Incremented");
      });

      it("before — time travel narrows head/tail/count", async () => {
        const tag = uid();
        const s = `qst-tt-${tag}`;
        const c1 = await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const c2 = await store.commit<CounterEvents>(
          s,
          [inc(2)],
          make_meta({ stream: s })
        );
        await store.commit<CounterEvents>(
          s,
          [inc(3)],
          make_meta({ stream: s })
        );

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
          make_meta({ stream: sA })
        );
        await store.commit<CounterEvents>(
          sB,
          [inc(2)],
          make_meta({ stream: sB })
        );
        await store.commit<CounterEvents>(
          sOther,
          [inc(3)],
          make_meta({ stream: sOther })
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
        await store.commit<CounterEvents>(
          a,
          [inc(1)],
          make_meta({ stream: a })
        );
        await store.commit<CounterEvents>(
          b,
          [inc(2)],
          make_meta({ stream: b })
        );

        // Block stream `a` via the standard claim → block path.
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === a);
        expect(mine).toBeDefined();
        const others = leased.filter((l) => l.stream !== a);
        await store.ack(others);
        await store.block([{ ...(mine as Lease), error: "boom" }]);

        // Step 1: subscription-level filter via query_streams.
        const blocked_names: string[] = [];
        await store.query_streams((p) => blocked_names.push(p.stream), {
          stream: `^qsc-${tag}-`,
          blocked: true,
        });
        expect(blocked_names).toEqual([a]);

        // Step 2: event-level stats for those streams.
        const stats = await store.query_stats<CounterEvents>(blocked_names);
        expect(stats.get(a)?.head.name).toBe("Incremented");
        expect(stats.has(b)).toBe(false);
      });

      it("empty filter {} — matches every event-bearing stream", async () => {
        const tag = uid();
        const a = `qse-${tag}-a`;
        const b = `qse-${tag}-b`;
        await store.commit<CounterEvents>(
          a,
          [inc(1)],
          make_meta({ stream: a })
        );
        await store.commit<CounterEvents>(
          b,
          [dec(2)],
          make_meta({ stream: b })
        );

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
          make_meta({ stream: s })
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

      it("paginates with limit + after (keyset), ordered by stream name", async () => {
        const tag = uid();
        const streams = [
          `qsp-${tag}-a`,
          `qsp-${tag}-b`,
          `qsp-${tag}-c`,
          `qsp-${tag}-d`,
        ];
        for (const s of streams) {
          await store.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
        }

        const page1 = await store.query_stats<CounterEvents>(
          { stream: `qsp-${tag}-.*` },
          { limit: 2 }
        );
        const k1 = [...page1.keys()];
        expect(k1).toEqual([`qsp-${tag}-a`, `qsp-${tag}-b`]);

        const page2 = await store.query_stats<CounterEvents>(
          { stream: `qsp-${tag}-.*` },
          { limit: 2, after: k1.at(-1) }
        );
        const k2 = [...page2.keys()];
        expect(k2).toEqual([`qsp-${tag}-c`, `qsp-${tag}-d`]);

        // Final short page signals the end.
        const page3 = await store.query_stats<CounterEvents>(
          { stream: `qsp-${tag}-.*` },
          { limit: 2, after: k2.at(-1) }
        );
        expect(page3.size).toBe(0);

        // Unbounded (no limit) returns every matching stream in one call.
        const all = await store.query_stats<CounterEvents>({
          stream: `qsp-${tag}-.*`,
        });
        expect([...all.keys()].sort()).toEqual([...streams].sort());
      });
    });

    // Reverse-match probe filter (#1010): restrict to subscriptions whose
    // stored `source` pattern matches at least one of the supplied names.
    // Gated — stores that can't express reverse-regex omit it and callers
    // fall back to an unfiltered scan.
    describe.skipIf(!caps.source_matches)(
      "query_streams source_matches (capability)",
      () => {
        it("returns only subscriptions whose source pattern matches a name", async () => {
          const tag = uid();
          // Two dynamic subscriptions with concrete sources, one with a
          // regex source matching a family of streams.
          const subConcreteA = `sm-${tag}-sub-a`;
          const subConcreteB = `sm-${tag}-sub-b`;
          const subRegex = `sm-${tag}-sub-regex`;
          const subNoSource = `sm-${tag}-sub-nosource`;
          const srcA = `sm-${tag}-order-1`;
          const srcB = `sm-${tag}-order-2`;
          const srcRegex = `^sm-${tag}-order-`;
          await store.subscribe([
            { stream: subConcreteA, source: srcA },
            { stream: subConcreteB, source: srcB },
            { stream: subRegex, source: srcRegex },
            // No source = no source constraint = matches every name.
            { stream: subNoSource },
          ]);

          // Closing srcA: the concrete-A sub (source === srcA), the regex
          // sub (source matches srcA), and the no-source sub (always)
          // qualify; concrete-B does not.
          const matched: string[] = [];
          await store.query_streams((p) => matched.push(p.stream), {
            stream: `sm-${tag}-sub-.*`,
            source_matches: [srcA],
          });
          expect(matched.sort()).toEqual(
            [subConcreteA, subRegex, subNoSource].sort()
          );

          // A name no concrete/regex source matches → only the
          // no-source sub (which always qualifies) comes back.
          const none: string[] = [];
          await store.query_streams((p) => none.push(p.stream), {
            stream: `sm-${tag}-sub-.*`,
            source_matches: [`sm-${tag}-unrelated`],
          });
          expect(none).toEqual([subNoSource]);

          // Multiple names → union of matching subscriptions, plus the
          // always-matching no-source sub.
          const both: string[] = [];
          await store.query_streams((p) => both.push(p.stream), {
            stream: `sm-${tag}-sub-.*`,
            source_matches: [srcA, srcB],
          });
          expect(both.sort()).toEqual(
            [subConcreteA, subConcreteB, subRegex, subNoSource].sort()
          );
        });
      }
    );

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
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const positions: string[] = [];
        const { maxEventId } = await store.query_streams(
          (p) => positions.push(p.stream),
          { stream: s, stream_exact: true, limit: 1 }
        );
        expect(maxEventId).toBeGreaterThanOrEqual(0);
        expect(positions).toEqual([s]);
      });
    });

    describe("seed_stream helper coverage", () => {
      it("commits N events with monotonically increasing ids", async () => {
        const s = `seed-${uid()}`;
        const committed = await seed_stream(store, s, 3);
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

      /**
       * Adapt an event array into the {@link EventSource} contract.
       * The test source's `query` walks the array and calls the
       * callback per event, exactly like a real `Store.query`. The
       * `await Promise.resolve(callback(...))` mirrors the adapter
       * pattern so async-callback backpressure stays exercised
       * even from this synthetic source.
       */
      const as_source = (
        events: Committed<Schemas, keyof Schemas>[]
      ): EventSource => ({
        async query(callback) {
          // The cast widens our concrete schema-erased event back
          // into the generic `E` slot the EventSource.query contract
          // is parametrized over. Safe — the synthetic test source
          // is intentionally schema-agnostic.
          for (const e of events)
            await Promise.resolve(
              (callback as (event: Committed<Schemas, keyof Schemas>) => void)(
                e
              )
            );
          return events.length;
        },
        async dispose() {
          // no-op — synthetic in-memory source
        },
      });

      /**
       * Build a {@link Committed} event with stub meta + the given
       * created date. `original_id` populates `id` — used by the
       * orchestrator's scan to key the causation remap. Tests pass
       * arbitrary values (often a counter) since they're only
       * consumed by the map.
       */
      const event = (
        original_id: number,
        stream: string,
        version: number,
        name: string,
        created: Date,
        data: Record<string, unknown> = {}
      ): Committed<Schemas, keyof Schemas> => ({
        id: original_id,
        name,
        data,
        stream,
        version,
        created,
        meta: { correlation: "restore-tck", causation: {} },
      });

      /**
       * Test-side helper that routes through the public `Act.restore`
       * orchestrator path bound to the store-under-test via the
       * scoped-ports bag. Validates that the adapter's `restore` HOF
       * integrates correctly with the framework's scan loop without
       * importing the framework's internal scan symbol directly.
       */
      const restore = async (
        source: EventSource,
        opts: ScanOptions = {}
      ): Promise<ScanResult> => {
        const cache = new InMemoryCache();
        const app = act().build({ scoped: { store, cache } });
        try {
          return await app.restore(source, opts);
        } finally {
          // Dispose the source first, then the cache — mirrors how
          // a production caller would tear down ephemeral resources.
          // Also keeps the synthetic-source `dispose` no-op
          // exercised by every test that runs `restore`.
          await source.dispose();
          await cache.dispose();
        }
      };

      it("returns kept=0 on an empty source", async () => {
        const result = await restore(as_source([]));
        expect(result.kept).toBe(0);
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
        expect(result.dropped).toEqual({
          closed_streams: 0,
          snapshots: 0,
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
        const events = [
          event(1, s, 0, "Incremented", t0, { amount: 1 }),
          event(2, s, 1, "Incremented", t1, { amount: 2 }),
          event(3, s, 2, "Decremented", t2, { amount: 1 }),
        ];
        const result = await restore(as_source(events));
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
        const events = [
          event(1, a, 0, "Incremented", t, { amount: 10 }),
          event(2, b, 0, "Incremented", t, { amount: 20 }),
          event(3, a, 1, "Decremented", t, { amount: 5 }),
          event(4, b, 1, "Incremented", t, { amount: 30 }),
        ];
        const result = await restore(as_source(events));
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

      it("preserves Date `created` verbatim", async () => {
        const s = `restore-isoc-${uid()}`;
        const iso = "2021-07-15T12:34:56.789Z";
        await restore(
          as_source([
            {
              id: 1,
              stream: s,
              version: 0,
              name: "Incremented",
              data: { amount: 1 },
              created: new Date(iso),
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
          make_meta({ stream: old })
        );
        const fresh = `restore-fresh-${uid()}`;
        const t = new Date("2020-01-01T00:00:00.000Z");
        await restore(
          as_source([event(1, fresh, 0, "Incremented", t, { amount: 99 })])
        );
        // The old stream is gone.
        const old_back = await collect(store, {
          stream: old,
          stream_exact: true,
        });
        expect(old_back).toHaveLength(0);
        // Only the fresh stream remains.
        const fresh_back = await collect(store, {
          stream: fresh,
          stream_exact: true,
        });
        expect(fresh_back).toHaveLength(1);
      });

      it("clears subscription/stream-position metadata", async () => {
        const sub = `restore-sub-${uid()}`;
        await store.subscribe([{ stream: sub, source: "anything" }]);
        const collect_streams = async () => {
          const out: string[] = [];
          await store.query_streams((p) => {
            out.push(p.stream);
          });
          return out;
        };
        const before = await collect_streams();
        expect(before.includes(sub)).toBe(true);
        await restore(as_source([]));
        const after = await collect_streams();
        expect(after.includes(sub)).toBe(false);
      });

      it("preserves snapshot events through restore", async () => {
        // SNAP_EVENT is a framework marker — restore writes it
        // through but skips updating the max-non-snap-id indexes.
        // Covers the `event.name !== SNAP_EVENT` false branch.
        const s = `restore-snap-${uid()}`;
        const t = new Date("2020-04-01T00:00:00.000Z");
        await restore(
          as_source([
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
        // the event whose causation pointed at original id 5 must end
        // up pointing at the new id assigned to that same row.
        const s = `restore-caus-${uid()}`;
        const t = new Date("2020-08-01T00:00:00.000Z");
        const events: Committed<Schemas, keyof Schemas>[] = [
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
        await restore(as_source(events));
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
        await restore(
          as_source([
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
          make_meta({ stream: original })
        );
        // EventSource that fires one event then throws — exercises
        // the rollback path on the destination store. Implemented as
        // a query method (not an iterable) since EventSource is the
        // shape Act.restore takes.
        const explosive: EventSource = {
          async query(callback) {
            await Promise.resolve(
              (callback as (event: Committed<Schemas, keyof Schemas>) => void)(
                event(
                  1,
                  `restore-explode-${uid()}`,
                  0,
                  "Incremented",
                  new Date(),
                  { amount: 1 }
                )
              )
            );
            throw new Error("boom");
          },
          async dispose() {
            // no-op
          },
        };
        await expect(restore(explosive)).rejects.toThrow("boom");
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
        const result = await restore(
          as_source([
            event(1, s, 0, "Incremented", t, { amount: 1 }),
            {
              id: 2,
              stream: s,
              version: 1,
              name: SNAP_EVENT,
              data: { count: 1 },
              created: t,
              meta: { correlation: "snap", causation: {} },
            },
            event(3, s, 2, "Incremented", t, { amount: 2 }),
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

      it("on_progress fires once per event (caller throttles)", async () => {
        const calls: number[] = [];
        const s = `restore-progress-${uid()}`;
        const t = new Date("2021-02-01T00:00:00.000Z");
        await restore(
          as_source([
            event(1, s, 0, "Incremented", t, { amount: 1 }),
            event(2, s, 1, "Incremented", t, { amount: 2 }),
          ]),
          { on_progress: (p) => calls.push(p.processed) }
        );
        // One callback per event; values monotonic.
        expect(calls).toEqual([1, 2]);
      });

      // #1258: `created` bounds are pure WHERE filters, never early-breaks.
      // Restore preserves the source `created` verbatim, so a restored
      // dataset whose timestamp order diverges from id order proves the
      // scan must not short-circuit on the first out-of-order event.
      it("query created bounds are filters, not id-ordered breaks", async () => {
        const s = `restore-created-order-${uid()}`;
        // id 0 = newest, id 1 = oldest → created order ≠ id order.
        const newest = new Date("2020-06-01T00:00:00.000Z");
        const oldest = new Date("2020-01-01T00:00:00.000Z");
        await restore(
          as_source([
            event(1, s, 0, "Incremented", newest, { amount: 10 }),
            event(2, s, 1, "Incremented", oldest, { amount: 20 }),
          ])
        );
        const cutoff = new Date("2020-03-01T00:00:00.000Z");
        // Forward: the newest event (id 0) is scanned first and fails
        // `created_before`; the older event (id 1) must still be found.
        const fwd: number[] = [];
        await store.query<CounterEvents>(
          (e) => {
            fwd.push((e.data as { amount: number }).amount);
          },
          { stream: s, stream_exact: true, created_before: cutoff }
        );
        expect(fwd).toEqual([20]);
        // Backward: the oldest event (id 1) is scanned first and fails
        // `created_after`; the newer event (id 0) must still be found.
        const bwd: number[] = [];
        await store.query<CounterEvents>(
          (e) => {
            bwd.push((e.data as { amount: number }).amount);
          },
          {
            stream: s,
            stream_exact: true,
            created_after: cutoff,
            backward: true,
          }
        );
        expect(bwd).toEqual([10]);
      });

      // Note (RFC 1274): floor-vs-time-bound suppression is no longer a
      // store-level concern. The store applies the resume floor whenever
      // `with_snaps` is set; the orchestrator is the single owner of floor
      // eligibility and never combines `with_snaps` with an `asOf` bound. The
      // suppression contract (#1261 `created_*`, #1267 `before`, #1274 `limit`)
      // is now enforced at the orchestrator level in
      // `libs/act/test/time-travel.spec.ts`.

      // #1257: restore must split `pii` into the isolated store so
      // `forget_pii` erases it — otherwise restored PII stays inline and
      // erasure silently no-ops. Only meaningful when the adapter also
      // isolates PII, so gate the assertion on that capability.
      it.skipIf(!caps.pii_isolation)(
        "isolates restored pii so forget_pii erases it",
        async () => {
          const s = `restore-pii-${uid()}`;
          const t = new Date("2020-05-01T00:00:00.000Z");
          // Two PII events on the same stream so isolation must survive
          // across events, not just the first.
          const result = await restore(
            as_source([
              {
                id: 1,
                stream: s,
                version: 0,
                name: "Incremented",
                data: { amount: 1 },
                pii: { email: "first@example.com" },
                created: t,
                meta: { correlation: "restore-tck", causation: {} },
              },
              {
                id: 2,
                stream: s,
                version: 1,
                name: "Incremented",
                data: { amount: 2 },
                pii: { email: "second@example.com" },
                created: t,
                meta: { correlation: "restore-tck", causation: {} },
              },
            ])
          );
          expect(result.kept).toBe(2);
          // PII round-trips on read after restore.
          const before: Committed<CounterEvents, keyof CounterEvents>[] = [];
          await store.query<CounterEvents>(
            (e) => {
              before.push(e);
            },
            { stream: s, stream_exact: true }
          );
          expect(before.map((e) => e.pii)).toEqual([
            { email: "first@example.com" },
            { email: "second@example.com" },
          ]);
          // forget_pii sees the restored PII and wipes every event's copy.
          const wiped = await store.forget_pii!.call(store, s);
          expect(wiped).toBe(2);
          const after: Committed<CounterEvents, keyof CounterEvents>[] = [];
          await store.query<CounterEvents>(
            (e) => {
              after.push(e);
            },
            { stream: s, stream_exact: true }
          );
          expect(after).toHaveLength(2);
          for (const e of after) expect(e.pii == null).toBe(true);
          expect(after.map((e) => e.data)).toEqual([
            { amount: 1 },
            { amount: 2 },
          ]);
        }
      );
    });

    // PII isolation — sensitive-data epic (#566). Same `skipIf` pattern as
    // restore: gated on `caps.pii_isolation`, exercises commit-with-pii
    // round-trip, the no-pii passthrough, `forget_pii` happy path +
    // idempotency, and isolation across streams.
    describe.skipIf(!caps.pii_isolation)("pii_isolation (capability)", () => {
      it("commits and loads pii alongside data", async () => {
        const s = `pii-roundtrip-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [
            {
              name: "Incremented",
              data: { amount: 1 },
              pii: { email: "u@example.com", name: "Ursula" },
            },
          ],
          make_meta({ stream: s })
        );
        expect(committed).toHaveLength(1);
        expect(committed[0].pii).toEqual({
          email: "u@example.com",
          name: "Ursula",
        });

        // Re-read via query to confirm the adapter persists pii.
        const seen: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            seen.push(e);
          },
          { stream: s, stream_exact: true }
        );
        expect(seen).toHaveLength(1);
        expect(seen[0].pii).toEqual({ email: "u@example.com", name: "Ursula" });
        // Non-pii fields untouched.
        expect(seen[0].data).toEqual({ amount: 1 });
      });

      it("query_stats head/tail never carry pii — introspection surface is pii-safe (#1294)", async () => {
        const s = `pii-stats-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [
            {
              name: "Incremented",
              data: { amount: 1 },
              pii: { email: "head@example.com" },
            },
            {
              name: "Incremented",
              data: { amount: 2 },
              pii: { email: "tail@example.com" },
            },
          ],
          make_meta({ stream: s })
        );

        // `query_stats` has no actor context and no disclosure gate, so it
        // must not surface pii — regardless of adapter or at-rest encryption.
        // Both code paths: heads-only (no count/names) and full-scan.
        const heads = await store.query_stats<CounterEvents>([s], {
          tail: true,
        });
        const h = heads.get(s);
        expect(h?.head?.pii == null).toBe(true);
        expect(h?.tail?.pii == null).toBe(true);

        const full = await store.query_stats<CounterEvents>([s], {
          tail: true,
          count: true,
          names: true,
        });
        const f = full.get(s);
        expect(f?.head?.pii == null).toBe(true);
        expect(f?.tail?.pii == null).toBe(true);
        expect(f?.count).toBe(2);
      });

      it("passes through events without pii (pii is null or undefined on load)", async () => {
        const s = `pii-none-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const seen: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            seen.push(e);
          },
          { stream: s, stream_exact: true }
        );
        expect(seen).toHaveLength(1);
        // Either undefined or null is acceptable — adapters that store
        // `pii TEXT NULL` round-trip as null; in-memory may return
        // undefined for the missing key. Both forms mean "no PII."
        expect(seen[0].pii == null).toBe(true);
      });

      it("wipes pii for every event on the stream via forget_pii", async () => {
        const s = `pii-forget-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [
            {
              name: "Incremented",
              data: { amount: 1 },
              pii: { email: "a@example.com" },
            },
            {
              name: "Incremented",
              data: { amount: 2 },
              pii: { email: "b@example.com" },
            },
          ],
          make_meta({ stream: s })
        );

        const forget = store.forget_pii;
        expect(forget).toBeDefined();
        const wiped = await forget!.call(store, s);
        expect(wiped).toBe(2);

        const seen: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            seen.push(e);
          },
          { stream: s, stream_exact: true }
        );
        expect(seen).toHaveLength(2);
        // PII is gone — adapters return null. Data is intact.
        for (const e of seen) {
          expect(e.pii == null).toBe(true);
          expect(e.data).toBeDefined();
        }
      });

      it("is idempotent — second forget_pii returns 0, no error", async () => {
        const s = `pii-forget-idem-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [
            {
              name: "Incremented",
              data: { amount: 1 },
              pii: { email: "u@example.com" },
            },
          ],
          make_meta({ stream: s })
        );
        const forget = store.forget_pii!;
        const first = await forget.call(store, s);
        expect(first).toBe(1);
        const second = await forget.call(store, s);
        expect(second).toBe(0);
      });

      it("only wipes the targeted stream — siblings untouched", async () => {
        const sA = `pii-iso-a-${uid()}`;
        const sB = `pii-iso-b-${uid()}`;
        await store.commit<CounterEvents>(
          sA,
          [
            {
              name: "Incremented",
              data: { amount: 1 },
              pii: { email: "alice@example.com" },
            },
          ],
          make_meta({ stream: sA })
        );
        await store.commit<CounterEvents>(
          sB,
          [
            {
              name: "Incremented",
              data: { amount: 1 },
              pii: { email: "bob@example.com" },
            },
          ],
          make_meta({ stream: sB })
        );
        await store.forget_pii!.call(store, sA);

        const a: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            a.push(e);
          },
          { stream: sA, stream_exact: true }
        );
        expect(a[0].pii == null).toBe(true);

        const b: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>(
          (e) => {
            b.push(e);
          },
          { stream: sB, stream_exact: true }
        );
        expect(b[0].pii).toEqual({ email: "bob@example.com" });
      });

      it("forget_pii on a stream with no pii events returns 0", async () => {
        const s = `pii-forget-empty-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const wiped = await store.forget_pii!.call(store, s);
        expect(wiped).toBe(0);
      });
    });

    if (caps.notify) {
      // ACT-1184: the notify conformance suite. `factory` must produce
      // sibling instances that share one backing store — the TCK's
      // standing pattern (two PostgresStores on the same schema/table,
      // two withBroker decorators on one broker). These cases enforce
      // the port's MUSTs: cross-instance delivery, self-filtering
      // ("implementations must skip their own commits"), and one
      // notification per commit transaction carrying the full batch.
      describe("notify (capability)", () => {
        it("delivers a notification when a different instance commits", async () => {
          // Self-filtering contract: an instance does not see its own
          // commits. So we listen on `store` and write through a fresh
          // sibling instance pointing at the same backend.
          const notify = store.notify;
          expect(notify).toBeDefined();
          const received: StoreNotification[] = [];
          let resolve_arrived!: () => void;
          const arrived = new Promise<void>((res) => {
            resolve_arrived = res;
          });
          const disposer = await notify!.call(store, (n) => {
            received.push(n);
            resolve_arrived();
          });
          const writer = await options.factory();
          try {
            const stream = `notify-${uid()}`;
            await writer.commit<CounterEvents>(
              stream,
              [inc(1)],
              make_meta({ stream })
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

        it("does not deliver an instance's own commits (self-filtering)", async () => {
          const received: StoreNotification[] = [];
          let resolve_sentinel!: () => void;
          const sentinel_arrived = new Promise<void>((res) => {
            resolve_sentinel = res;
          });
          const own = `notify-self-${uid()}`;
          const remote = `notify-remote-${uid()}`;
          const sentinel = `notify-sentinel-${uid()}`;
          const disposer = await store.notify!.call(store, (n) => {
            received.push(n);
            if (n.stream === sentinel) resolve_sentinel();
          });
          const writer = await options.factory();
          try {
            // Commit through the *listening* instance first, then through
            // a sibling (a plain remote commit, then the sentinel).
            // Notifications are delivered in commit order, so once the
            // sentinel arrives the own-commit notification would already
            // have been delivered were it not filtered.
            await store.commit<CounterEvents>(
              own,
              [inc(1)],
              make_meta({ stream: own })
            );
            await writer.commit<CounterEvents>(
              remote,
              [inc(1)],
              make_meta({ stream: remote })
            );
            await writer.commit<CounterEvents>(
              sentinel,
              [inc(1)],
              make_meta({ stream: sentinel })
            );
            await sentinel_arrived;
            expect(received.find((n) => n.stream === own)).toBeUndefined();
            expect(received.find((n) => n.stream === remote)).toBeDefined();
            expect(received.find((n) => n.stream === sentinel)).toBeDefined();
          } finally {
            await writer.dispose();
            await Promise.resolve(disposer());
          }
        });

        it("delivers one notification per commit transaction carrying the full event batch", async () => {
          const received: StoreNotification[] = [];
          let resolve_sentinel!: () => void;
          const sentinel_arrived = new Promise<void>((res) => {
            resolve_sentinel = res;
          });
          const batch = `notify-batch-${uid()}`;
          const sentinel = `notify-batch-sentinel-${uid()}`;
          const disposer = await store.notify!.call(store, (n) => {
            received.push(n);
            if (n.stream === sentinel) resolve_sentinel();
          });
          const writer = await options.factory();
          try {
            // One commit transaction, three events. The sentinel commit
            // bounds the wait: delivered in commit order, its arrival
            // proves any duplicate batch notification would already be in
            // `received`.
            await writer.commit<CounterEvents>(
              batch,
              [inc(1), inc(2), inc(3)],
              make_meta({ stream: batch })
            );
            await writer.commit<CounterEvents>(
              sentinel,
              [inc(1)],
              make_meta({ stream: sentinel })
            );
            await sentinel_arrived;
            const batch_notifications = received.filter(
              (n) => n.stream === batch
            );
            expect(batch_notifications).toHaveLength(1);
            const events = batch_notifications[0].events;
            expect(events).toHaveLength(3);
            // The batch arrives ordered with id + name per entry.
            expect(events.map((e) => e.name)).toEqual([
              "Incremented",
              "Incremented",
              "Incremented",
            ]);
            expect([...events.map((e) => e.id)].sort((a, b) => a - b)).toEqual(
              events.map((e) => e.id)
            );
          } finally {
            await writer.dispose();
            await Promise.resolve(disposer());
          }
        });
      });
    }
  });
};
