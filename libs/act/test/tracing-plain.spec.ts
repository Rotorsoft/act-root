import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { ZodEmpty } from "../src/types/schemas.js";

// Force the tracing module to evaluate PRETTY=false by mocking config()
// to report production env. This file is isolated from the main tracing
// spec which exercises pretty mode.
//
// logLevel="fatal" silences port registration info logs at module load.
// The Proxy below forwards `level === "trace"` to the tracing decorator
// (which gates on it) while the underlying logger stays at fatal — the
// trace spy captures calls regardless of the real level.
vi.mock("../src/config.js", () => ({
  config: vi.fn().mockReturnValue({
    env: "production",
    logLevel: "fatal",
    logSingleLine: true,
    sleepMs: 0,
  }),
}));

describe("tracing — plain (production) mode", () => {
  it("uses 'caption: body' for event-sourcing logs and bare prefix for drain", async () => {
    // Imports must happen AFTER the doMock above.
    const { state } = await import("../src/builders/state-builder.js");
    const { build_es, build_drain } = await import(
      "../src/internal/tracing.js"
    );
    const es = await import("../src/internal/event-sourcing.js");
    const { log, store } = await import("../src/ports.js");

    store(new InMemoryStore());

    const Counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Incremented: z.object({ by: z.number() }) })
      .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.by }) })
      .on({ increment: z.object({ by: z.number() }) })
      .emit("Incremented")
      .on({ noop: ZodEmpty })
      .emit(() => [])
      .build();

    const traceSpy = vi.spyOn(log(), "trace").mockImplementation(() => {});

    // Use a Proxy to report level=trace without mutating the real logger.
    const traceLogger = new Proxy(log(), {
      get: (target, prop) =>
        prop === "level"
          ? "trace"
          : (target as unknown as Record<PropertyKey, unknown>)[prop],
    });

    // Event-sourcing trace: `caption: body` (plain mode). Load fires once
    // on exit with cache marker + version/replayed/snaps/patches inline.
    const { action, load } = build_es(traceLogger);
    await load(Counter, "s-plain");
    expect(traceSpy).toHaveBeenCalledWith(
      "load: s-plain miss v=-1 replayed=0 snaps=0 patches=0"
    );

    await action(
      Counter,
      "increment",
      {
        stream: "s-plain",
        actor: { id: "u", name: "u" },
      },
      { by: 5 }
    );
    expect(traceSpy).toHaveBeenCalledWith(
      { by: 5 },
      "action: s-plain.increment"
    );
    expect(traceSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.stringContaining("committed: s-plain.Incremented")
    );

    // Drain trace: `>> caption` (no ANSI)
    const { subscribe } = build_drain(traceLogger);
    await subscribe([{ stream: "fresh-plain" }]);
    expect(traceSpy).toHaveBeenCalledWith(">> correlated fresh-plain");

    // Plain-mode cycle trace: lane appended without ANSI when the batch
    // is in a non-default lane (ACT-1103). Driven via `trace_cycle`
    // directly so the test stays self-contained (DrainController is the
    // runtime caller, but it's overkill to wire up here).
    const { trace_cycle } = await import("../src/internal/tracing.js");
    trace_cycle(
      traceLogger,
      [
        {
          stream: "lane-plain",
          at: 0,
          retry: 0,
          lane: "slow",
        },
      ],
      [
        {
          stream: "lane-plain",
          events: [{ id: 1, name: "Incremented" }],
        },
      ],
      [{ lease: { stream: "lane-plain" } }],
      [{ stream: "lane-plain", at: 1 }],
      []
    );
    expect(traceSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^>> drained slow lane-plain/)
    );

    // Snap trace
    const [snapshot] = await es.action(
      Counter,
      "increment",
      { stream: "s-snap-plain", actor: { id: "u", name: "u" } },
      { by: 1 }
    );
    const { snap, tombstone } = build_es(traceLogger);
    await snap(snapshot);
    expect(traceSpy).toHaveBeenCalledWith(
      `snap: ${snapshot.event!.stream}@${snapshot.event!.version}`
    );

    // Tombstone trace
    const committed = await tombstone("ts-plain", -1, "corr-plain");
    expect(committed).toBeDefined();
    expect(traceSpy).toHaveBeenCalledWith(
      `tombstoned: ts-plain@${committed!.version}`
    );
  });
});
