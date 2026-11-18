/**
 * The `$live` subscription loop, which follows many streams and the settled
 * targets in one feed, and the check of what a `$live` request names.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { live_sources, run_live_subscription } from "../../src/api/sse-live.js";
import type { SettledSource } from "../../src/api/sse-settled.js";
import { BroadcastChannel } from "../../src/sse/index.js";

type S = { _v: number; n: number };

const settled_source = () => {
  const emitter = new EventEmitter();
  const source = {
    on: (event: string, listener: (arg: unknown) => void) =>
      emitter.on(event, listener),
    off: (event: string, listener: (arg: unknown) => void) =>
      emitter.off(event, listener),
    settle: (...streams: string[]) =>
      emitter.emit("settled", { acked: streams.map((stream) => ({ stream })) }),
    listeners: () => emitter.listenerCount("settled"),
  };
  return source as typeof source & SettledSource;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("run_live_subscription", () => {
  it("yields each source's cached state, then patches and settles tagged with their source", async () => {
    const channel = new BroadcastChannel<S>();
    channel.publish("a-1", { _v: 0, n: 1 }, [{ n: 1 }]);
    const source = settled_source();
    const abort = new AbortController();
    const frames = run_live_subscription(
      channel,
      [
        { state: "A", stream: "a-1" },
        { state: "B", stream: "b-1" },
      ],
      source,
      undefined,
      abort.signal
    );
    expect((await frames.next()).value).toEqual({
      kind: "state",
      state: "A",
      stream: "a-1",
      data: { _v: 0, n: 1 },
    });
    const next = frames.next();
    await tick();
    channel.publish("b-1", { _v: 0, n: 2 }, [{ n: 2 }]);
    expect((await next).value).toMatchObject({
      kind: "patch",
      state: "B",
      stream: "b-1",
    });
    source.settle("view");
    source.settle(); // nothing advanced: no frame
    expect((await frames.next()).value).toEqual({
      kind: "settled",
      data: { targets: ["view"] },
    });
    abort.abort();
    expect((await frames.next()).done).toBe(true);
    expect(source.listeners()).toBe(0);
  });

  it("swaps an overflowing stream's frames for one _resync, keeping the others", async () => {
    const channel = new BroadcastChannel<S>();
    const abort = new AbortController();
    const frames = run_live_subscription(
      channel,
      [
        { state: "A", stream: "a-1" },
        { state: "B", stream: "b-1" },
      ],
      undefined,
      undefined,
      abort.signal,
      { maxPending: 2 }
    );
    const first = frames.next();
    await tick();
    channel.publish("a-1", { _v: 0, n: 1 }, [{ n: 1 }]);
    await first;
    channel.publish("b-1", { _v: 0, n: 1 }, [{ n: 1 }]);
    channel.publish("a-1", { _v: 1, n: 2 }, [{ n: 2 }]);
    channel.publish("a-1", { _v: 2, n: 3 }, [{ n: 3 }]);
    const b = (await frames.next()).value;
    const a = (await frames.next()).value;
    expect(b).toMatchObject({ kind: "patch", stream: "b-1" });
    expect(a).toMatchObject({ kind: "patch", stream: "a-1" });
    expect((a as { data: { _resync?: unknown } }).data).toHaveProperty(
      "_resync"
    );
    abort.abort();
    await frames.next();
  });

  it("joins a settle to the newest pending settled frame when the queue is full", async () => {
    const channel = new BroadcastChannel<S>();
    const source = settled_source();
    const abort = new AbortController();
    const frames = run_live_subscription(
      channel,
      [{ state: "A", stream: "a-1" }],
      source,
      undefined,
      abort.signal,
      { maxPending: 2 }
    );
    const first = frames.next();
    await tick();
    source.settle("a");
    await first;
    source.settle("b");
    channel.publish("a-1", { _v: 0, n: 1 }, [{ n: 1 }]);
    // Full: the settle steps back over the patch to the pending settled frame.
    source.settle("c", "b");
    expect((await frames.next()).value).toEqual({
      kind: "settled",
      data: { targets: ["b", "c"] },
    });
    expect((await frames.next()).value).toMatchObject({
      kind: "patch",
      stream: "a-1",
    });
    abort.abort();
    await frames.next();
  });

  it("takes one slot however many sources it follows, and frees it on close", async () => {
    const channel = new BroadcastChannel<S>();
    const accounting = { acquire: vi.fn(() => true), release: vi.fn() };
    const abort = new AbortController();
    const frames = run_live_subscription(
      channel,
      [
        { state: "A", stream: "a-1" },
        { state: "A", stream: "a-2" },
      ],
      undefined,
      accounting,
      abort.signal
    );
    const next = frames.next();
    await tick();
    expect(accounting.acquire).toHaveBeenCalledOnce();
    abort.abort();
    expect((await next).done).toBe(true);
    expect(accounting.release).toHaveBeenCalledOnce();
    const full = { acquire: () => false, release: vi.fn() };
    const refused = run_live_subscription(
      channel,
      [],
      undefined,
      full,
      undefined,
      {
        on_cap_exceeded: () => {
          throw new Error("busy");
        },
      }
    );
    await expect(refused.next()).rejects.toThrow("busy");
  });
});

describe("live_sources", () => {
  const served = new Set(["A", "B"]);
  const patterns = { A: /^a-\d+$/, B: (s: string) => s.startsWith("b-") };

  it("lists each stream once, with its state", () => {
    expect(
      live_sources(
        { streams: { A: ["a-1", "a-1"], B: ["b-9"] } },
        served,
        patterns,
        5
      )
    ).toEqual({
      sources: [
        { state: "A", stream: "a-1" },
        { state: "B", stream: "b-9" },
      ],
    });
    expect(live_sources({ settled: true }, served, {}, 5)).toEqual({
      sources: [],
    });
    // A state listed with no streams names none, as a typed input allows.
    expect(
      live_sources(
        { streams: { A: undefined, B: ["b-1"] }, settled: true },
        served,
        {},
        5
      )
    ).toEqual({ sources: [{ state: "B", stream: "b-1" }] });
  });

  it("refuses an unserved state, a stream outside its pattern, one under two states, nothing, or too many", () => {
    expect(
      live_sources({ streams: { C: ["c-1"] } }, served, patterns, 5)
    ).toEqual({ refused: 'no live state "C"' });
    expect(
      live_sources({ streams: { A: ["b-1"] } }, served, patterns, 5)
    ).toEqual({ refused: '"b-1" is not a stream of A' });
    expect(
      live_sources({ streams: { B: ["a-1"] } }, served, patterns, 5)
    ).toEqual({ refused: '"a-1" is not a stream of B' });
    expect(live_sources({ streams: { A: [""] } }, served, {}, 5)).toEqual({
      refused: '"" is not a stream of A',
    });
    expect(
      live_sources({ streams: { A: ["s-1"], B: ["s-1"] } }, served, {}, 5)
    ).toEqual({ refused: '"s-1" is listed under both A and B' });
    expect(live_sources({}, served, {}, 5)).toEqual({
      refused: "name at least one stream, or settled",
    });
    expect(
      live_sources({ streams: { A: ["a-1", "a-2"] } }, served, {}, 1)
    ).toEqual({
      refused: "2 streams, more than the 1 a subscription follows",
    });
  });
});
