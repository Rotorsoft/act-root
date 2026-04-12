import { z } from "zod";
import { act, dispose, state, store } from "../src/index.js";

describe("idempotency", () => {
  beforeEach(async () => {
    await store().drop();
  });

  afterAll(async () => {
    await dispose()();
  });

  const actor = { id: "a", name: "a" };
  let streamId = 0;
  const nextStream = () => `idemp-test-${++streamId}`;

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

  it("should execute action normally with correlation", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    const result = await app.do(
      "increment",
      { stream, actor, correlation: "req-1" },
      { by: 5 }
    );

    expect(result).toHaveLength(1);
    expect(result[0].state.count).toBe(5);
    expect(result[0].event!.meta.correlation).toBe("req-1");
  });

  it("should return original events on duplicate correlation", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    const first = await app.do(
      "increment",
      { stream, actor, correlation: "req-dup" },
      { by: 10 }
    );

    // Retry with same correlation — should return original, not re-execute
    const retry = await app.do(
      "increment",
      { stream, actor, correlation: "req-dup" },
      { by: 10 }
    );

    expect(retry).toHaveLength(1);
    expect(retry[0].event!.id).toBe(first[0].event!.id);
    expect(retry[0].state.count).toBe(10); // not 20

    // Verify only one event was committed
    const events = await app.query_array({ stream, stream_exact: true });
    expect(events).toHaveLength(1);
  });

  it("should allow same correlation on different streams", async () => {
    const stream1 = nextStream();
    const stream2 = nextStream();
    const app = act().withState(Counter).build();

    await app.do(
      "increment",
      { stream: stream1, actor, correlation: "shared-corr" },
      { by: 1 }
    );

    await app.do(
      "increment",
      { stream: stream2, actor, correlation: "shared-corr" },
      { by: 2 }
    );

    const snap1 = await app.load(Counter, stream1);
    const snap2 = await app.load(Counter, stream2);
    expect(snap1.state.count).toBe(1);
    expect(snap2.state.count).toBe(2);
  });

  it("should not deduplicate when no correlation is provided", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 5 });
    await app.do("increment", { stream, actor }, { by: 5 });

    const snap = await app.load(Counter, stream);
    expect(snap.state.count).toBe(10); // both executed
  });

  it("should deduplicate multiple events from same action", async () => {
    const Doubled = z.object({ a: z.number(), b: z.number() });
    const Multi = state({ Multi: z.object({ total: z.number() }) })
      .init(() => ({ total: 0 }))
      .emits({ Doubled })
      .patch({
        Doubled: ({ data }, s) => ({ total: s.total + data.a + data.b }),
      })
      .on({ doubleInc: z.object({ a: z.number(), b: z.number() }) })
      .emit((action) => [
        ["Doubled", { a: action.a, b: action.b }],
        ["Doubled", { a: action.a, b: action.b }],
      ])
      .build();

    const stream = nextStream();
    const app = act().withState(Multi).build();

    const first = await app.do(
      "doubleInc",
      { stream, actor, correlation: "multi-1" },
      { a: 3, b: 4 }
    );
    expect(first).toHaveLength(2);

    // Retry
    const retry = await app.do(
      "doubleInc",
      { stream, actor, correlation: "multi-1" },
      { a: 3, b: 4 }
    );
    expect(retry).toHaveLength(2);
    expect(retry[0].event!.id).toBe(first[0].event!.id);
    expect(retry[1].event!.id).toBe(first[1].event!.id);

    // Only 2 events total, not 4
    const events = await app.query_array({ stream, stream_exact: true });
    expect(events).toHaveLength(2);
  });

  it("should store provided correlation in event metadata", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do(
      "increment",
      { stream, actor, correlation: "my-custom-id" },
      { by: 1 }
    );

    const events = await app.query_array({ stream, stream_exact: true });
    expect(events[0].meta.correlation).toBe("my-custom-id");
  });

  it("should generate random correlation when not provided", async () => {
    const stream = nextStream();
    const app = act().withState(Counter).build();

    await app.do("increment", { stream, actor }, { by: 1 });
    await app.do("increment", { stream, actor }, { by: 2 });

    const events = await app.query_array({ stream, stream_exact: true });
    expect(events[0].meta.correlation).toBeDefined();
    expect(events[1].meta.correlation).toBeDefined();
    expect(events[0].meta.correlation).not.toBe(events[1].meta.correlation);
  });
});
