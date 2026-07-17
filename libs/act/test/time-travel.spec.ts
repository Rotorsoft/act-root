import { z } from "zod";
import { act, state } from "../src/index.js";
import { fixture, sandbox } from "../src/test/index.js";

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

const test = fixture(act().withState(Counter));

describe("time-travel load", () => {
  test("should load state as-of a specific event ID", async ({ app }) => {
    const stream = nextStream();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.do("increment", { stream, actor }, { by: 3 });

    const events = await app.query_array({ stream, stream_exact: true });
    expect(events).toHaveLength(3);

    const snap = await app.load(Counter, stream, undefined, {
      before: events[2].id,
    });
    expect(snap.state.count).toBe(3);
    expect(snap.patches).toBe(2);
  });

  test("should load state as-of a specific timestamp", async ({ app }) => {
    const stream = nextStream();

    await app.do("increment", { stream, actor }, { by: 10 });
    const midpoint = new Date();
    await app.do("increment", { stream, actor }, { by: 20 });

    const snap = await app.load(Counter, stream, undefined, {
      created_before: midpoint,
    });
    expect(snap.state.count).toBeLessThanOrEqual(10);
  });

  test("should not read from cache for time-travel loads", async ({ app }) => {
    const stream = nextStream();

    await app.do("increment", { stream, actor }, { by: 5 });
    await app.do("increment", { stream, actor }, { by: 10 });

    const current = await app.load(Counter, stream);
    expect(current.state.count).toBe(15);

    const events = await app.query_array({ stream, stream_exact: true });

    const past = await app.load(Counter, stream, undefined, {
      before: events[1].id,
    });
    expect(past.state.count).toBe(5);
  });

  test("should not write to cache for time-travel loads", async ({ app }) => {
    const stream = nextStream();

    await app.do("increment", { stream, actor }, { by: 5 });
    await app.do("increment", { stream, actor }, { by: 10 });

    await app.load(Counter, stream);
    const events = await app.query_array({ stream, stream_exact: true });
    await app.load(Counter, stream, undefined, { before: events[1].id });

    const current = await app.load(Counter, stream);
    expect(current.state.count).toBe(15);
  });

  it("should not use snapshots for time-travel loads", async () => {
    // One-off builder with snap rules — uses sandbox directly since
    // the shared `test` fixture is bound to the plain Counter builder.
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

    const { app, dispose } = await sandbox(act().withState(SnapCounter));
    const stream = nextStream();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.do("increment", { stream, actor }, { by: 3 });

    const events = await app.query_array({ stream, stream_exact: true });
    const past = await app.load(SnapCounter, stream, undefined, {
      before: events[2].id,
    });
    expect(past.state.count).toBe(3);

    await dispose();
  });

  test("should return current state when as-of is in the future", async ({
    app,
  }) => {
    const stream = nextStream();
    await app.do("increment", { stream, actor }, { by: 7 });
    const future = await app.load(Counter, stream, undefined, {
      before: 999999,
    });
    expect(future.state.count).toBe(7);
  });

  test("should return initial state when as-of is before any events", async ({
    app,
  }) => {
    const stream = nextStream();
    await app.do("increment", { stream, actor }, { by: 7 });
    const past = await app.load(Counter, stream, undefined, {
      created_before: new Date(0),
    });
    expect(past.state.count).toBe(0);
    expect(past.event).toBeUndefined();
  });

  test("should work with string state name", async ({ app }) => {
    const stream = nextStream();
    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    const events = await app.query_array({ stream, stream_exact: true });
    const past = await app.load("Counter", stream, undefined, {
      before: events[1].id,
    });
    expect(past.state.count).toBe(1);
  });

  test("should load state with created_after filter", async ({ app }) => {
    const stream = nextStream();
    await app.do("increment", { stream, actor }, { by: 1 });
    const midpoint = new Date();
    await app.do("increment", { stream, actor }, { by: 2 });
    const snap = await app.load(Counter, stream, undefined, {
      created_after: midpoint,
    });
    expect(snap.state.count).toBeLessThanOrEqual(2);
  });

  test("should load state with limit filter", async ({ app }) => {
    const stream = nextStream();
    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });
    await app.do("increment", { stream, actor }, { by: 3 });
    const snap = await app.load(Counter, stream, undefined, { limit: 2 });
    expect(snap.state.count).toBe(3);
    expect(snap.patches).toBe(2);
  });

  test("should leave current load unchanged (no asOf)", async ({ app }) => {
    const stream = nextStream();
    await app.do("increment", { stream, actor }, { by: 3 });
    await app.do("increment", { stream, actor }, { by: 4 });
    const snap = await app.load(Counter, stream);
    expect(snap.state.count).toBe(7);
  });

  // RFC 1274: the snapshot resume floor is a current-state optimization. On a
  // stream that snapshots on every event, a snapshot always sits ABOVE any
  // early cutoff — so for every `asOf` bound the orchestrator must suppress the
  // floor (drop `with_snaps`) and full-scan under the bound, never jump to a
  // snapshot outside the window. This one toggle covers all four historical
  // instances (#1261 created_*, #1267 before, #1270 backward, #1274 limit).
  describe("time-travel ignores snapshots outside the cutoff (RFC 1274)", () => {
    // Snapshot after every event → a `__snapshot__` above every early cutoff.
    const SnapEvery = state({ SnapEvery: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Incremented })
      .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.by }) })
      .on({ increment: z.object({ by: z.number() }) })
      .emit((action) => ["Incremented", { by: action.by }])
      .snap(() => true)
      .build();

    const makeApp = () => sandbox(act().withState(SnapEvery));
    type SnapApp = Awaited<ReturnType<typeof makeApp>>["app"];

    const seed = async (app: SnapApp, stream: string, bys: number[]) => {
      for (const by of bys) {
        await app.do("increment", { stream, actor }, { by });
        // Distinct `created` per event so timestamp cutoffs are unambiguous.
        await new Promise((r) => setTimeout(r, 2));
      }
      return app.query_array({ stream, stream_exact: true });
    };

    it("`before` id cutoff — folds only pre-cutoff events (#1267)", async () => {
      const { app, dispose } = await makeApp();
      const stream = nextStream();
      const events = await seed(app, stream, [1, 2, 3]);
      const past = await app.load(SnapEvery, stream, undefined, {
        before: events[1].id,
      });
      expect(past.state.count).toBe(1);
      await dispose();
    });

    it("`limit` — folds the first N events, not N from the snapshot (#1274)", async () => {
      const { app, dispose } = await makeApp();
      const stream = nextStream();
      await seed(app, stream, [1, 2, 3, 4]);
      const past = await app.load(SnapEvery, stream, undefined, { limit: 2 });
      expect(past.state.count).toBe(3);
      await dispose();
    });

    it("`created_before` timestamp cutoff — folds only pre-cutoff events (#1261)", async () => {
      const { app, dispose } = await makeApp();
      const stream = nextStream();
      const events = await seed(app, stream, [1, 2, 3]);
      const cutoff = new Date(
        (events[0].created.getTime() + events[1].created.getTime()) / 2
      );
      const past = await app.load(SnapEvery, stream, undefined, {
        created_before: cutoff,
      });
      expect(past.state.count).toBe(1);
      await dispose();
    });

    it("`created_after` timestamp cutoff — folds only post-cutoff events (#1261)", async () => {
      const { app, dispose } = await makeApp();
      const stream = nextStream();
      const events = await seed(app, stream, [1, 2, 3]);
      const cutoff = new Date(
        (events[0].created.getTime() + events[1].created.getTime()) / 2
      );
      const past = await app.load(SnapEvery, stream, undefined, {
        created_after: cutoff,
      });
      // Events 2 and 3 (created after the cutoff) fold from init: 2 + 3.
      expect(past.state.count).toBe(5);
      await dispose();
    });
  });
});
