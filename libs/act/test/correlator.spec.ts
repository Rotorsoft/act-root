import { z } from "zod";
import {
  act,
  type Correlator,
  dispose,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";
import { default_correlator } from "../src/internal/correlator.js";

describe("default_correlator (pure)", () => {
  const baseCtx = {
    action: "increment",
    state: "Counter",
    stream: "counter-1",
    actor: { id: "u1", name: "u" },
  };

  it("produces 18-char ids with full-length names", () => {
    const id = default_correlator(baseCtx);
    // 4 state + 1 dash + 4 action + 1 dash + 8 suffix
    expect(id).toHaveLength(18);
    expect(id).toMatch(/^coun-incr-[0-9a-z]{8}$/);
  });

  it("uses short prefixes when names are below 4 chars", () => {
    const id = default_correlator({ ...baseCtx, state: "Tx", action: "go" });
    expect(id).toMatch(/^tx-go-[0-9a-z]{8}$/);
  });

  it("is always lowercase", () => {
    const id = default_correlator({
      ...baseCtx,
      state: "CamelCase",
      action: "MIXEDcase",
    });
    expect(id).toBe(id.toLowerCase());
  });

  it("generates distinct ids back-to-back at the same ms", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(default_correlator(baseCtx));
    // 1000 generations against 1.68M random tail → collision rate
    // ~1000²/(2·1.68M) ≈ 0.03%. Allow up to one collision.
    expect(ids.size).toBeGreaterThanOrEqual(999);
  });

  it("encodes timestamp in the first 4 chars of the suffix", () => {
    const a = default_correlator(baseCtx);
    // Wait at least 1ms so the timestamp segment differs.
    const waitMs = 5;
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      // Spin briefly — sleep would yield to vitest fake-timers if any.
    }
    const b = default_correlator(baseCtx);
    expect(a.slice(-8, -4)).not.toBe(b.slice(-8, -4));
  });
});

describe("Act integration", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ incremented: ZodEmpty })
    .patch({ incremented: (_, s) => ({ count: s.count + 1 }) })
    .on({ increment: ZodEmpty })
    .emit(() => ["incremented", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  it("uses default correlator when none provided", async () => {
    const app = act().withState(counter).build();
    await app.do("increment", { stream: "s1", actor }, {});
    const events = await app.query_array({ stream: "s1" });
    expect(events[0]?.meta.correlation).toMatch(/^coun-incr-[0-9a-z]{8}$/);
  });

  it("honors a custom correlator from ActOptions", async () => {
    const correlator: Correlator = ({ state, action, stream }) =>
      `custom:${state}:${action}:${stream}`;
    const app = act().withState(counter).build({ correlator });
    await app.do("increment", { stream: "s2", actor }, {});
    const events = await app.query_array({ stream: "s2" });
    expect(events[0]?.meta.correlation).toBe("custom:Counter:increment:s2");
  });

  it("preserves correlation across the reaction chain", async () => {
    let seen: string | undefined;
    const captured = vi.fn().mockImplementation(async (event) => {
      seen = event.meta.correlation;
    });
    Object.defineProperty(captured, "name", { value: "captured" });

    const app = act()
      .withState(counter)
      .on("incremented")
      .do(captured)
      .build({
        correlator: () => "WORKFLOW-42",
      });

    await app.do("increment", { stream: "s3", actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen).toBe("WORKFLOW-42");
  });

  it("correlator receives state, action, stream, actor", async () => {
    const seen: Array<Parameters<Correlator>[0]> = [];
    const correlator: Correlator = (ctx) => {
      seen.push(ctx);
      return "x";
    };

    const app = act().withState(counter).build({ correlator });
    await app.do(
      "increment",
      { stream: "s4", actor: { id: "alice", name: "Alice" } },
      {}
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      action: "increment",
      state: "Counter",
      stream: "s4",
      actor: { id: "alice", name: "Alice" },
    });
  });
});

describe("close-cycle integration", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ incremented: ZodEmpty })
    .patch({ incremented: (_, s) => ({ count: s.count + 1 }) })
    .on({ increment: ZodEmpty })
    .emit(() => ["incremented", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  it("close tombstone uses configured correlator with $close context", async () => {
    const seen: Array<Parameters<Correlator>[0]> = [];
    const correlator: Correlator = (ctx) => {
      seen.push(ctx);
      return `id-${seen.length}`;
    };

    const app = act().withState(counter).build({ correlator });
    await app.do("increment", { stream: "to-close", actor }, {});
    await app.close([{ stream: "to-close" }]);

    // First call: the increment action. Second call: close cycle.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const closeCall = seen[seen.length - 1];
    expect(closeCall.state).toBe("$close");
    expect(closeCall.action).toBe("close");

    // Verify the tombstone event carries the close correlator's id.
    let tombstoneCorrelation: string | undefined;
    await store().query(
      (evt) => {
        if (evt.name === "__tombstone__")
          tombstoneCorrelation = evt.meta.correlation;
      },
      { stream: "to-close" }
    );
    expect(tombstoneCorrelation).toBe(`id-${seen.length}`);
  });
});
