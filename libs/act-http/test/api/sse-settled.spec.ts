/**
 * The `$settled` subscription loop and the step that starts publication and
 * the settled source for a generator.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  run_settled_subscription,
  type SettledSource,
  sse_sources,
} from "../../src/api/sse-settled.js";
import { BroadcastChannel } from "../../src/sse/index.js";

/** A source that settles on command. */
const make_source = () => {
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

describe("run_settled_subscription", () => {
  it("yields the targets that advanced, once per settle with any", async () => {
    const source = make_source();
    const abort = new AbortController();
    const frames = run_settled_subscription(source, undefined, abort.signal);
    const first = frames.next();
    await Promise.resolve();
    source.settle(); // nothing advanced: no frame
    source.settle("proj-a", "proj-a", "proj-b");
    expect((await first).value).toEqual({
      kind: "settled",
      data: { targets: ["proj-a", "proj-b"] },
    });
    abort.abort();
    expect((await frames.next()).done).toBe(true);
    expect(source.listeners()).toBe(0);
  });

  it("merges into the newest frame when the queue is full", async () => {
    const source = make_source();
    const abort = new AbortController();
    const frames = run_settled_subscription(source, undefined, abort.signal, {
      maxPending: 1,
    });
    const first = frames.next();
    await Promise.resolve();
    source.settle("a");
    await first;
    source.settle("b");
    source.settle("c", "b");
    expect((await frames.next()).value?.data.targets).toEqual(["b", "c"]);
    abort.abort();
    await frames.next();
  });

  it("takes a slot from the cap and frees it on close", async () => {
    const source = make_source();
    const accounting = { acquire: vi.fn(() => true), release: vi.fn() };
    const abort = new AbortController();
    const frames = run_settled_subscription(source, accounting, abort.signal);
    const first = frames.next();
    await Promise.resolve();
    expect(accounting.acquire).toHaveBeenCalledOnce();
    abort.abort();
    expect((await first).done).toBe(true);
    expect(accounting.release).toHaveBeenCalledOnce();
  });

  it("calls on_cap_exceeded when the cap is full, and runs unaccounted without one", async () => {
    const source = make_source();
    const full = { acquire: () => false, release: vi.fn() };
    const refused = run_settled_subscription(source, full, undefined, {
      on_cap_exceeded: () => {
        throw new Error("busy");
      },
    });
    await expect(refused.next()).rejects.toThrow("busy");
    const abort = new AbortController();
    const unaccounted = run_settled_subscription(source, full, abort.signal);
    const next = unaccounted.next();
    await Promise.resolve();
    abort.abort();
    await next;
    expect(full.release).not.toHaveBeenCalled();
  });
});

describe("sse_sources", () => {
  const channel = new BroadcastChannel();
  const registry = { actions: {}, sensitive_fields: () => [] };
  const bare = { registry, do: async () => [] };

  it("needs nothing when neither publish nor settled is on", () => {
    expect(
      sse_sources(bare, { channel, publish: false, settled: false }, "trpc")
    ).toBeUndefined();
  });

  it("refuses publish or settled on a surface without lifecycle events", () => {
    expect(() =>
      sse_sources(bare, { channel, publish: true, settled: false }, "hono")
    ).toThrow("hono: `sse.publish` and `sse.settled` listen to the app's");
  });

  it("starts publication, and returns the app as the settled source", () => {
    const source = make_source();
    const app = { ...bare, on: source.on, off: source.off };
    expect(
      sse_sources(app, { channel, publish: true, settled: false }, "trpc")
    ).toBeUndefined();
    expect(
      sse_sources(app, { channel, publish: false, settled: true }, "trpc")
    ).toBe(app);
  });
});
