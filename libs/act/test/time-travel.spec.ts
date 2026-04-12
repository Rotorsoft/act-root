import { z } from "zod";
import { act, dispose, state, store } from "../src/index.js";

describe("time-travel load", () => {
  beforeEach(async () => {
    await store().drop();
  });

  afterAll(async () => {
    await dispose()();
  });

  const actor = { id: "a", name: "a" };
  let streamId = 0;
  const nextStream = () => `tt-test-${++streamId}`;

  const Incremented = z.object({ by: z.number() });
  const Counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ Incremented })
    .patch({
      Incremented: ({ data }, s) => ({ count: s.count + data.by }),
    })
    .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { by: action.by }])
    .build();

  it("should load state as-of a specific event ID", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.do("increment", { stream, actor }, { by: 3 });

    // Get event IDs
    const events = await app.query_array({ stream, stream_exact: true });
    expect(events).toHaveLength(3);

    // Load as-of before the 3rd event
    const snap = await app.load(Counter, stream, undefined, {
      before: events[2].id,
    });
    expect(snap.state.count).toBe(3); // 1 + 2, not 1 + 2 + 3
    expect(snap.patches).toBe(2);
  });

  it("should load state as-of a specific timestamp", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 10 });
    const midpoint = new Date();
    await app.do("increment", { stream, actor }, { by: 20 });

    // Load as-of the midpoint (after first, before second)
    // Note: in-memory store creates events with very close timestamps,
    // so we use a small offset
    const snap = await app.load(Counter, stream, undefined, {
      created_before: midpoint,
    });
    // Should only have the first event
    expect(snap.state.count).toBeLessThanOrEqual(10);
  });

  it("should not read from cache for time-travel loads", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 5 });
    await app.do("increment", { stream, actor }, { by: 10 });

    // Warm the cache by loading current state
    const current = await app.load(Counter, stream);
    expect(current.state.count).toBe(15);

    const events = await app.query_array({ stream, stream_exact: true });

    // Time-travel load should replay from scratch, not use cache
    const past = await app.load(Counter, stream, undefined, {
      before: events[1].id,
    });
    expect(past.state.count).toBe(5); // only first event
  });

  it("should not write to cache for time-travel loads", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 5 });
    await app.do("increment", { stream, actor }, { by: 10 });

    // Warm cache
    await app.load(Counter, stream);

    const events = await app.query_array({ stream, stream_exact: true });

    // Time-travel load
    await app.load(Counter, stream, undefined, { before: events[1].id });

    // Current load should still return full state (cache not corrupted)
    const current = await app.load(Counter, stream);
    expect(current.state.count).toBe(15);
  });

  it("should not use snapshots for time-travel loads", async () => {
    const stream = nextStream();

    const SnapCounter = state({ SnapCounter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Incremented })
      .patch({
        Incremented: ({ data }, s) => ({ count: s.count + data.by }),
      })
      .on({ increment: z.object({ by: z.number() }) })
      .emit((action) => ["Incremented", { by: action.by }])
      .snap((s) => s.patches >= 2)
      .build();

    const app = act().withState(SnapCounter).build();

    // Generate enough events to trigger a snapshot
    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.do("increment", { stream, actor }, { by: 3 });

    const events = await app.query_array({ stream, stream_exact: true });

    // Time-travel to before the 3rd event should still work
    // (replays from 0, ignoring any snapshots)
    const past = await app.load(SnapCounter, stream, undefined, {
      before: events[2].id,
    });
    expect(past.state.count).toBe(3); // 1 + 2
  });

  it("should return current state when as-of is in the future", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 7 });

    const future = await app.load(Counter, stream, undefined, {
      before: 999999,
    });
    expect(future.state.count).toBe(7);
  });

  it("should return initial state when as-of is before any events", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 7 });

    // created_before a date in the past returns initial state
    const past = await app.load(Counter, stream, undefined, {
      created_before: new Date(0),
    });
    expect(past.state.count).toBe(0);
    expect(past.event).toBeUndefined();
  });

  it("should work with string state name", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });

    const events = await app.query_array({ stream, stream_exact: true });

    const past = await app.load("Counter", stream, undefined, {
      before: events[1].id,
    });
    expect(past.state.count).toBe(1);
  });

  it("should load state with created_after filter", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    const midpoint = new Date();
    await app.do("increment", { stream, actor }, { by: 2 });

    // Load only events after midpoint
    const snap = await app.load(Counter, stream, undefined, {
      created_after: midpoint,
    });
    // Only the second event (by: 2) should be included
    expect(snap.state.count).toBeLessThanOrEqual(2);
  });

  it("should load state with limit filter", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.do("increment", { stream, actor }, { by: 3 });

    const snap = await app.load(Counter, stream, undefined, { limit: 2 });
    expect(snap.state.count).toBe(3); // 1 + 2
    expect(snap.patches).toBe(2);
  });

  it("should leave current load unchanged (no asOf)", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 3 });
    await app.do("increment", { stream, actor }, { by: 4 });

    const snap = await app.load(Counter, stream);
    expect(snap.state.count).toBe(7);
  });
});
