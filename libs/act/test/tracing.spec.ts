import { z } from "zod";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { state } from "../src/builders/state-builder.js";
import * as drain from "../src/internal/drain.js";
import * as es from "../src/internal/event-sourcing.js";
import { buildDrain, buildEs, traceCycle } from "../src/internal/tracing.js";
import { cache, log, store } from "../src/ports.js";
import type { Logger } from "../src/types/index.js";
import { ZodEmpty } from "../src/types/schemas.js";

// Returns a Logger that delegates to log() but reports the requested level.
// Using a Proxy keeps dynamic dispatch so spies installed on log() still fire.
const withLevel = (level: string): Logger =>
  new Proxy(log(), {
    get: (target, prop) =>
      prop === "level"
        ? level
        : (target as unknown as Record<PropertyKey, unknown>)[prop],
  });

// State that emits one event per increment, and a no-op action that emits nothing
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({
    Incremented: ({ data }, s) => ({ count: s.count + data.by }),
  })
  .on({ increment: z.object({ by: z.number() }) })
  .emit("Incremented")
  .on({ noop: ZodEmpty })
  .emit(() => [])
  .build();

const target = (stream: string) => ({
  stream,
  actor: { id: "u", name: "u" },
});

// Initialize singletons once for the whole file.
store(new InMemoryStore());
cache(new InMemoryCache());

