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
  StreamPosition,
  SubscribeInput,
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
   * Adapter honours `subscribe`'s optional `correlator` argument and answers
   * `correlating` (#1532). When `true`, the TCK runs the correlation-lease
   * suite — exclusive acquisition, renewal by the same holder, re-acquisition
   * after expiry, per-key independence, and the keyed checkpoint.
   *
   * Optional because a store that ignores the argument simply lets every
   * worker scan, which is the pre-#1532 behaviour and remains correct: the
   * marks are idempotent, so the duplication is waste rather than error.
   */
  readonly lease_correlation?: boolean;
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
  /**
   * Adapter honors the {@link SubscribeInput.correlated_at} **work mark**
   * (#1485): `subscribe` applies it as `GREATEST(correlated_at, N)` and
   * `claim` serves a marked stream from the subscription row alone
   * (`at < correlated_at`) instead of probing the event log. When `true`,
   * the TCK runs the work-set suite — mark-then-claim, monotonicity
   * across positive/zero/negative values, `ack` retiring a stream from
   * the claimable set and a later mark re-adding it, and the operator
   * surfaces (`reset`, `unblock`, `defer`, `prioritize`) leaving the mark
   * intact.
   *
   * @deprecated Ignored since #1488 — the mark is the only eligibility
   * rule, so this suite always runs. The field is kept so an adapter that
   * still passes `work_set: true` keeps compiling.
   */
  readonly work_set?: boolean;
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
   * Constructs the adapter the way a first-time user does: with its own
   * documented defaults and nothing else — `() => new MyStore()`.
   *
   * Supplying it opts into the default-configuration suite, which
   * allows exactly two outcomes and outlaws the third:
   *
   * 1. **Construction throws.** The adapter has no safe default and
   *    says so — an operator sees the error immediately.
   * 2. **Construction succeeds and the store round-trips**, including a
   *    second commit that advances the version.
   * 3. ~~Construction succeeds, `commit` reports success, and the data
   *    is not there.~~ This is the shape the suite exists to catch
   *    (#1443: a zero-config SQLite store defaulted to a per-connection
   *    private in-memory database, so `seed`'s DDL landed where later
   *    statements could not see it — every write was accepted and lost).
   *
   * The suite never calls `drop()`, so it is safe to point at a default
   * that resolves to a real shared database; it namespaces its stream
   * with {@link uid} like every other case.
   */
  readonly default_factory?: () => Store | Promise<Store>;
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

    const is_literal = (source: string) => !/[\]^$.*+?()[{}|\\]/.test(source);

    // Stand in for `correlate`, which a store test has no orchestrator to
    // run. `claim` follows marks since #1488 — committing an event is not
    // enough to make a stream claimable — so a test that expects work to be
    // claimed has to mark it, and mark it *honestly*: the highest event id
    // inside the subscription's own fetch window, which is what correlate
    // records. A source-less row sees every stream, a literal source only
    // its own, a pattern source the streams it matches.
    const correlate = async (target: Store = store) => {
      const rows: {
        stream: string;
        source?: string;
        at: number;
        priority: number;
        lane?: string;
      }[] = [];
      await target.query_streams(
        (p) =>
          rows.push({
            stream: p.stream,
            source: p.source,
            at: p.at,
            priority: p.priority,
            lane: p.lane,
          }),
        { limit: 1000 }
      );
      // Carry the row's own priority and lane back with the mark: `subscribe`
      // writes lane unconditionally, so a mark-only upsert would re-lane the
      // row to "default" — the trap #1487 hit in the orchestrator.
      const marks: SubscribeInput[] = [];
      for (const row of rows) {
        let mark = -1;
        await target.query(
          (e) => {
            mark = Math.max(mark, e.id);
          },
          row.source !== undefined
            ? { stream: row.source, stream_exact: is_literal(row.source) }
            : {}
        );
        if (mark > row.at)
          marks.push({
            stream: row.stream,
            priority: row.priority,
            lane: row.lane,
            correlated_at: mark,
          });
      }
      if (marks.length) await target.subscribe(marks);
    };

    beforeAll(async () => {
      store = await options.factory();
      await store.drop();
      await store.seed();
    });

    afterAll(async () => {
      await store.dispose();
    });

    // The one suite that does not use the shared `store`: it exercises
    // whatever the adapter's own defaults produce (#1443).
    const default_factory = options.default_factory;
    if (default_factory) {
      describe("default configuration", () => {
        it("either refuses to construct or round-trips a commit", async () => {
          let zero_config: Store;
          try {
            zero_config = await default_factory();
          } catch (error) {
            // Refusing is a valid answer — an adapter with no safe
            // default must say so out loud, at construction, before any
            // caller can hand it data to lose.
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).not.toBe("");
            return;
          }
          try {
            await zero_config.seed();
            const s = `default-config-${uid()}`;
            const first = await zero_config.commit<CounterEvents>(
              s,
              [inc(1)],
              make_meta({ stream: s })
            );
            expect(first[0].version).toBe(0);
            // A second commit catches the subtler half of the failure:
            // a store that loses the first write restarts versioning
            // here instead of advancing.
            const second = await zero_config.commit<CounterEvents>(
              s,
              [inc(2)],
              make_meta({ stream: s })
            );
            expect(second[0].version).toBe(1);
            const read: Committed<CounterEvents, keyof CounterEvents>[] = [];
            await zero_config.query<CounterEvents>((e) => read.push(e), {
              stream: s,
            });
            expect(read).toHaveLength(2);
            expect(read.map((e) => e.data.amount)).toEqual([1, 2]);
          } finally {
            await zero_config.dispose();
          }
        });
      });
    }

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

      it("created bounds exclude the event they are pinned to", async () => {
        // The window case above is built as `ts ± 60_000`, so no bound ever
        // lands ON an event's own timestamp — which is where the two
        // directions can disagree. A store may hold `created` at a finer
        // resolution than the `Date` it hands back (Postgres keeps
        // microseconds), and then a row compares as strictly-after its own
        // truncated timestamp and returns itself (#1595). Millisecond is the
        // resolution the contract is expressed in, since that is all a `Date`
        // carries, so both bounds must exclude the event they name.
        const s = `q-ts-self-${uid()}`;
        const committed = await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const own = committed[0].created;
        const after_own = await collect(store, {
          stream: s,
          stream_exact: true,
          created_after: own,
        });
        expect(after_own).toEqual([]);
        // The mirror direction, already strict everywhere — the control that
        // isolates a failure to the `created_after` side.
        const before_own = await collect(store, {
          stream: s,
          stream_exact: true,
          created_before: own,
        });
        expect(before_own).toEqual([]);
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

      // Claim eligibility for a fresh subscription (#1446). The adapters
      // disagreed here — two short-circuited `at < 0` into "claimable",
      // SQLite did not — and the TCK pinned nothing, so a third-party
      // adapter was free to pick either. The contract is that a claim
      // follows work, not registration: an empty lease costs a cycle, and
      // its no-op ack can advance the watermark past an event committed
      // mid-cycle.
      it("does not claim a fresh subscription with no matching events", async () => {
        const s = `fresh-empty-${uid()}`;
        const src = `fresh-src-${uid()}`;
        await store.subscribe([{ stream: s, source: src }]);
        await correlate();
        const leases = await store.claim(5, 5, `w-${uid()}`, 5_000);
        expect(leases.filter((l) => l.stream === s)).toHaveLength(0);
      });

      it("claims a fresh subscription as soon as its first event is marked", async () => {
        const s = `fresh-first-${uid()}`;
        const src = `fresh-first-src-${uid()}`;
        await store.subscribe([{ stream: s, source: src }]);
        const [first] = await store.commit<CounterEvents>(
          src,
          [inc(1)],
          make_meta({ stream: src })
        );
        // Committing is not enough since #1488: `claim` follows marks, and
        // only `correlate` raises one. This is that call.
        await store.subscribe([{ stream: s, correlated_at: first.id }]);
        await correlate();
        const leases = await store.claim(5, 5, `w-${uid()}`, 5_000);
        const mine = leases.filter((l) => l.stream === s);
        expect(mine).toHaveLength(1);
        // The watermark is still the fresh `-1`, so the first event is
        // inside the fetch window rather than behind it. This is what makes
        // a zero-based event id survivable — a store whose first id is 0
        // loses that event if anything acked a fresh stream to 0 first.
        expect(mine[0].at).toBe(-1);
        const in_window: Committed<CounterEvents, keyof CounterEvents>[] = [];
        await store.query<CounterEvents>((e) => in_window.push(e), {
          stream: src,
          stream_exact: true,
          after: mine[0].at,
        });
        expect(in_window).toHaveLength(1);
      });

      // The max rule holds across the whole number line, not just above
      // zero (#1445). Every case above uses positive priorities, which is
      // precisely why SQLite's `priority > 0` gate around its merge went
      // unnoticed: with positive values the gate is a no-op.
      it("keeps the maximum for negative and zero priorities too", async () => {
        const s = `sub-pri-neg-${uid()}`;
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

        await store.subscribe([{ stream: s, priority: -5 }]);
        expect(await read()).toBe(-5);

        // A less-negative priority is still higher — it must win.
        await store.subscribe([{ stream: s, priority: -1 }]);
        expect(await read()).toBe(-1);

        // More negative must not lower it.
        await store.subscribe([{ stream: s, priority: -9 }]);
        expect(await read()).toBe(-1);

        // Zero outranks every negative, including via the omitted default.
        await store.subscribe([{ stream: s }]);
        expect(await read()).toBe(0);
      });

      // `prioritize` is the documented operator override and the one call
      // that may *lower* priority. Because `subscribe` is restart-driven and
      // re-runs for every reaction target on every boot, the declared
      // priority must come back — otherwise an operator's temporary
      // de-prioritization is sticky forever (#1445).
      it("restores the declared priority on the next subscribe after a prioritize() downgrade", async () => {
        const s = `sub-pri-restore-${uid()}`;
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

        await store.subscribe([{ stream: s }]);
        expect(await read()).toBe(0);

        // Operator drops it below the declared default.
        await store.prioritize({ stream: s, stream_exact: true }, -5);
        expect(await read()).toBe(-5);

        // The next boot re-subscribes at the declared priority and restores it.
        await store.subscribe([{ stream: s }]);
        expect(await read()).toBe(0);
      });

      // The correlate checkpoint (#1484): how far the log has been READ, as
      // opposed to how far a target has been processed (`at`). Read AND
      // written by `subscribe`, which correlate already calls with the
      // targets each scan discovers — so it costs no round trip of its own,
      // and its only writer is the component that knows the value.
      //
      // A singleton cannot be namespaced with `uid()` like every other case
      // here, so these read the current value and assert RELATIVE to it.
      describe("correlate checkpoint", () => {
        const peek = async () => (await store.subscribe([])).correlated_at;

        it("round-trips an advance through subscribe", async () => {
          const base = await peek();
          expect((await store.subscribe([], base + 10)).correlated_at).toBe(
            base + 10
          );
          expect(await peek()).toBe(base + 10);
        });

        it("persists only when greater than the stored value", async () => {
          const base = await peek();
          // Lower — ignored, not written. A worker whose cursor lags must
          // not be able to rewind the checkpoint.
          await store.subscribe([], base - 5);
          expect(await peek()).toBe(base);
          // Equal — a no-op, so re-sending the same value is safe.
          await store.subscribe([], base);
          expect(await peek()).toBe(base);
          // Greater — advances.
          await store.subscribe([], base + 3);
          expect(await peek()).toBe(base + 3);
        });

        it("is left untouched when subscribe omits it", async () => {
          const base = await peek();
          await store.subscribe([]);
          expect(await peek()).toBe(base);
        });

        it("advances in the same call that registers discovered targets", async () => {
          // The shape correlate actually issues: here are the targets I
          // found, and here is how far I read to find them.
          const base = await peek();
          const s = `cp-sub-${uid()}`;
          const { subscribed, correlated_at } = await store.subscribe(
            [{ stream: s }],
            base + 7
          );
          expect(subscribed).toBe(1);
          expect(correlated_at).toBe(base + 7);
        });

        it("is invisible to every stream-scoped surface", async () => {
          const seen: string[] = [];
          await store.query_streams((p) => seen.push(p.stream), {});
          expect(seen.some((n) => n.startsWith("__correlate"))).toBe(false);
          expect(seen).not.toContain("correlated");
        });
      });

      // The subscription work set (#1485). `correlate` records the highest
      // event id that resolved to a target as that row's `correlated_at` mark,
      // and `claim` serves a marked stream from the subscription row alone —
      // `at < correlated_at` — instead of probing the event log per row. The
      // probe is what makes claim cost O(subscribed streams); the mark makes
      // it O(lease budget).
      //
      // `NULL` means UNKNOWN, not "no work": an unmarked row falls back to
      // the legacy probe, which is how an install that predates the column
      // keeps working. That arm is deleted once correlate marks universally.
      describe("subscription work set", () => {
        /** Claim just this stream, and say whether it came back. */
        const claimable = async (stream: string) => {
          const leased = await store.claim(100, 0, `w-${uid()}`, 1);
          const mine = leased.find((l) => l.stream === stream);
          // Release immediately so the next assertion is not fighting a
          // lease this helper took.
          if (mine) await store.ack([{ ...mine, at: mine.at }]);
          return mine !== undefined;
        };

        it("claims a marked stream without probing the event log", async () => {
          // The source has no events at all, so the legacy probe would say
          // "no work" — only the mark can make this claimable. That is the
          // whole point: eligibility comes from the subscription row.
          const s = `ws-mark-${uid()}`;
          await store.subscribe([{ stream: s, source: `ws-src-${uid()}` }]);
          expect(await claimable(s)).toBe(false);
          await store.subscribe([{ stream: s, correlated_at: 7 }]);
          expect(await claimable(s)).toBe(true);
          // A source-less subscription carries a mark the same way — the
          // mark is a property of the target, not of how it was sourced.
          const s2 = `ws-mark-nosrc-${uid()}`;
          await store.subscribe([{ stream: s2, correlated_at: 7 }]);
          expect(await claimable(s2)).toBe(true);
        });

        it("never regresses the mark, for every value on the number line", async () => {
          const s = `ws-mono-${uid()}`;
          await store.subscribe([
            { stream: s, source: `ws-none-${uid()}`, correlated_at: 10 },
          ]);
          // Park the watermark BETWEEN the stored mark and the lower values
          // below. Without this the row stays claimable whatever the mark
          // regressed to, and the assertions would prove nothing.
          const leased = await store.claim(100, 0, `w-${uid()}`, 10_000);
          await store.ack([
            { ...(leased.find((l) => l.stream === s) as Lease), at: 5 },
          ]);
          expect(await claimable(s)).toBe(true);
          // Lower, equal, and negative all leave the stored mark alone — the
          // shape the #1445 priority bug was on. Any of them landing would
          // drop `at = 5` out of the claimable set.
          await store.subscribe([{ stream: s, correlated_at: 4 }]);
          expect(await claimable(s)).toBe(true);
          await store.subscribe([{ stream: s, correlated_at: 5 }]);
          expect(await claimable(s)).toBe(true);
          await store.subscribe([{ stream: s, correlated_at: -3 }]);
          expect(await claimable(s)).toBe(true);
          await store.subscribe([{ stream: s, correlated_at: 0 }]);
          expect(await claimable(s)).toBe(true);
          // A higher one does advance it: catch the watermark up to the old
          // mark, and only the new one can put the stream back in the set.
          const leased2 = await store.claim(100, 0, `w-${uid()}`, 10_000);
          await store.ack([
            { ...(leased2.find((l) => l.stream === s) as Lease), at: 10 },
          ]);
          expect(await claimable(s)).toBe(false);
          await store.subscribe([{ stream: s, correlated_at: 11 }]);
          expect(await claimable(s)).toBe(true);
        });

        it("retires a stream when ack catches the watermark up to the mark", async () => {
          const s = `ws-retire-${uid()}`;
          await store.subscribe([
            { stream: s, source: `ws-none-${uid()}`, correlated_at: 5 },
          ]);
          const leased = await store.claim(100, 0, `w-${uid()}`, 10_000);
          const mine = leased.find((l) => l.stream === s);
          expect(mine).toBeDefined();
          // Watermark now equals the mark: nothing left that correlate
          // has seen, so the stream drops out of the claimable set.
          await store.ack([{ ...(mine as Lease), at: 5 }]);
          expect(await claimable(s)).toBe(false);
          // A later mark re-admits it — the set is not one-shot.
          await store.subscribe([{ stream: s, correlated_at: 6 }]);
          expect(await claimable(s)).toBe(true);
        });

        it("keeps the mark across reset, so a rebuild is claimable", async () => {
          const s = `ws-reset-${uid()}`;
          await store.subscribe([
            { stream: s, source: `ws-none-${uid()}`, correlated_at: 3 },
          ]);
          const leased = await store.claim(100, 0, `w-${uid()}`, 10_000);
          await store.ack([
            { ...(leased.find((l) => l.stream === s) as Lease), at: 3 },
          ]);
          expect(await claimable(s)).toBe(false);
          // reset rewinds the watermark to -1 and leaves the mark alone, so
          // `at < correlated_at` is true again and the replay can be claimed.
          await store.reset([s]);
          expect(await claimable(s)).toBe(true);
        });

        it("keeps the mark across unblock, defer, and prioritize", async () => {
          const s = `ws-ops-${uid()}`;
          await store.subscribe([
            { stream: s, source: `ws-none-${uid()}`, correlated_at: 9 },
          ]);
          const leased = await store.claim(100, 0, `w-${uid()}`, 10_000);
          const mine = leased.find((l) => l.stream === s) as Lease;
          await store.block([{ ...mine, error: "poison" }]);
          expect(await claimable(s)).toBe(false);
          expect(await store.unblock([s])).toBe(1);
          expect(await claimable(s)).toBe(true);
          // Deferred to the future: held out of claim, mark untouched.
          await store.defer([s], Date.now() + 60_000);
          expect(await claimable(s)).toBe(false);
          await store.defer([s], Date.now() - 1);
          expect(await claimable(s)).toBe(true);
          // Operator priority override does not disturb eligibility.
          await store.prioritize({ stream: s, stream_exact: true }, 5);
          expect(await claimable(s)).toBe(true);
        });

        it("never claims an unmarked stream, however much work the log holds", async () => {
          // NULL is not "no work" and no longer "unknown, go and look" — it
          // is "correlate has not spoken for this row", and `claim` has
          // nothing else to consult since #1488. The events below are real
          // work for this subscription; only the mark makes them claimable.
          const s = `ws-unmarked-${uid()}`;
          const src = `ws-unmarked-src-${uid()}`;
          await store.subscribe([{ stream: s, source: src }]);
          const [event] = await store.commit<CounterEvents>(
            src,
            [inc(1)],
            make_meta({ stream: src })
          );
          expect(await claimable(s)).toBe(false);
          await store.subscribe([{ stream: s, correlated_at: event.id }]);
          expect(await claimable(s)).toBe(true);
        });

        it("surfaces the mark on query_streams positions", async () => {
          // Readers other than `claim` need the same distinction it makes:
          // a watermark below an event id says nothing about pending work,
          // the mark does. The close-cycle safety guard is the first caller
          // to ask (#1487), and an unmarked row must read as UNKNOWN there
          // too — `undefined`, never 0.
          const marked = `ws-pos-${uid()}`;
          const unmarked = `ws-pos-none-${uid()}`;
          await store.subscribe([
            { stream: marked, source: `ws-none-${uid()}`, correlated_at: 12 },
            { stream: unmarked, source: `ws-none-${uid()}` },
          ]);
          const position = async (stream: string) => {
            let row: StreamPosition | undefined;
            await store.query_streams(
              (p) => {
                row = p;
              },
              { stream, stream_exact: true }
            );
            return row;
          };
          expect((await position(marked))?.correlated_at).toBe(12);
          expect((await position(unmarked))?.correlated_at).toBeUndefined();
        });
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
        await correlate();
        const leased = await store.claim(100, 0, by, 10_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        expect(mine!.by).toBe(by);
        // claim bumped retry from -1 to 0; a non-due ack clears it back to -1.
        expect(mine!.retry).toBe(0);
        const acked = await store.ack([
          { ...(mine as Lease), at: mine!.at + 1 },
        ]);
        // The returned lease reflects the post-ack row, not the caller's
        // pre-ack echo — `retry` is the authoritative -1 on every adapter
        // (#1347), and stream/source/lane carry through from the row.
        const ackedMine = acked.find((l) => l.stream === s);
        expect(ackedMine).toBeDefined();
        expect(ackedMine!.retry).toBe(-1);
        expect(ackedMine!.lane).toBe(mine!.lane);
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
        await correlate();
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
        await correlate();
        const leasedB = await store.claim(100, 0, `wB-${uid()}`, 100_000);
        expect(leasedB.length).toBeGreaterThan(0);
        expect(leasedB.find((l) => l.stream === s)).toBeUndefined();
        expect(leasedB.find((l) => l.stream === other)).toBeDefined();
      });

      // The two halves of what happens when a holder overruns its lease
      // (#1418). Both are load-bearing for the drain: the first is why a
      // slow worker's round of work is discarded, the second is why the
      // budget still accrues so a later holder can act on it.
      it("drops the ack of a holder whose lease was taken, and accrues retry per claim", async () => {
        const s = `claim-stolen-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2)],
          make_meta({ stream: s })
        );

        // A takes a lease it will overrun.
        await correlate();
        const leasedA = await store.claim(100, 0, `wA-${uid()}`, 1);
        const a = leasedA.find((l) => l.stream === s) as Lease;
        expect(a).toBeDefined();
        expect(a.retry).toBe(0);

        // The lease lapses while A is still "working".
        await new Promise((r) => setTimeout(r, 50));

        // B steals it, and the claim advances the budget again.
        await correlate();
        const leasedB = await store.claim(100, 0, `wB-${uid()}`, 100_000);
        const b = leasedB.find((l) => l.stream === s) as Lease;
        expect(b).toBeDefined();
        expect(b.retry).toBe(1);

        // A finishes and acks — too late. A short return, not an error:
        // the ownership guard is what stops A regressing a watermark B is
        // about to advance.
        const late = await store.ack([{ ...a, at: a.at + 1 }]);
        expect(late).toEqual([]);

        // A's watermark never landed, and the budget B will see keeps the
        // count of claims that produced no acknowledged progress.
        const rows: StreamPosition[] = [];
        await store.query_streams((r) => rows.push(r), { stream: s });
        expect(rows[0]?.at).toBe(a.at);
        expect(rows[0]?.retry).toBe(1);
        expect(rows[0]?.blocked).toBe(false);
      });

      it("supports dual frontiers (lagging + leading)", async () => {
        const s = `claim-dual-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1), inc(2)],
          make_meta({ stream: s })
        );
        await correlate();
        const first = await store.claim(100, 0, `w-${uid()}`, 1);
        const mine = first.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        await store.ack([{ ...(mine as Lease), at: (mine as Lease).at + 1 }]);
        await correlate();
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
            await correlate(fresh);
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
        await correlate();
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
        await correlate();
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
        await correlate();
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
          await correlate(fresh);
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
          await correlate(fresh);
          const first = await fresh.claim(1, 0, `w-${uid()}`, 0);
          const f = first.find((l) => l.stream === s);
          expect(f).toBeDefined();
          expect(f!.retry).toBe(0);
          // Re-claim without an intervening ack = the first retry.
          await correlate(fresh);
          const second = await fresh.claim(1, 0, `w-${uid()}`, 100_000);
          const sec = second.find((l) => l.stream === s);
          expect(sec).toBeDefined();
          expect(sec!.retry).toBe(1);
        } finally {
          await fresh.dispose();
        }
      });

      it("records the lease holder for a zero-length lease, so its ack lands", async () => {
        // `millis` bounds how long a lease stands, not whether it was
        // granted. A store that skips recording the holder for a
        // zero-length lease hands out a lease whose every `ack` is dropped
        // — the watermark never advances and every event is redelivered on
        // every drain, silently and forever. `leaseMillis: 0` is legal
        // config, so this is reachable from type-checked source.
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const s = `lease-zero-${uid()}`;
          await fresh.subscribe([{ stream: s }]);
          const [committed] = await fresh.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
          await correlate(fresh);
          const leased = await fresh.claim(1, 0, `w-${uid()}`, 0);
          const mine = leased.find((l) => l.stream === s);
          expect(mine).toBeDefined();

          const acked = await fresh.ack([{ ...mine!, at: committed.id }]);
          expect(acked).toHaveLength(1);

          let at = -1;
          await fresh.query_streams(
            (p) => {
              at = p.at;
            },
            { stream: s, stream_exact: true }
          );
          expect(at).toBe(committed.id);
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
          await correlate(fresh);
          const lag = await fresh.claim(1, 0, `w-${uid()}`, 0);
          expect(lag.find((l) => l.stream === s)?.lagging).toBe(true);
          // Leading-only budget on the released lease: claimed from the
          // leading frontier → lagging must be false. `lagging` is
          // frontier membership, not a function of the stream's watermark.
          await correlate(fresh);
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
          await correlate(fresh);
          const a = await fresh.claim(1, 0, `wA-${uid()}`, 0);
          expect(a.find((l) => l.stream === s)?.retry).toBe(0);
          // Worker B reclaims after the timeout: the budget marches.
          await correlate(fresh);
          const b = await fresh.claim(1, 0, `wB-${uid()}`, 30_000);
          const b_lease = b.find((l) => l.stream === s);
          expect(b_lease).toBeDefined();
          expect(b_lease!.retry).toBe(1);
          // Ack resets the budget: the next claim is a first attempt again.
          await fresh.ack([{ ...(b_lease as Lease), at: e1.id }]);
          await seed_stream(fresh, s, 1);
          await correlate(fresh);
          const c = await fresh.claim(1, 0, `wC-${uid()}`, 30_000);
          expect(c.find((l) => l.stream === s)?.retry).toBe(0);
        } finally {
          await fresh.dispose();
        }
      });
    });

    // A subscription's `source` is the window its FETCH reads — a literal
    // stream name matched by equality, or a portable pattern. It is no
    // longer anything to `claim`, which since #1488 answers eligibility
    // from the row's mark alone and never reads the event log.
    //
    // The matching itself did not disappear, it moved up a layer: correlate
    // applies it when deciding which events may raise a target's mark
    // (`_in_fetch_window`, #1487), and the cases that used to live here —
    // exact names never overmatching a sibling prefix (ACT-1182), pattern
    // sources claiming only on a real match (ACT-1220) — are now in
    // `libs/act/test/correlate-work-mark.spec.ts`. What remains here is
    // what the store still owns: the fetch window, source portability, and
    // lease exclusivity.
    describe("source windows and lease exclusivity", () => {
      it("receives exactly its source stream's events", async () => {
        const fresh = await options.factory();
        try {
          await fresh.drop();
          await fresh.seed();
          const base = `src-${uid()}`;
          const target = `agg-${uid()}`;
          await fresh.subscribe([{ stream: target, source: base }]);
          const [e1] = await seed_stream(fresh, base, 1);
          await correlate(fresh);
          const first = await fresh.claim(100, 0, `w-${uid()}`, 30_000);
          const f = first.find((l) => l.stream === target);
          expect(f).toBeDefined();
          expect(f!.source).toBe(base);
          await fresh.ack([{ ...(f as Lease), at: e1.id }]);
          // A fresh commit on the exact source makes the stream claimable
          // again, and the fetch window (source + after watermark) yields
          // exactly the new event.
          const [e2] = await seed_stream(fresh, base, 1);
          await correlate(fresh);
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
          await correlate(fresh);
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

    // ACT-1220's pattern-source claim cases are gone with the probe (#1488).
    // A pattern source (one carrying regex metacharacters, like the
    // calculator's `^(A|B)$`) is still matched as a full RegExp — but by
    // correlate, when it decides which events may raise a target's mark,
    // not by `claim`, which no longer reads the event log. The cases now
    // live in `libs/act/test/correlate-work-mark.spec.ts`.

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
          await correlate(fresh);
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
          await correlate(fresh);
          const a = await fresh.claim(100, 100, `wA-${uid()}`, 60_000);
          expect(a.find((l) => l.stream === s)).toBeDefined();
          // Subscribe `other` only AFTER A's claim so B's claim comes back
          // populated and the negative assertion runs through a non-empty
          // array (mirrors "does not double-claim a held lease").
          await fresh.subscribe([{ stream: other }]);
          await seed_stream(fresh, other, 1);
          await correlate(fresh);
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
          await correlate(fresh);
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
          await correlate(fresh);
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
        await correlate();
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
        await correlate();
        const again = await store.claim(100, 100, `w2-${uid()}`, 100_000);
        expect(again.find((l) => l.stream === s)).toBeUndefined();
      });

      it("returns the post-block row, not the caller's lease (#1382)", async () => {
        // `run_drain_cycle` hands `block()` a lease whose `at` has been
        // fast-forwarded to the fetch ceiling, but a block deliberately
        // leaves the watermark alone — the failing event must be retried,
        // not skipped. So the returned lease must carry the DURABLE `at`.
        // Re-reading via query_streams isn't enough: it reflects the
        // correct durable value either way, which is how #1347 and #1382
        // both slipped past this suite.
        const s = `block-returns-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await correlate();
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        await store.ack(leased.filter((l) => l.stream !== s));

        // Block with an `at` the row does NOT hold.
        const blocked = await store.block([
          { ...(mine as Lease), at: 999_999, error: "boom" },
        ]);
        expect(blocked).toHaveLength(1);

        let durable_at: number | undefined;
        await store.query_streams(
          (p) => {
            durable_at = p.at;
          },
          { stream: s, stream_exact: true }
        );
        expect(blocked[0].at).toBe(durable_at);
      });

      it("rejects block calls from a different holder", async () => {
        const s = `block-wrong-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await correlate();
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
        await correlate();
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
        await correlate();
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
        await correlate();
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
        await correlate();
        await store.claim(100, 100, `w1-${uid()}`, 100_000);
        await correlate();
        await store.claim(100, 100, `w2-${uid()}`, 100_000);
        // Re-defer into the past so it becomes claimable, then observe retry.
        await store.defer([s], Date.now() - 1_000);
        await correlate();
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
        await correlate();
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
        await correlate();
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        expect(leased.find((l) => l.stream === ctl)).toBeDefined();
        expect(leased.find((l) => l.stream === a)).toBeUndefined();
        expect(leased.find((l) => l.stream === b)).toBeUndefined();
      });

      it("returns 0 for unknown streams and empty input", async () => {
        expect(await store.defer([`missing-${uid()}`], Date.now())).toBe(0);
        expect(await store.defer([], Date.now())).toBe(0);
      });

      it("counts a duplicated stream name once (#1360)", async () => {
        const s = `defer-dup-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        // A repeated name matches one stream — the count is distinct streams,
        // matching PG's set-based `WHERE stream = ANY(...)`.
        expect(await store.defer([s, s], Date.now() + 3_600_000)).toBe(1);
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
        await correlate();
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
        await correlate();
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
        await correlate();
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s)!;
        await store.ack([{ ...mine, due: Date.now() - 1_000, retry: -1 }]);
        await correlate();
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
        await correlate();
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s)!;
        // Persist retry 3 with a past due-time so it's immediately re-claimable.
        // `at` = the claim watermark (no progress), so the advance is a no-op.
        await store.ack([{ ...mine, due: Date.now() - 1_000, retry: 3 }]);
        await correlate();
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
        await correlate();
        const leased = await store.claim(100, 100, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s)!;
        expect(mine.at).toBeLessThan(e1.id); // fresh stream — floor below e1
        // Advance to e1 (last succeeded) AND defer with a past due-time (so it's
        // immediately re-claimable) carrying the climbing retry.
        await store.ack([
          { ...mine, at: e1.id, due: Date.now() - 1_000, retry: 2 },
        ]);
        await correlate();
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
        await correlate();
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
        await correlate();
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        expect(mine).toBeDefined();
        await store.ack([{ ...(mine as Lease), at: 99 }]);
        expect(await store.reset([s])).toBe(1);
        await correlate();
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
        await correlate();
        const leased = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const mine = leased.find((l) => l.stream === s);
        const others = leased.filter((l) => l.stream !== s);
        await store.ack(others);
        await store.block([{ ...(mine as Lease), error: "boom" }]);
        expect(await store.reset([s])).toBe(1);
        await correlate();
        const after = await store.claim(100, 0, `w2-${uid()}`, 100_000);
        expect(after.find((l) => l.stream === s)).toBeDefined();
      });

      it("returns 0 for unknown streams and empty input", async () => {
        expect(await store.reset([`missing-${uid()}`])).toBe(0);
        expect(await store.reset([])).toBe(0);
      });

      it("counts a duplicated stream name once (#1360)", async () => {
        const s = `reset-dup-${uid()}`;
        await store.subscribe([{ stream: s }]);
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        // A repeated name matches one stream — the count is distinct streams,
        // matching PG's set-based `WHERE stream = ANY(...)`.
        expect(await store.reset([s, s])).toBe(1);
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
        await correlate();
        const first = await store.claim(100, 0, `w-${uid()}`, 100_000);
        const m1 = first.find((l) => l.stream === s);
        await store.ack([{ ...(m1 as Lease), at: m1!.at }]);

        // Capture watermark before block.
        await correlate();
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
        await correlate();
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
        await correlate();
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
        await correlate();
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
        await correlate();
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
        await correlate();
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
        await correlate();
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
        await correlate();
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

        await correlate();
        const slow = await store.claim(50, 0, `w-slow-${tag}`, 1_000, "slow");
        const slow_mine = slow.filter(
          (l) => l.stream === sub_default || l.stream === sub_slow
        );
        expect(slow_mine.map((l) => l.stream)).toEqual([sub_slow]);
        expect(slow_mine[0]?.lane).toBe("slow");
        await store.ack(slow_mine.map((l) => ({ ...l, at: l.at + 1 })));

        await correlate();
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
        await correlate();
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
        await correlate();
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

    describe("long identifiers", () => {
      it("accepts a stream name well past 100 characters (#1420)", async () => {
        // The framework DERIVES identifiers from stream names — `.autocloses`
        // synthesizes `"__autoclose__:" + stream` — so a cap here is not a
        // user-input limit, it silently breaks framework-generated targets.
        const tag = uid();
        const long = `${tag}-${"x".repeat(140)}`;
        await store.commit<CounterEvents>(
          long,
          [inc(1)],
          make_meta({ stream: long })
        );
        await store.subscribe([
          { stream: `__autoclose__:${long}`, source: long },
        ]);

        const seen: string[] = [];
        await store.query<CounterEvents>((e) => seen.push(e.stream), {
          stream: long,
          stream_exact: true,
        });
        expect(seen).toEqual([long]);

        const subs: string[] = [];
        await store.query_streams((p) => subs.push(p.stream), { limit: 500 });
        expect(subs).toContain(`__autoclose__:${long}`);
      });
    });

    describe("truncate", () => {
      it("leaves subscriptions untouched for restart and retire alike (#1527)", async () => {
        // `truncate` is purely event-log work. It used to remove the
        // subscription row for a retire, and that single step was the only
        // one spanning both the event log and the subscription table — which
        // forced a store whose halves live on different systems into a
        // distributed transaction it could not have.
        //
        // Leaving the row costs nothing. A tombstoned stream refuses new
        // commits, so no scan can raise its work mark and `claim` never
        // returns it again (pinned by the next case). What the row keeps is
        // the consumer's final watermark — a record of how far it got, which
        // outlives the events. Operators reclaim the space on their own
        // schedule; see the production checklist.
        const tag = uid();
        const restarted = `trunc-restart-${tag}`;
        const retired = `trunc-retire-${tag}`;
        for (const s of [restarted, retired]) {
          await store.subscribe([{ stream: s }]);
          await store.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );
        }

        await store.truncate([
          {
            stream: restarted,
            snapshot: { count: 1 },
            meta: make_meta({ stream: restarted }),
          },
          { stream: retired, meta: make_meta({ stream: retired }) },
        ]);

        const rows: string[] = [];
        await store.query_streams((p) => rows.push(p.stream), {
          stream: `trunc-.*-${tag}`,
          limit: 100,
        });
        expect(rows).toContain(restarted);
        expect(rows).toContain(retired);
      });

      it("leaves a retired stream's surviving subscription unclaimable (#1527)", async () => {
        // The property that makes leaving the row safe, and the reason the
        // framework can stop removing it. If this ever fails, retired streams
        // start handing work back to the drain.
        //
        // The subscription gets its own lane so both claims below can only
        // ever return this stream — which lets the assertion be "nothing came
        // back" rather than a search through whatever else the shared store
        // has pending.
        const lane = `inert-lane-${uid()}`;
        const s = `trunc-inert-${uid()}`;
        const [e] = await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        await store.subscribe([{ stream: s, correlated_at: e.id, lane }]);

        // Catch the subscription up, which is the state `close` requires
        // before it will retire a stream at all — a stream with pending
        // reactions is skipped, never truncated.
        const leased = await store.claim(100, 0, `w-${uid()}`, 10_000, lane);
        expect(leased).toHaveLength(1);
        await store.ack([{ ...leased[0], at: e.id }]);

        await store.truncate([{ stream: s, meta: make_meta({ stream: s }) }]);

        expect(
          await store.claim(100, 0, `w-${uid()}`, 10_000, lane)
        ).toHaveLength(0);
      });

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
      it("keyset pagination visits every stream regardless of name case (#1375)", async () => {
        // The `query_streams` twin of #1357. Mixed-case suffixes so the
        // sort comparator and the `after` cursor must agree: code-unit
        // order is B,C,a,d; a locale sort (a,B,C,d) paired with a
        // code-unit `<=` cursor silently skips Bravo/Charlie.
        const tag = uid();
        const names = [
          `${tag}-Bravo`,
          `${tag}-alpha`,
          `${tag}-Charlie`,
          `${tag}-delta`,
        ];
        await store.subscribe(names.map((stream) => ({ stream })));

        const visited: string[] = [];
        let after: string | undefined;
        for (;;) {
          const page: string[] = [];
          await store.query_streams((p) => page.push(p.stream), {
            stream: `${tag}-.*`,
            after,
            limit: 1,
          });
          if (page.length === 0) break;
          visited.push(...page);
          after = page.at(-1);
        }
        expect([...visited].sort()).toEqual([...names].sort());
      });

      it("limit: 0 returns no rows", async () => {
        // The bound is applied before a row is emitted, not after it — an
        // after-the-fact check lets exactly one row through.
        const s = `qs-zero-${uid()}`;
        await store.subscribe([{ stream: s }]);
        const seen: string[] = [];
        const push = (p: { stream: string }) => {
          seen.push(p.stream);
        };
        const filter = { stream: s, stream_exact: true };

        // CONTROL — the same query under the default bound sees the row.
        const control = await store.query_streams(push, filter);
        expect(control.count).toBe(1);
        expect(seen).toEqual([s]);

        seen.length = 0;
        const { count } = await store.query_streams(push, {
          ...filter,
          limit: 0,
        });
        expect(seen).toEqual([]);
        expect(count).toBe(0);
      });

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
        await correlate();
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
        expect((stats.get(sA)!.head.data as { amount: number }).amount).toBe(2);
        expect(stats.get(sB)?.head.name).toBe("Decremented");
        expect((stats.get(sB)!.head.data as { amount: number }).amount).toBe(5);
        expect(stats.has(sUnasked)).toBe(false);

        // Empty input — empty result.
        const empty = await store.query_stats([]);
        expect(empty.size).toBe(0);

        // Unknown stream name — absent, not an error.
        const unknown = await store.query_stats([`qst-${tag}-missing`]);
        expect(unknown.size).toBe(0);
      });

      it("limit: 0 returns no rows", async () => {
        const s = `qst-zero-${uid()}`;
        await store.commit<CounterEvents>(
          s,
          [inc(1)],
          make_meta({ stream: s })
        );
        const filter = { stream: s, stream_exact: true };

        // CONTROL — unbounded, the stream is there to be counted.
        const control = await store.query_stats<CounterEvents>(filter);
        expect(control.size).toBe(1);

        const stats = await store.query_stats<CounterEvents>(filter, {
          limit: 0,
        });
        expect(stats.size).toBe(0);
      });

      it("keyset pagination visits every stream regardless of name case (#1357)", async () => {
        // Mixed-case suffixes so the sort comparator and the `after` cursor
        // must agree: code-unit order is B,C,a,d; a locale sort (a,B,C,d)
        // paired with a code-unit `<=` cursor silently skips Bravo/Charlie.
        const tag = uid();
        const names = [
          `${tag}-Bravo`,
          `${tag}-alpha`,
          `${tag}-Charlie`,
          `${tag}-delta`,
        ];
        for (const s of names)
          await store.commit<CounterEvents>(
            s,
            [inc(1)],
            make_meta({ stream: s })
          );

        const visited: string[] = [];
        let after: string | undefined;
        // Terminates on the first empty page — a correct adapter yields one
        // stream per page then an empty page; a comparator mismatch would drop
        // rows but still exhaust the cursor and terminate.
        let page = await store.query_stats<CounterEvents>(
          { stream: tag },
          { after, limit: 1 }
        );
        while (page.size > 0) {
          for (const k of page.keys()) visited.push(k);
          after = [...page.keys()].at(-1);
          page = await store.query_stats<CounterEvents>(
            { stream: tag },
            { after, limit: 1 }
          );
        }
        expect([...visited].sort()).toEqual([...names].sort());
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
        expect((r!.head.data as { amount: number }).amount).toBe(3);
        expect(r?.tail?.name).toBe("Incremented");
        expect((r!.tail!.data as { amount: number }).amount).toBe(1);
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
        expect((all.get(s)!.head.data as { amount: number }).amount).toBe(3);

        // Exclude Incremented — head is now Decremented (the next-latest).
        const excl = await store.query_stats<CounterEvents>([s], {
          exclude: ["Incremented"],
        });
        expect(excl.get(s)?.head.name).toBe("Decremented");
        expect((excl.get(s)!.head.data as { amount: number }).amount).toBe(2);

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
        await correlate();
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
        expect((t.get(s)!.tail!.data as { amount: number }).amount).toBe(1);
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
    describe.skipIf(!caps.lease_correlation)(
      "correlation lease via subscribe (capability)",
      () => {
        const by = () => `corr-${uid()}`;
        const key = () => `key-${uid()}`;
        const take = (k: string, who: string, millis = 10_000) =>
          store.subscribe([], undefined, { key: k, by: who, millis });

        /**
         * Hand a lease back early.
         *
         * There is no release verb — expiry is the only path, deliberately,
         * so a crash and a clean stop behave identically. A holder can still
         * shorten its own lease, because re-acquiring as the same holder
         * renews and renewing to 1ms releases in all but name.
         */
        const release = async (k: string, who: string) => {
          await take(k, who, 1);
          await new Promise((r) => setTimeout(r, 20));
        };

        it("grants the lease to the first caller", async () => {
          const k = key();
          const who = by();
          expect((await take(k, who)).correlating).toBe(true);
          await release(k, who);
        });

        it("answers undefined when no correlator is supplied", async () => {
          // No lease was asked for, so there is no answer — and the caller
          // scans exactly as every pre-#1532 caller does.
          expect(await store.subscribe([])).not.toHaveProperty("correlating");
        });

        it("refuses a second holder while the lease is live", async () => {
          const k = key();
          const who = by();
          expect((await take(k, who)).correlating).toBe(true);
          // The whole point: two workers must not scan the same range.
          expect((await take(k, by())).correlating).toBe(false);
          await release(k, who);
        });

        it("lets the same holder renew rather than failing", async () => {
          const k = key();
          const who = by();
          expect((await take(k, who)).correlating).toBe(true);
          // Acquiring and extending are one call by design, so a holder keeps
          // its lease while it works without needing a second verb.
          expect((await take(k, who)).correlating).toBe(true);
          await release(k, who);
        });

        it("becomes available again once the lease expires", async () => {
          const k = key();
          expect((await take(k, by(), 1)).correlating).toBe(true);
          await new Promise((r) => setTimeout(r, 30));
          // Expiry is also the crash-recovery path: a dead holder must not
          // stall discovery forever.
          const next = by();
          expect((await take(k, next)).correlating).toBe(true);
          await release(k, next);
        });

        it("keys leases independently, so one correlator cannot starve another", async () => {
          // Correlators that look for different things are not
          // interchangeable. A worker running a subset of the reactions must
          // scan for itself, or its targets are never marked and its
          // reactions silently never run.
          const a = key();
          const b = key();
          const holder_a = by();
          const holder_b = by();
          expect((await take(a, holder_a)).correlating).toBe(true);
          expect((await take(b, holder_b)).correlating).toBe(true);
          await release(a, holder_a);
          await release(b, holder_b);
        });

        it("still advances the checkpoint for a caller that loses the lease", async () => {
          // A worker denied the lease may already have scanned and be
          // reporting how far it read. Dropping that would leave its marks
          // ahead of its recorded position, so the next pass would re-scan a
          // range it had already covered.
          const k = key();
          const holder = by();
          expect((await take(k, holder)).correlating).toBe(true);

          const loser = await store.subscribe([], 7_777, {
            key: k,
            by: by(),
            millis: 10_000,
          });
          expect(loser.correlating).toBe(false);
          expect(loser.correlated_at).toBeGreaterThanOrEqual(7_777);

          await release(k, holder);
        });

        it("seeds a new key from the shared floor, then lets it diverge", async () => {
          const a = key();
          const holder_a = by();
          const first = await store.subscribe([], 4_100, {
            key: a,
            by: holder_a,
            millis: 10_000,
          });
          expect(first.correlated_at).toBeGreaterThanOrEqual(4_100);

          // A key with no row yet inherits how far any correlator has read.
          // That is the pre-#1532 behaviour — one shared checkpoint, a fresh
          // worker resuming from it behind the cold-start back-scan — so an
          // upgrade does not re-read history.
          const b = key();
          const holder_b = by();
          const second = await store.subscribe([], undefined, {
            key: b,
            by: holder_b,
            millis: 10_000,
          });
          expect(second.correlated_at).toBeGreaterThanOrEqual(4_100);

          // After that they are independent: one correlator reading further
          // must not drag another's position forward, or the second would
          // skip events it never scanned.
          await store.subscribe([], 9_000, {
            key: a,
            by: holder_a,
            millis: 10_000,
          });
          const b_again = await store.subscribe([], undefined, {
            key: b,
            by: holder_b,
            millis: 10_000,
          });
          expect(b_again.correlated_at).toBe(second.correlated_at);

          await release(a, holder_a);
          await release(b, holder_b);
        });
      }
    );

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

      it("round-trips a Date losslessly in pii, like data/meta (#1365/#1370/#1556)", async () => {
        // A store persists bytes; it does not type them. JSON has no date
        // type, so a `Date` is stored as its ISO form and read back as that
        // same string — identically in `data` and `pii`, and whether or not
        // the adapter encrypts the pii column, since encryption is an
        // at-rest concern and not a payload-type change.
        //
        // Turning that string back into a `Date` is the framework's job,
        // driven by the `z.date()` the schema declares (#1556): an adapter
        // cannot know which strings were dates, and guessing from shape
        // revived any ISO-looking string — including fields declared
        // `z.string()`. The same Date in `data` is the in-row control.
        const s = `pii-date-${uid()}`;
        const when = new Date("2024-03-01T10:20:30.000Z");
        await store.commit<CounterEvents>(
          s,
          [
            {
              name: "Incremented",
              data: { amount: 1, at: when } as never,
              pii: { born: when },
            },
          ],
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
        const at = (seen[0].data as unknown as { at: unknown }).at;
        const born = (seen[0].pii as { born: unknown }).born;
        // The contract is LOSSLESS RECOVERY, not a particular runtime type.
        // A store that serializes (Postgres, SQLite) hands back the ISO form;
        // one that holds references (InMemory) hands back the `Date` itself.
        // Both are correct at this layer — an adapter cannot know which
        // strings were dates, so typing them is the framework's job, driven
        // by the declared `z.date()` (#1556). What every adapter owes is that
        // no precision is lost, identically in `data` and `pii`.
        const recovered = (v: unknown) =>
          v instanceof Date ? v.getTime() : new Date(v as string).getTime();
        expect(recovered(at)).toBe(when.getTime());
        expect(recovered(born)).toBe(when.getTime());
        // ...and that both columns are treated the same way, whichever it is.
        expect(typeof at).toBe(typeof born);
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
