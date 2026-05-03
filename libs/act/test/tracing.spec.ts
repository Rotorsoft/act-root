import { z } from "zod";
import { InMemoryCache } from "../src/adapters/InMemoryCache.js";
import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { state } from "../src/builders/state-builder.js";
import * as drain from "../src/internal/drain.js";
import * as es from "../src/internal/event-sourcing.js";
import { buildDrain, buildEs } from "../src/internal/tracing.js";
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
    it("returns bare ops for non-trace levels", () => {
      const ops = buildEs(withLevel("info"));
      expect(ops.snap).toBe(es.snap);
      expect(ops.load).toBe(es.load);
      expect(ops.action).toBe(es.action);
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

    it("returns wrapped ops for trace level", () => {
      const ops = buildDrain(withLevel("trace"));
      expect(ops.claim).not.toBe(drain.claim);
      expect(ops.fetch).not.toBe(drain.fetch);
      expect(ops.ack).not.toBe(drain.ack);
      expect(ops.block).not.toBe(drain.block);
      expect(ops.subscribe).not.toBe(drain.subscribe);
    });
  });

  describe("event-sourcing trace decorators", () => {
    let traceSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      traceSpy = vi.spyOn(log(), "trace").mockImplementation(() => {});
    });

    it("withLoadTrace logs entry without asOf", async () => {
      const { load } = buildEs(withLevel("trace"));
      await load(Counter, "s1");
      expect(traceSpy).toHaveBeenCalledWith(expect.stringContaining("s1"));
    });

    it("withLoadTrace logs entry with asOf marker", async () => {
      const { load } = buildEs(withLevel("trace"));
      await load(Counter, "s1", undefined, { before: 9999 });
      expect(traceSpy).toHaveBeenCalledWith(
        expect.stringContaining("s1 (as-of)")
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

    // Helper: a trace call with caption substring `>> claimed` etc.
    // Tests assert the caption substring; in pretty mode the caption is
    // wrapped in ANSI color codes, but the substring still matches.
    const calledWithCaption = (substr: string) =>
      expect(traceSpy).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining(substr)
      );
    const noCaptionCall = (substr: string) =>
      traceSpy.mock.calls.filter(
        (c: [unknown, unknown]) =>
          typeof c[1] === "string" && c[1].includes(substr)
      );

    it("withClaimTrace skips log when no leases returned", async () => {
      const { claim } = buildDrain(withLevel("trace"));
      const leased = await claim(1, 1, "by-x", 1000);
      expect(leased).toEqual([]);
      expect(noCaptionCall(">> claimed")).toHaveLength(0);
    });

    it("withClaimTrace logs when leases returned", async () => {
      await store().subscribe([{ stream: "claim-stream" }]);
      await es.action(Counter, "increment", target("claim-stream"), {
        by: 1,
      });
      const { claim } = buildDrain(withLevel("trace"));
      const leased = await claim(2, 0, "claim-by", 60_000);
      expect(leased.length).toBeGreaterThan(0);
      calledWithCaption(">> claimed");
    });

    it("withFetchTrace logs stream-only and stream<-source variants", async () => {
      // Commit so we have events to "fetch"
      await es.action(Counter, "increment", target("fetch-stream"), { by: 2 });

      const { fetch } = buildDrain(withLevel("trace"));
      const fetched = await fetch(
        [
          {
            stream: "stream-only",
            at: -1,
            by: "x",
            retry: 0,
            lagging: false,
          },
          {
            stream: "with-source",
            source: "fetch-stream",
            at: -1,
            by: "x",
            retry: 0,
            lagging: false,
          },
        ],
        100
      );
      expect(fetched).toHaveLength(2);
      calledWithCaption(">> fetched");
    });

    it("withAckTrace skips log on empty", async () => {
      const { ack } = buildDrain(withLevel("trace"));
      const result = await ack([]);
      expect(result).toEqual([]);
      expect(noCaptionCall(">> acked")).toHaveLength(0);
    });

    it("withAckTrace logs on non-empty", async () => {
      await store().subscribe([{ stream: "ack-stream" }]);
      await es.action(Counter, "increment", target("ack-stream"), { by: 1 });
      const { claim, ack } = buildDrain(withLevel("trace"));
      const leased = await claim(2, 0, "ack-by", 60_000);
      expect(leased.length).toBeGreaterThan(0);
      const acked = await ack(leased);
      expect(acked.length).toBeGreaterThan(0);
      calledWithCaption(">> acked");
    });

    it("withBlockTrace skips log on empty", async () => {
      const { block } = buildDrain(withLevel("trace"));
      const result = await block([]);
      expect(result).toEqual([]);
      expect(noCaptionCall(">> blocked")).toHaveLength(0);
    });

    it("withBlockTrace logs on non-empty", async () => {
      await store().subscribe([{ stream: "block-stream" }]);
      await es.action(Counter, "increment", target("block-stream"), {
        by: 1,
      });
      const { claim, block } = buildDrain(withLevel("trace"));
      const leased = await claim(2, 0, "block-by", 60_000);
      expect(leased.length).toBeGreaterThan(0);
      const blocked = await block(leased.map((l) => ({ ...l, error: "boom" })));
      expect(blocked.length).toBeGreaterThan(0);
      calledWithCaption(">> blocked");
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
  });
});
