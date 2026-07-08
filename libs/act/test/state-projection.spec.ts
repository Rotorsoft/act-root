import { ZodError, z } from "zod";
import {
  act,
  cache,
  projection,
  sensitive,
  slice,
  state,
  store,
} from "../src/index.js";
import { SNAP_EVENT } from "../src/ports.js";
import { sandbox } from "../src/test/index.js";
import type { CacheEntry } from "../src/types/index.js";

const actor = { id: "a", name: "a" };

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: (event, state) => ({ count: state.count + event.data.by }),
  })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((action) => ["Incremented", { by: action.by }])
  .build();

const Tag = state({ Tag: z.object({ label: z.string() }) })
  .init(() => ({ label: "" }))
  .emits({ Tagged: z.object({ label: z.string() }) })
  .patch({ Tagged: (event) => ({ label: event.data.label }) })
  .on({ tag: z.object({ label: z.string() }) })
  .emit((action) => ["Tagged", action])
  .build();

type CounterState = { count: number };
type Row = CacheEntry<CounterState>;

function harness(options?: { flushEvery?: number; maxCachedStates?: number }) {
  const flushes: Row[][] = [];
  let fail_next = false;
  let fail_every = 0;
  let flush_calls = 0;
  const table = new Map<string, Row>();
  const counters = projection("counters")
    .of(Counter, options)
    .flush(async (rows) => {
      flush_calls++;
      if (fail_next || (fail_every > 0 && flush_calls % fail_every === 0)) {
        fail_next = false;
        throw new Error("sink down");
      }
      flushes.push([...rows]);
      // The documented contract: monotonic upsert keyed on stream.
      for (const row of rows) {
        const current = table.get(row.stream);
        if (!current || row.event_id >= current.event_id)
          table.set(row.stream, row);
      }
    })
    .build();
  return {
    counters,
    flushes,
    table,
    fail_next_flush: () => {
      fail_next = true;
    },
    fail_every_flush: (n: number) => {
      fail_every = n;
    },
  };
}

async function settle_all(app: {
  correlate: () => Promise<{ subscribed: number; last_id: number }>;
  drain: (options?: {
    leaseMillis?: number;
    eventLimit?: number;
  }) => Promise<{ acked: unknown[] }>;
}) {
  await app.correlate();
  for (;;) {
    const d = await app.drain({ leaseMillis: 10_000, eventLimit: 1_000 });
    if (d.acked.length === 0) return;
  }
}

