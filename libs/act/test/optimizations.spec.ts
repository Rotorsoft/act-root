/**
 * ACT-1032 — guard the believed framework optimizations so a silent
 * regression fails a test instead of slipping through.
 *
 * #1024's lesson: "assume nothing is optimized until a test proves it."
 * Each block here asserts an *observable consequence* of an optimization
 * that lives in `libs/act/src` today, verified by reading the source:
 *
 *   (a) snapshot cadence — the `.snap(predicate)` strategy actually
 *       writes a `__snapshot__` event to the store when the predicate
 *       trips (event-sourcing.ts `action()` → `void snap(last)`).
 *   (b) batched projection replay — a static-target projection with
 *       `.batch(fn)` receives every claimed event in ONE call, not one
 *       call per event (reactions.ts `build_handle_batch`).
 *   (c) cache `after: cached.event_id` — a cache-warm load queries the
 *       store with `after` set and replays zero pre-cache rows
 *       (event-sourcing.ts `load()` query options).
 *   (d) autoclose sweep bound — every `query_stats` page is capped at
 *       `closeBatchSize` (autoclose-cycle.ts `run_autoclose_cycle`).
 *
 * The EXPLAIN guards for the #1024 partial snapshot index live in the
 * adapter packages (act-pg / act-sqlite) — InMemoryStore has no planner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  cache,
  dispose,
  projection,
  resolveAutocloseConfig,
  SNAP_EVENT,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";
import { run_autoclose_cycle } from "../src/internal/autoclose-cycle.js";
import { sandbox } from "../src/test/index.js";

const actor = { id: "a", name: "a" };
const Incremented = z.object({ by: z.number() });

// Plain counter, no snapshot strategy — used by the cache + batch guards.
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented })
  .patch({ Incremented: (e, s) => ({ count: s.count + e.data.by }) })
  .on({ increment: Incremented })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

describe("ACT-1032 optimization guards", () => {
  describe("(a) snapshot cadence triggers a __snapshot__ write at the interval", () => {
    // Snapshot every 5 patches. `patches` is the snap-distance accumulator
    // and resets to 0 each time a snapshot is written, so the predicate
    // trips once per 5 commits.
    const SnappingCounter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Incremented })
      .patch({ Incremented: (e, s) => ({ count: s.count + e.data.by }) })
      .on({ increment: Incremented })
      .emit((a) => ["Incremented", { by: a.by }])
      .snap((s) => s.patches >= 5)
      .build();

    it("writes one snapshot per 5 commits, none before", async () => {
      const { app, store, dispose } = await sandbox(
        act().withState(SnappingCounter)
      );
      try {
        const stream = "snap-cadence";
        const commitSpy = vi.spyOn(store, "commit");
        const snapCommits = () =>
          commitSpy.mock.calls.filter(([, events]) =>
            (events as { name: string }[]).some((e) => e.name === SNAP_EVENT)
          ).length;

        // The durable resume floor: a `with_snaps` query resumes at the
        // LATEST snapshot for the stream, so its head row is that snapshot
        // (id -1 / undefined when none exists yet). This is the very
        // optimization the snapshot write enables, so reading it back also
        // proves the snapshot landed durably — not just that commit was
        // attempted. `void snap(last)` is fire-and-forget, hence the poll.
        const latestSnapId = async (): Promise<number | undefined> => {
          let id: number | undefined;
          await store.query(
            (e) => {
              if (e.name === SNAP_EVENT) id = e.id;
            },
            { stream, stream_exact: true, with_snaps: true }
          );
          return id;
        };

        // `void snap(last)` invokes store.commit synchronously (up to its
        // first await) inside the awaited action(), so the spy has the
        // snapshot commit recorded by the time `do()` resolves — no poll.
        for (let i = 0; i < 4; i++)
          await app.do("increment", { stream, actor }, { by: 1 });
        expect(snapCommits()).toBe(0); // predicate hasn't tripped yet
        expect(await latestSnapId()).toBeUndefined();

        await app.do("increment", { stream, actor }, { by: 1 }); // 5th
        expect(snapCommits()).toBe(1);
        let firstSnapId = 0;
        await vi.waitFor(async () => {
          const id = await latestSnapId();
          expect(id).toBeTypeOf("number");
          firstSnapId = id!;
        });

        for (let i = 0; i < 5; i++)
          await app.do("increment", { stream, actor }, { by: 1 }); // 6th–10th
        expect(snapCommits()).toBe(2);
        // The resume floor advanced — a second, distinct snapshot persisted.
        await vi.waitFor(async () => {
          const id = await latestSnapId();
          expect(id).toBeGreaterThan(firstSnapId);
        });
      } finally {
        await dispose();
      }
    });
  });

  describe("(b) projections replay in batches, not one-by-one", () => {
    it("hands every claimed event to the batch handler in a single call", async () => {
      const batchFn = vi.fn().mockResolvedValue(undefined);
      const singleHandler = vi.fn().mockResolvedValue(undefined);

      const BatchProjection = projection("batch-proj")
        .on({ Incremented })
        .do(singleHandler)
        .batch(batchFn)
        .build();

      const { app, dispose } = await sandbox(
        act().withState(Counter).withProjection(BatchProjection)
      );
      try {
        const stream = "batch-src";
        await app.do("increment", { stream, actor }, { by: 1 });
        await app.do("increment", { stream, actor }, { by: 2 });
        await app.do("increment", { stream, actor }, { by: 3 });
        await app.correlate();
        await app.drain({ eventLimit: 100 });

        // The regression this guards: the batch path silently degrading to
        // per-event dispatch. If it did, batchFn would be called 3× with
        // length-1 arrays (or singleHandler would run instead).
        expect(singleHandler).not.toHaveBeenCalled();
        expect(batchFn).toHaveBeenCalledTimes(1);
        const [events] = batchFn.mock.calls[0];
        expect(events).toHaveLength(3);
        expect(
          (events as { data: { by: number } }[]).map((e) => e.data.by)
        ).toEqual([1, 2, 3]);
      } finally {
        await dispose();
      }
    });
  });

  describe("(c) cache 'after: cached.event_id' skips pre-cache rows on load", () => {
    it("a cache-warm load queries with `after` and replays zero rows", async () => {
      const { app, store, cache, dispose } = await sandbox(
        act().withState(Counter)
      );
      try {
        const stream = "cache-after";
        // action() warms the cache on every commit.
        for (let i = 0; i < 5; i++)
          await app.do("increment", { stream, actor }, { by: 1 });

        const cached = await cache.get(stream);
        expect(cached).toBeDefined();
        const cachedEventId = cached!.event_id;

        const querySpy = vi.spyOn(store, "query");
        const warm = await app.load(Counter, stream);

        // The optimization: resume strictly after the cached checkpoint.
        expect(querySpy).toHaveBeenCalledTimes(1);
        const [, options] = querySpy.mock.calls[0];
        expect(options).toMatchObject({ after: cachedEventId });
        expect(options).not.toHaveProperty("with_snaps");

        expect(warm.cache_hit).toBe(true);
        expect(warm.replayed).toBe(0); // no pre-cache rows scanned
        expect(warm.state.count).toBe(5);

        // Contrast: a cold load (cache invalidated) replays from the store
        // WITHOUT `after`, falling back to the with_snaps full path. If the
        // warm path above had silently lost its `after`, both loads would
        // look identical and this guard would be meaningless — so assert
        // the two paths actually diverge.
        await cache.invalidate(stream);
        querySpy.mockClear();
        const cold = await app.load(Counter, stream);
        const [, coldOptions] = querySpy.mock.calls[0];
        expect(coldOptions).not.toHaveProperty("after");
        expect(coldOptions).toMatchObject({ with_snaps: true });
        expect(cold.cache_hit).toBe(false);
        expect(cold.replayed).toBe(5);
      } finally {
        await dispose();
      }
    });
  });

  describe("(d) autoclose sweep stays bounded to the page size", () => {
    const Ticket = state({ Ticket: z.object({ open: z.boolean() }) })
      .init(() => ({ open: false }))
      .emits({
        TicketOpened: z.object({ title: z.string() }),
        TicketResolved: ZodEmpty,
      })
      .patch({
        TicketOpened: () => ({ open: true }),
        TicketResolved: () => ({ open: false }),
      })
      .on({ OpenTicket: z.object({ title: z.string() }) })
      .emit((a) => ["TicketOpened", { title: a.title }])
      .on({ ResolveTicket: ZodEmpty })
      .emit(() => ["TicketResolved", {}])
      .autocloses((_stream, head) => head.name === "TicketResolved")
      .build();

    beforeEach(async () => {
      await store().drop();
      await cache().clear();
    });

    afterEach(async () => {
      await dispose()();
    });

    it("caps every query_stats page at closeBatchSize while paging the whole store", async () => {
      const app = act().withState(Ticket).build();
      // 5 resolvable streams, page size 2 → pages of 2, 2, 1.
      for (let i = 0; i < 5; i++) {
        await app.do("OpenTicket", { stream: `t-${i}`, actor }, { title: "a" });
        await app.do("ResolveTicket", { stream: `t-${i}`, actor }, {});
      }

      const statsSpy = vi.spyOn(store(), "query_stats");

      const internals = app as unknown as {
        _event_to_state: never;
        _es: { load: never; tombstone: never };
        _logger: never;
        _reactive_events: { size: number };
      };
      const result = await run_autoclose_cycle({
        autoclose_policy: app.registry.autoclose_policy as never,
        autoclose_archiver: app.registry.autoclose_archiver as never,
        event_to_state: internals._event_to_state,
        reactive_events_size: internals._reactive_events.size,
        load: internals._es.load,
        tombstone: internals._es.tombstone,
        logger: internals._logger,
        config: resolveAutocloseConfig({ closeBatchSize: 2 }),
        correlation: "act-1032-page-bound",
      });

      // Every stream got closed in this one run.
      expect(result.inspected).toBe(5);
      expect(result.close_result.truncated.size).toBe(5);

      // The guard targets the pager's own query_stats calls — the ones
      // carrying a `limit`. (run_close_cycle issues its own unbounded
      // safety-probe query_stats per batch; that's a different concern and
      // is excluded by the `limit !== undefined` filter.)
      const pagerCalls = statsSpy.mock.calls
        .map((call, i) => ({
          options: call[1],
          result: statsSpy.mock.results[i],
        }))
        .filter((c) => (c.options as { limit?: number })?.limit !== undefined);

      // Pagination actually happened (5 streams / page 2 → 3 pages), and
      // every page request is capped at closeBatchSize. A regression that
      // dropped the `limit` would fetch all 5 in one unbounded query.
      expect(pagerCalls.length).toBeGreaterThan(1);
      for (const { options } of pagerCalls) {
        expect(options).toMatchObject({ limit: 2 });
      }
      // No page ever materialized more than the page size.
      for (const { result } of pagerCalls) {
        if (result.type === "return") {
          const page = await result.value;
          expect((page as Map<string, unknown>).size).toBeLessThanOrEqual(2);
        }
      }
    });
  });
});
