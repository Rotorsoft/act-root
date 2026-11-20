/**
 * The step that starts publication and the settled source for a generator.
 * The settled frames themselves come from the `$live` loop (sse-live.spec).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type SettledSource, sse_sources } from "../../src/api/sse-settled.js";
import { BroadcastChannel } from "../../src/sse/index.js";

/** A source that settles on command. */
const make_source = () => {
  const emitter = new EventEmitter();
  const source = {
    on: (event: string, listener: (arg: unknown) => void) =>
      emitter.on(event, listener),
    off: (event: string, listener: (arg: unknown) => void) =>
      emitter.off(event, listener),
    listeners: () => emitter.listenerCount("acked"),
  };
  return source as typeof source & SettledSource;
};

describe("sse_sources", () => {
  const channel = new BroadcastChannel();
  const registry = { actions: {}, sensitive_fields: () => [] };
  const bare = { registry, do: async () => [] };

  it("needs nothing when neither publish nor settled is on", () => {
    expect(
      sse_sources(
        bare,
        { channel, publish: false, settled: false, live: false },
        "trpc"
      )
    ).toBeUndefined();
  });

  it("refuses publish or settled on a surface without lifecycle events", () => {
    expect(() =>
      sse_sources(
        bare,
        { channel, publish: true, settled: false, live: false },
        "hono"
      )
    ).toThrow(
      "hono: `sse.publish`, `sse.settled` and `sse.live` listen to the app's"
    );
  });

  it("starts publication, and returns the app as the settled source", () => {
    const source = make_source();
    const app = { ...bare, on: source.on, off: source.off };
    expect(
      sse_sources(
        app,
        { channel, publish: true, settled: false, live: false },
        "trpc"
      )
    ).toBeUndefined();
    expect(
      sse_sources(
        app,
        { channel, publish: false, settled: true, live: false },
        "trpc"
      )
    ).toBe(app);
  });
});