describe("tracing", () => {
  beforeEach(async () => {
    await store().seed();
    await cache().clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("buildEs", () => {
    it("returns bare ops for non-trace levels (action still wrapped to bind correlator)", () => {
      const ops = buildEs(withLevel("info"));
      expect(ops.snap).toBe(es.snap);
      expect(ops.load).toBe(es.load);
      // ACT-404: action always carries a bound correlator, so it's a
      // closure regardless of trace level — the bare-vs-traced split now
      // only governs snap/load/tombstone.
      expect(ops.action).not.toBe(es.action);
    });

    it("returns wrapped ops for trace level", () => {
      const ops = buildEs(withLevel("trace"));
      expect(ops.snap).not.toBe(es.snap);
      expect(ops.load).not.toBe(es.load);
      expect(ops.action).not.toBe(es.action);
    });
  });

  describe("buildDrain", () => {
    it("returns bare ops for non-trace levels", () => {
      const ops = buildDrain(withLevel("info"));
      expect(ops.claim).toBe(drain.claim);
      expect(ops.fetch).toBe(drain.fetch);
      expect(ops.ack).toBe(drain.ack);
      expect(ops.block).toBe(drain.block);
      expect(ops.subscribe).toBe(drain.subscribe);
    });

    it("at trace level only subscribe is decorated; cycle ops stay bare (ACT-1103)", () => {
      // Per-op claim/fetch/ack/block decorators were folded into a
      // single cycle trace emitted from `DrainController.drain()` via
      // `traceCycle`. Subscribe stays decorated because it's driven
      // from correlate-cycle, outside the cycle shape.
      const ops = buildDrain(withLevel("trace"));
      expect(ops.claim).toBe(drain.claim);
      expect(ops.fetch).toBe(drain.fetch);
      expect(ops.ack).toBe(drain.ack);
      expect(ops.block).toBe(drain.block);
      expect(ops.subscribe).not.toBe(drain.subscribe);
    });
  });

  describe("event-sourcing trace decorators", () => {
    let traceSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      traceSpy = vi.spyOn(log(), "trace").mockImplementation(() => {});
    });

    it("logs load exit with cache + v + replayed + snaps + patches inline in the body", async () => {
      const { load } = buildEs(withLevel("trace"));
      await load(Counter, "s1");
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /s1\s.*miss.*v=-?\d+.*replayed=\d+.*snaps=\d+.*patches=\d+/
        )
      );
    });

    it("logs as-of details including the active filter fields", async () => {
      const { load } = buildEs(withLevel("trace"));
      await load(Counter, "s1", undefined, { before: 9999, limit: 50 });
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /s1 \(as-of before=9999 limit=50\).*miss.*v=-?\d+.*replayed=\d+/
        )
      );
    });

    it("logs as-of created_before/created_after when those filters are set", async () => {
      const { load } = buildEs(withLevel("trace"));
      const before = new Date("2026-05-01T00:00:00.000Z");
      const after = new Date("2026-04-01T00:00:00.000Z");
      await load(Counter, "s1", undefined, {
        created_before: before,
        created_after: after,
      });
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /created_before=2026-05-01T00:00:00\.000Z.*created_after=2026-04-01T00:00:00\.000Z/
        )
      );
    });

    it("renders bare '(as-of)' marker when an empty asOf object is passed", async () => {
      const { load } = buildEs(withLevel("trace"));
      // asOf={} doesn't actually time-travel (load checks
      // Object.values(asOf).some(...)), but the marker still fires because
      // the trace decorator only checks `asOf` truthiness.
      await load(Counter, "s1", undefined, {});
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/s1 \(as-of\)/)
      );
    });

    it("reports cache hit on the second load of the same stream", async () => {
      const { load } = buildEs(withLevel("trace"));
      // Prime the cache via an action so a checkpoint exists.
      await es.action(Counter, "increment", target("s-warm"), { by: 1 });
      traceSpy.mockClear();
      await load(Counter, "s-warm");
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/s-warm\s.*hit/)
      );
    });

    it("withActionTrace logs entry and commit when events emitted", async () => {
      const { action } = buildEs(withLevel("trace"));
      const snapshots = await action(Counter, "increment", target("s1"), {
        by: 5,
      });
      // entry log: action payload + colored target body
      expect(traceSpy).toHaveBeenCalledWith(
        { by: 5 },
        expect.stringContaining("s1.increment")
      );
      // exit log: committed event data + colored target.event body
      expect(traceSpy).toHaveBeenCalledWith(
        snapshots.map((s) => s.event?.data),
        expect.stringContaining("s1.Incremented")
      );
    });

    it("withActionTrace skips commit log when nothing emitted", async () => {
      const { action } = buildEs(withLevel("trace"));
      await action(Counter, "noop", target("s2"), {});
      expect(traceSpy).toHaveBeenCalledWith(
        {},
        expect.stringContaining("s2.noop")
      );
      // No "Incremented" / commit-style call should have fired
      const commitCalls = traceSpy.mock.calls.filter(
        (c: [unknown, unknown]) =>
          Array.isArray(c[0]) &&
          typeof c[1] === "string" &&
          c[1].includes("s2.")
      );
      expect(commitCalls).toHaveLength(0);
    });

    it("withSnapTrace logs stream and version", async () => {
      const [snapshot] = await es.action(Counter, "increment", target("s3"), {
        by: 1,
      });
      const { snap } = buildEs(withLevel("trace"));
      await snap(snapshot);
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `${snapshot.event!.stream}@${snapshot.event!.version}`
        )
      );
    });

    it("withTombstoneTrace logs stream and version on success", async () => {
      const { tombstone } = buildEs(withLevel("trace"));
      const committed = await tombstone("ts-trace", -1, "corr-trace");
      expect(committed).toBeDefined();
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringContaining(`ts-trace@${committed!.version}`)
      );
    });

    it("withTombstoneTrace skips log on ConcurrencyError (committed undef)", async () => {
      const { tombstone } = buildEs(withLevel("trace"));
      await tombstone("ts-trace-race", -1, "corr-trace-1");
      traceSpy.mockClear();
      // Second tombstone at same version → ConcurrencyError → returns undefined
      const second = await tombstone("ts-trace-race", -1, "corr-trace-2");
      expect(second).toBeUndefined();
      const tombstoneCalls = traceSpy.mock.calls.filter(
        (c: [unknown]) =>
          typeof c[0] === "string" && c[0].includes("ts-trace-race@")
      );
      expect(tombstoneCalls).toHaveLength(0);
    });
  });

  describe("drain trace decorators", () => {
    let traceSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      traceSpy = vi.spyOn(log(), "trace").mockImplementation(() => {});
    });

    const lease = (stream: string, at = 0, retry = 0, lane?: string) => ({
      stream,
      at,
      retry,
      lane,
      by: "test",
      lagging: false,
    });

    it("traceCycle is a no-op when logger is below trace level", () => {
      traceCycle(withLevel("info"), [lease("x")], [], [], [], []);
      expect(traceSpy).not.toHaveBeenCalled();
    });

    it("traceCycle is a no-op when no leases were taken this cycle", () => {
      traceCycle(withLevel("trace"), [], [], [], [], []);
      expect(traceSpy).not.toHaveBeenCalled();
    });

    it("traceCycle marks acked streams with ✓ + post-at and blocked with ✗ + at/retry + error", () => {
      traceCycle(
        withLevel("trace"),
        [lease("ok-stream"), lease("bad-stream", 1, 2)],
        [
          {
            stream: "ok-stream",
            events: [{ id: 1, name: "Incremented" }],
          },
          { stream: "bad-stream", events: [{ id: 2, name: "Incremented" }] },
        ],
        [
          { lease: { stream: "ok-stream" } },
          { lease: { stream: "bad-stream" }, error: "boom", block: true },
        ],
        [{ stream: "ok-stream", at: 7 }],
        [{ stream: "bad-stream", error: "boom" }]
      );
      // ✓ followed by post-ack @<at>; ✗ followed by @<at>/<retry> + error
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/ok-stream.*✓.*@7/)
      );
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/bad-stream.*✗.*@1\/2.*boom/)
      );
    });

    it("traceCycle marks ⊘ deferred and ⚠ with the handler error message", () => {
      traceCycle(
        withLevel("trace"),
        [lease("deferred-stream"), lease("erroring-stream", 5, 1)],
        // No fetch entry for deferred-stream → ⊘. erroring-stream
        // fetched + handled with error but not blocked → ⚠.
        [
          {
            stream: "erroring-stream",
            events: [{ id: 1, name: "Incremented" }],
          },
        ],
        [{ lease: { stream: "erroring-stream" }, error: "timeout" }],
        [],
        []
      );
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/deferred-stream.*⊘.*@0\/0/)
      );
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/erroring-stream.*⚠.*@5\/1.*timeout/)
      );
    });

    it("traceCycle prefixes the caption with lane when non-default", () => {
      traceCycle(
        withLevel("trace"),
        [lease("lane-stream", 0, 0, "slow")],
        [{ stream: "lane-stream", events: [{ id: 1, name: "Tick" }] }],
        [{ lease: { stream: "lane-stream" } }],
        [{ stream: "lane-stream", at: 1 }],
        []
      );
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/>> drained.*slow.*lane-stream/)
      );
    });

    it("traceCycle renders source-prefixed streams as `stream<-source`", () => {
      traceCycle(
        withLevel("trace"),
        [lease("sub")],
        [
          {
            stream: "sub",
            source: "src",
            events: [{ id: 7, name: "Tick" }],
          },
        ],
        [{ lease: { stream: "sub" } }],
        [{ stream: "sub", at: 7 }],
        []
      );
      // Target stream is colored cyan, source is dim, so ANSI codes
      // intervene between them — match each piece independently.
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/sub.*<-src/)
      );
    });

    it("withSubscribeTrace skips log when nothing newly subscribed", async () => {
      // Pre-subscribe so the next subscribe is a no-op
      await store().subscribe([{ stream: "already-there" }]);
      const { subscribe } = buildDrain(withLevel("trace"));
      const result = await subscribe([{ stream: "already-there" }]);
      expect(result.subscribed).toBe(0);
      const corrCalls = traceSpy.mock.calls.filter(
        (c: [unknown, unknown]) =>
          typeof c[0] === "string" && c[0].includes(">> correlated")
      );
      expect(corrCalls).toHaveLength(0);
    });

    it("withSubscribeTrace logs when subscribed > 0", async () => {
      const { subscribe } = buildDrain(withLevel("trace"));
      const result = await subscribe([{ stream: "fresh-stream" }]);
      expect(result.subscribed).toBeGreaterThan(0);
      // pretty mode wraps the >> correlated caption in ANSI codes; the
      // stream name follows after the reset, so match each piece.
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/>> correlated.*fresh-stream/)
      );
    });

    it("subscribe trace puts lane in caption when the batch is uniform (ACT-1103)", async () => {
      // Uniform-lane batches: lane in the caption, streams bare. Mirrors
      // the `>> drained` cycle caption convention so the operator sees
      // the lane once per line.
      const { subscribe } = buildDrain(withLevel("trace"));
      await subscribe([{ stream: "lane-sub-stream", lane: "slow" }]);
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(/>> correlated.*slow.*lane-sub-stream/)
      );
      // And the bracketed per-stream `[slow]` tag is gone.
      expect(traceSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("[slow]")
      );
    });

    it("subscribe trace falls back to per-stream `[lane]` when the batch is mixed", async () => {
      const { subscribe } = buildDrain(withLevel("trace"));
      await subscribe([
        { stream: "mix-fast", lane: "fast" },
        { stream: "mix-slow", lane: "slow" },
      ]);
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          />> correlated.*mix-fast.*\[fast\].*mix-slow.*\[slow\]/
        )
      );
    });
  });
});
