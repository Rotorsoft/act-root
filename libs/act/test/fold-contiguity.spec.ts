/**
 * The fold frontier is contiguous, and a rebuild does not trust the cache.
 *
 * #1465 — the per-stream fold cache is per-Act while the subscription
 * watermark is shared, so a worker can be handed an event whose predecessors
 * a sibling worker drained. Folding that onto the cached state corrupts the
 * row permanently, and the flushed row carries the newest `event_id` so the
 * documented monotonic-upsert guard overwrites the correct row with it.
 *
 * #1466 — a rebuild replays from the beginning, so every event lands at or
 * below a warm fold's head and takes the already-folded branch, which
 * re-flushes whatever the cache holds.
 */
import {
  act,
  dispose,
  InMemoryStore,
  projection,
  state,
  store,
} from "@rotorsoft/act";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.by }) })
  .on({ bump: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

const actor = { id: "a", name: "a" };

/** The read table every worker upserts into, as a database would be. */
const table = new Map<string, { count: number }>();

/** One "worker": its own Act, and so its own fold cache. */
const worker = () => {
  const counters = projection("counters")
    .of(Counter)
    .flush(async (rows) => {
      for (const r of rows)
        table.set(r.stream, r.state as unknown as { count: number });
    })
    .build();
  return act().withState(Counter).withProjection(counters).build();
};

const bump = (app: ReturnType<typeof worker>, by: number, stream = "c1") =>
  app.do("bump", { stream, actor }, { by });

const drain = async (app: ReturnType<typeof worker>) => {
  await app.correlate();
  await app.drain();
};

afterEach(async () => {
  table.clear();
  await dispose()("EXIT").catch(() => {});
});

describe("fold frontier contiguity (#1465)", () => {
  it("does not fold onto stale state when a sibling worker drained the gap", async () => {
    store(new InMemoryStore());
    await store().seed();
    const w1 = worker();
    const w2 = worker();

    await bump(w1, 1);
    await bump(w1, 2);
    await drain(w1); // w1's cache: count 3
    expect(table.get("c1")?.count).toBe(3);

    await bump(w1, 4);
    await bump(w1, 8);
    await drain(w2); // w2 takes this window; w1 never sees it
    expect(table.get("c1")?.count).toBe(15);

    // Back to w1, whose cache still says 3. Before the fix this folded
    // 16 onto 3 and wrote 19.
    await bump(w1, 16);
    await drain(w1);

    const truth = (await w1.load(Counter, "c1")).state.count;
    expect(truth).toBe(31);
    expect(table.get("c1")?.count).toBe(31);
  });

  it("still folds incrementally for a single worker — no reload per event", async () => {
    store(new InMemoryStore());
    await store().seed();
    const only = worker();
    for (const by of [1, 2, 4, 8, 16]) {
      await bump(only, by);
      await drain(only);
    }
    expect(table.get("c1")?.count).toBe(31);
    expect((await only.load(Counter, "c1")).state.count).toBe(31);
  });

  it("keeps each stream's frontier independent", async () => {
    store(new InMemoryStore());
    await store().seed();
    const w1 = worker();
    const w2 = worker();

    await bump(w1, 1, "c1");
    await bump(w1, 5, "c2");
    await drain(w1);

    // A gap on c1 only; c2 keeps folding from its own cached frontier.
    await bump(w1, 2, "c1");
    await drain(w2);
    await bump(w1, 4, "c1");
    await bump(w1, 7, "c2");
    await drain(w1);

    expect(table.get("c1")?.count).toBe(7);
    expect(table.get("c2")?.count).toBe(12);
  });
});

describe("rebuild does not trust the fold cache (#1466)", () => {
  it("re-derives the row from the store instead of re-flushing the cache", async () => {
    // Asserting the row value alone would pass whether or not the cache was
    // cleared, because a warm cache usually holds the right answer. What
    // makes a rebuild a rebuild is that it goes back to the store, so this
    // watches for the head load.
    const raw = new InMemoryStore();
    let head_loads = 0;
    let counting = false;
    const counted = new Proxy(raw, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          const q = args[1] as { stream?: string } | undefined;
          if (counting && p === "query" && q?.stream === "c1") head_loads++;
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
    store(counted as never);
    await store().seed();
    const w1 = worker();

    await bump(w1, 1);
    await bump(w1, 2);
    await drain(w1);
    expect(table.get("c1")?.count).toBe(3);

    counting = true;
    await w1.reset(["counters"]);
    await w1.drain();

    expect(head_loads).toBeGreaterThan(0);
    expect(table.get("c1")?.count).toBe(3);
  });

  it("reset clears the cache for every fold projection, not just one", async () => {
    store(new InMemoryStore());
    await store().seed();
    const rows_a = new Map<string, { count: number }>();
    const rows_b = new Map<string, { count: number }>();
    const a = projection("counters-a")
      .of(Counter)
      .flush(async (rows) => {
        for (const r of rows) rows_a.set(r.stream, r.state as never);
      })
      .build();
    const b = projection("counters-b")
      .of(Counter)
      .flush(async (rows) => {
        for (const r of rows) rows_b.set(r.stream, r.state as never);
      })
      .build();
    const app = act()
      .withState(Counter)
      .withProjection(a)
      .withProjection(b)
      .build();

    await bump(app as never, 3);
    await drain(app as never);
    expect(rows_a.get("c1")?.count).toBe(3);
    expect(rows_b.get("c1")?.count).toBe(3);

    rows_a.set("c1", { count: 111 });
    rows_b.set("c1", { count: 222 });
    await app.reset(["counters-a", "counters-b"]);
    await app.drain();

    expect(rows_a.get("c1")?.count).toBe(3);
    expect(rows_b.get("c1")?.count).toBe(3);
  });
});