describe("state projection (.of)", () => {
  it("folds every event into one row per stream, converging to head state", async () => {
    const h = harness();
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 1 });
      await app.do("increment", { stream: "c1", actor }, { by: 2 });
      await app.do("increment", { stream: "c2", actor }, { by: 5 });
      await settle_all(app);

      expect(h.table.get("c1")?.state).toEqual({ count: 3 });
      expect(h.table.get("c2")?.state).toEqual({ count: 5 });
      expect(h.table.get("c1")?.version).toBe(1);
      expect(h.table.get("c2")?.version).toBe(0);
      expect(h.table.get("c1")!.event_id).toBeGreaterThan(0);
    } finally {
      await ctx.dispose();
    }
  });

  it("keeps folding warm streams across drain cycles without losing state", async () => {
    const h = harness();
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 1 });
      await settle_all(app);
      await app.do("increment", { stream: "c1", actor }, { by: 10 });
      await settle_all(app);
      expect(h.table.get("c1")?.state).toEqual({ count: 11 });
    } finally {
      await ctx.dispose();
    }
  });

  it("flushes in rounds of flushEvery within a single batch", async () => {
    const h = harness({ flushEvery: 2 });
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      for (let i = 0; i < 5; i++)
        await app.do("increment", { stream: `c${i}`, actor }, { by: i });
      await settle_all(app);
      expect(h.flushes.length).toBeGreaterThanOrEqual(3);
      expect(h.table.size).toBe(5);
    } finally {
      await ctx.dispose();
    }
  });

  it("flushes the evictee before dropping it under maxCachedStates pressure", async () => {
    const h = harness({ maxCachedStates: 1, flushEvery: 1_000 });
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 7 });
      await app.do("increment", { stream: "c2", actor }, { by: 9 });
      await settle_all(app);
      // c1 was evicted to admit c2 — its folded work was flushed first.
      expect(h.table.get("c1")?.state).toEqual({ count: 7 });
      expect(h.table.get("c2")?.state).toEqual({ count: 9 });
      // the eviction produced a single-row flush ahead of the round flush
      expect(
        h.flushes.some((f) => f.length === 1 && f[0].stream === "c1")
      ).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  it("holds the watermark when flush fails and converges on retry", async () => {
    const h = harness();
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 4 });
      h.fail_next_flush();
      await app.correlate();
      const failed = await app.drain({ leaseMillis: 1 });
      expect(failed.acked.length).toBe(0);
      // retry after the lease expires — same events refold, same row lands
      await new Promise((r) => setTimeout(r, 5));
      await settle_all(app);
      expect(h.table.get("c1")?.state).toEqual({ count: 4 });
    } finally {
      await ctx.dispose();
    }
  });

  it("rebuilds in O(streams) upserts, not O(events)", async () => {
    const h = harness();
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      const STREAMS = 3;
      const EVENTS_PER_STREAM = 10;
      for (let e = 0; e < EVENTS_PER_STREAM; e++)
        for (let s = 0; s < STREAMS; s++)
          await app.do("increment", { stream: `c${s}`, actor }, { by: 1 });
      await settle_all(app);

      h.flushes.length = 0;
      await app.reset(["counters"]);
      await settle_all(app);

      const upserts = h.flushes.flat().length;
      // one row per stream per flush round — the whole rebuild fits one
      // fetch window here, so exactly one round
      expect(upserts).toBe(STREAMS);
      for (let s = 0; s < STREAMS; s++)
        expect(h.table.get(`c${s}`)?.state).toEqual({
          count: EVENTS_PER_STREAM,
        });
    } finally {
      await ctx.dispose();
    }
  });

  it("scopes the fold to the projected state's streams in a multi-state app", async () => {
    const h = harness();
    const ctx = await sandbox(
      act().withState(Counter).withState(Tag).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 1 });
      await app.do("tag", { stream: "t1", actor }, { label: "x" });
      await settle_all(app);
      expect(h.table.has("c1")).toBe(true);
      expect(h.table.has("t1")).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });

  it("skips the flush for a clean evictee and for empty rounds", async () => {
    const h = harness({ maxCachedStates: 1, flushEvery: 1 });
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      // round 1: c1 folds and flushes — its cache entry is now clean
      await app.do("increment", { stream: "c1", actor }, { by: 1 });
      await settle_all(app);
      const flushes_after_round1 = h.flushes.length;
      // round 2: admitting c2 evicts a CLEAN c1 — no eviction flush; and
      // with flushEvery=1 the end-of-batch round finds nothing dirty
      await app.do("increment", { stream: "c2", actor }, { by: 2 });
      await settle_all(app);
      const c1_reflushes = h.flushes
        .slice(flushes_after_round1)
        .flat()
        .filter((r) => r.stream === "c1");
      expect(c1_reflushes).toHaveLength(0);
      expect(h.table.get("c2")?.state).toEqual({ count: 2 });
    } finally {
      await ctx.dispose();
    }
  });

  it("folds pii-aware states through the replay path (no cache entry)", async () => {
    const Person = state({
      Person: z.object({ email: sensitive(z.string()) }),
    })
      .init(() => ({ email: "" }))
      .emits({ Registered: z.object({ email: sensitive(z.string()) }) })
      .patch({ Registered: (event) => ({ email: event.data.email }) })
      .on({ register: z.object({ email: z.string() }) })
      .emit((action) => ["Registered", action])
      .build();
    const rows_seen: string[] = [];
    const people = projection("people")
      .of(Person)
      .flush(async (rows) => {
        for (const row of rows) rows_seen.push(row.stream);
      })
      .build();
    const ctx = await sandbox(act().withState(Person).withProjection(people));
    try {
      const app = ctx.app;
      await app.do("register", { stream: "p1", actor }, { email: "a@b.c" });
      await settle_all(app);
      expect(rows_seen).toContain("p1");
    } finally {
      await ctx.dispose();
    }
  });

  it("resumes the first-sight load from the latest snapshot", async () => {
    const h = harness();
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 1 });
      await app.do("increment", { stream: "c1", actor }, { by: 2 });
      // Snapshot at the head, then more traffic on top of it.
      await store().commit("c1", [{ name: SNAP_EVENT, data: { count: 3 } }], {
        correlation: "t",
        causation: {},
      });
      await app.do("increment", { stream: "c1", actor }, { by: 4 });
      // Cold engine + cold act cache: the miss-load must take the
      // snapshot floor (#1024) and fold only the tail on top of it.
      await cache().invalidate("c1");
      await settle_all(app);
      expect(h.table.get("c1")?.state).toEqual({ count: 7 });
    } finally {
      await ctx.dispose();
    }
  });

  it("converges after a mid-round failure with partial flush progress", async () => {
    // flushEvery=1 → one flush per event; the second flush throws AFTER
    // the first landed. The watermark holds, the retry re-folds both
    // streams, and the monotonic upsert converges — partial progress
    // never leaves a stale row behind.
    const h = harness({ flushEvery: 1 });
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 3 });
      await app.do("increment", { stream: "c2", actor }, { by: 5 });
      h.fail_every_flush(2); // second flush call throws
      await app.correlate();
      await app.drain({ leaseMillis: 1, eventLimit: 1_000 });
      h.fail_every_flush(0);
      await new Promise((r) => setTimeout(r, 5));
      await settle_all(app);
      expect(h.table.get("c1")?.state).toEqual({ count: 3 });
      expect(h.table.get("c2")?.state).toEqual({ count: 5 });
    } finally {
      await ctx.dispose();
    }
  });

  it("keeps rows truthful under eviction thrash within one batch", async () => {
    // maxCachedStates=1 with interleaved streams: every admission evicts
    // the other stream mid-batch, and re-admission re-loads head state.
    const h = harness({ maxCachedStates: 1 });
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      for (const [s2, by] of [
        ["c1", 1],
        ["c2", 10],
        ["c1", 2],
        ["c2", 20],
        ["c1", 3],
        ["c2", 30],
      ] as const)
        await app.do("increment", { stream: s2, actor }, { by });
      await settle_all(app);
      expect(h.table.get("c1")?.state).toEqual({ count: 6 });
      expect(h.table.get("c2")?.state).toEqual({ count: 60 });
    } finally {
      await ctx.dispose();
    }
  });

  it("chaos oracle: rows equal load() ground truth after failures and recovery", async () => {
    // Deterministic chaos: seeded traffic across 8 streams interleaved
    // with drains, every 5th flush failing, a 2-state LRU forcing
    // constant eviction, tiny flush rounds. The projection may block on
    // exhausted retries — the operator move (unblock) must bring every
    // row back to exact ground truth: table.state === load().state.
    const h = harness({ maxCachedStates: 2, flushEvery: 3 });
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      const STREAMS = 8;
      let seed = 42;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed;
      };
      h.fail_every_flush(5);
      for (let i = 0; i < 120; i++) {
        const s2 = `c${rand() % STREAMS}`;
        await app.do("increment", { stream: s2, actor }, { by: (i % 7) + 1 });
        if (i % 17 === 0) {
          await app.correlate();
          await app.drain({ leaseMillis: 1, eventLimit: 50 });
          await new Promise((r) => setTimeout(r, 3));
        }
      }
      // recovery: stop failing, release any quarantine, settle fully
      h.fail_every_flush(0);
      await app.unblock({ blocked: true });
      await new Promise((r) => setTimeout(r, 5));
      await settle_all(app);

      for (let s2 = 0; s2 < STREAMS; s2++) {
        const stream = `c${s2}`;
        const truth = await app.load(Counter, stream);
        if (truth.event === undefined) continue; // stream never traded
        expect(h.table.get(stream)?.state, stream).toEqual(truth.state);
        expect(h.table.get(stream)?.version, stream).toBe(truth.event.version);
      }
    } finally {
      await ctx.dispose();
    }
  });

  it("freezes a tombstoned stream's row at its final state", async () => {
    const h = harness();
    const ctx = await sandbox(
      act().withState(Counter).withProjection(h.counters)
    );
    try {
      const app = ctx.app;
      await app.do("increment", { stream: "c1", actor }, { by: 9 });
      await settle_all(app);
      await app.close([{ stream: "c1" }]);
      await app.do("increment", { stream: "c2", actor }, { by: 1 });
      await settle_all(app);
      // the closed stream's row is untouched; live traffic keeps flowing
      expect(h.table.get("c1")?.state).toEqual({ count: 9 });
      expect(h.table.get("c2")?.state).toEqual({ count: 1 });
    } finally {
      await ctx.dispose();
    }
  });

  it("routes fetches through a named no-op reaction (dispatch is the batch handler)", async () => {
    const h = harness();
    const register = h.counters.events.Incremented;
    expect(register).toBeDefined();
    const reaction = register.reactions.get("counters_fold");
    expect(reaction?.resolver).toEqual({ target: "counters" });
    // The no-op only routes; invoking it is harmless and proves it.
    await expect(
      reaction!.handler({} as never, "counters", undefined as never)
    ).resolves.toBeUndefined();
  });

  it("folds a sliced state through the registry-merged reducers", async () => {
    const PartA = state({
      Pair: z.object({ ups: z.number(), downs: z.number() }),
    })
      .init(() => ({ ups: 0, downs: 0 }))
      .emits({ Upped: z.object({}) })
      .patch({ Upped: (_, s) => ({ ups: s.ups + 1 }) })
      .on({ up: z.object({}) })
      .emit(() => ["Upped", {}])
      .build();
    const PartB = state({
      Pair: z.object({ ups: z.number(), downs: z.number() }),
    })
      .init(() => ({ ups: 0, downs: 0 }))
      .emits({ Downed: z.object({}) })
      .patch({ Downed: (_, s) => ({ downs: s.downs + 1 }) })
      .on({ down: z.object({}) })
      .emit(() => ["Downed", {}])
      .build();
    const table = new Map<string, { ups: number; downs: number }>();
    const pairs = projection("pairs")
      .of(PartA, PartB)
      .flush(async (rows) => {
        for (const row of rows) table.set(row.stream, row.state);
      })
      .build();
    const ctx = await sandbox(
      act().withState(PartA).withState(PartB).withProjection(pairs)
    );
    try {
      const app = ctx.app;
      await app.do("up", { stream: "p1", actor }, {});
      await app.do("down", { stream: "p1", actor }, {});
      await app.do("up", { stream: "p1", actor }, {});
      await settle_all(app);
      // both partials' reducers folded — the registry-merged full state
      expect(table.get("p1")).toEqual({ ups: 2, downs: 1 });
    } finally {
      await ctx.dispose();
    }
  });

  it("registers a fold projection provided by a slice and dedupes shared events", async () => {
    const Shared = z.object({ tag: z.string() });
    const PartA = state({ Duo2: z.object({ a: z.number(), tag: z.string() }) })
      .init(() => ({ a: 0, tag: "" }))
      .emits({ Marked: Shared, AHappened: z.object({}) })
      .patch({
        Marked: (e) => ({ tag: e.data.tag }),
        AHappened: (_, s) => ({ a: s.a + 1 }),
      })
      .on({ mark: Shared })
      .emit((data) => ["Marked", data])
      .on({ doA: z.object({}) })
      .emit(() => ["AHappened", {}])
      .build();
    // Same event name in a second partial — must reference the SAME
    // schema instance per the cross-slice rule; the fold register
    // dedupes it.
    const PartB = state({ Duo2: z.object({ b: z.number(), tag: z.string() }) })
      .init(() => ({ b: 0, tag: "" }))
      .emits({ Marked: Shared, BHappened: z.object({}) })
      // Marked stays passthrough here — only one partial may customize
      // a shared event's patch; the merge keeps the custom one.
      .patch({
        BHappened: (_, s) => ({ b: s.b + 1 }),
      })
      .on({ doB: z.object({}) })
      .emit(() => ["BHappened", {}])
      .build();
    const table = new Map<string, { a: number; b: number; tag: string }>();
    const duos = projection("duos2")
      .of(PartA, PartB)
      .flush(async (rows) => {
        for (const row of rows) table.set(row.stream, row.state);
      })
      .build();
    // the projection rides a slice — the pending-projections path; the
    // cast crosses the slice builder's event-scoped generic on purpose
    const DuoSlice = slice()
      .withState(PartB)
      .withProjection(duos as never)
      .build();
    const ctx = await sandbox(act().withState(PartA).withSlice(DuoSlice));
    try {
      const app = ctx.app;
      await app.do("doA", { stream: "d1", actor }, {});
      await app.do("doB", { stream: "d1", actor }, {});
      await app.do("mark", { stream: "d1", actor }, { tag: "x" });
      await settle_all(app);
      expect(table.get("d1")).toEqual({ a: 1, b: 1, tag: "x" });
    } finally {
      await ctx.dispose();
    }
  });

  it("refuses a fold that misses a partial's events at build", async () => {
    const PartA = state({ Duo: z.object({ a: z.number() }) })
      .init(() => ({ a: 0 }))
      .emits({ AHappened: z.object({}) })
      .patch({ AHappened: (_, s) => ({ a: s.a + 1 }) })
      .on({ doA: z.object({}) })
      .emit(() => ["AHappened", {}])
      .build();
    const PartB = state({ Duo: z.object({ b: z.number() }) })
      .init(() => ({ b: 0 }))
      .emits({ BHappened: z.object({}) })
      .patch({ BHappened: (_, s) => ({ b: s.b + 1 }) })
      .on({ doB: z.object({}) })
      .emit(() => ["BHappened", {}])
      .build();
    const partial_fold = projection("duos")
      .of(PartA) // PartB's events are missing — silently-partial folds lie
      .flush(async () => {})
      .build();
    await expect(
      sandbox(
        act().withState(PartA).withState(PartB).withProjection(partial_fold)
      )
    ).rejects.toThrow(/missing events BHappened/);
  });

  it("refuses a fold of an unregistered state at build", async () => {
    const orphans = projection("orphans")
      .of(Counter)
      .flush(async () => {})
      .build();
    // no state registered at all — the cast bypasses the event-scoped
    // generic to reach the runtime guard
    await expect(
      sandbox(act().withProjection(orphans as never))
    ).rejects.toThrow(/not registered/);
  });

  it("rejects mixed state names across .of() partials", () => {
    expect(() => projection("mixed-names").of(Counter, Tag as never)).toThrow(
      /must share one state name/
    );
  });

  it("rejects .of() without a state", () => {
    expect(() =>
      (projection("empty") as unknown as { of: (o: object) => unknown }).of({
        flushEvery: 5,
      })
    ).toThrow(/requires a state/);
  });

  it("rejects mixing .of() with .on() handlers", () => {
    const started = projection("mixed")
      .on({ Incremented: z.object({ by: z.number() }) })
      .do(async function handleIncremented() {});
    // The fluent types no longer offer .of here — reach past them to
    // exercise the runtime backstop for untyped callers.
    const untyped = started as unknown as {
      of: (state: typeof Counter) => unknown;
    };
    expect(() => untyped.of(Counter)).toThrow(/mixes \.of\(\) with \.on\(\)/);
  });

  it("rejects out-of-range fold options at startup", () => {
    expect(() => projection("bad").of(Counter, { flushEvery: 0 })).toThrow(
      ZodError
    );
    expect(() => projection("bad").of(Counter, { maxCachedStates: 0 })).toThrow(
      ZodError
    );
  });
});
