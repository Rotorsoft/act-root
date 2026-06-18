import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, dispose, state, store, ZodEmpty } from "../src/index.js";
import type { StoreNotification } from "../src/types/index.js";

/**
 * #803 — ActOptions.listen and ActOptions.drain.
 *
 * Two orthogonal boolean flags on Act build options that gate the
 * subscription side (`listen`) and the local reaction pipeline
 * (`drain`). Default true for both, so existing builds are
 * untouched.
 */

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Tick: ZodEmpty })
  .patch({ Tick: (_, s) => ({ count: s.count + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Tick", {}])
  .build();

// A store with a `notify` method we can intercept to count subscription
// wirings. The implementation just records subscribers; nothing actually
// fires from it.
class NotifyStore extends InMemoryStore {
  public subscribed = 0;
  public unsubscribed = 0;
  public lastHandler: ((n: StoreNotification) => void) | null = null;
  // `notify` name matches Store.notify
  notify = async (handler: (notification: StoreNotification) => void) => {
    this.subscribed++;
    this.lastHandler = handler;
    return async () => {
      this.unsubscribed++;
      this.lastHandler = null;
    };
  };
}

let notifyStore: NotifyStore;

beforeEach(() => {
  notifyStore = new NotifyStore();
  store(notifyStore);
});

afterEach(async () => {
  await dispose()();
});

describe("ActOptions.listen and .drain", () => {
  it("defaults: subscribes to notify and runs local reactions", async () => {
    const handler = vi.fn();
    const app = act()
      .withState(Counter)
      .on("Tick")
      .do(handler)
      .to("tick-log")
      .build();
    // Give the async _wire_notify a microtask to complete.
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyStore.subscribed).toBe(1);
    await app.do("tick", { stream: "c1", actor: { id: "u", name: "U" } }, {});
    await app.correlate();
    await app.drain();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("listen: false skips the Store.notify subscription", async () => {
    act().withState(Counter).on("Tick").do(vi.fn()).to("x").build({
      listen: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyStore.subscribed).toBe(0);
  });

  it("listen: false still drains local commits", async () => {
    const handler = vi.fn();
    const app = act()
      .withState(Counter)
      .on("Tick")
      .do(handler)
      .to("local-log")
      .build({ listen: false });
    await app.do("tick", { stream: "c2", actor: { id: "u", name: "U" } }, {});
    await app.correlate();
    await app.drain();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("drain: false makes drain/correlate/settle no-ops", async () => {
    const handler = vi.fn();
    const app = act()
      .withState(Counter)
      .on("Tick")
      .do(handler)
      .to("noop-log")
      .build({ drain: false });
    await app.do("tick", { stream: "c3", actor: { id: "u", name: "U" } }, {});
    const drainResult = await app.drain();
    expect(drainResult).toEqual({
      fetched: [],
      leased: [],
      acked: [],
      blocked: [],
    });
    const corrResult = await app.correlate();
    expect(corrResult).toEqual({ subscribed: 0, last_id: -1 });
    // settle is sync and void — just verify it doesn't throw.
    app.settle();
    expect(handler).not.toHaveBeenCalled();
  });

  it("drain: false + listen: true emits `notified` without draining", async () => {
    const notified = vi.fn();
    const handler = vi.fn();
    const app = act()
      .withState(Counter)
      .on("Tick")
      .do(handler)
      .to("sidecar-log")
      .build({ drain: false, listen: true });
    app.on("notified", notified);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyStore.subscribed).toBe(1);
    // Simulate a remote commit arriving on the wire.
    notifyStore.lastHandler?.({
      stream: "remote-c",
      events: [{ id: 1, name: "Tick" }],
    });
    expect(notified).toHaveBeenCalledTimes(1);
    // No drain wakeup — handler never runs.
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it("listen: false + drain: false is the writer-only fleet", async () => {
    const handler = vi.fn();
    const app = act()
      .withState(Counter)
      .on("Tick")
      .do(handler)
      .to("writer-log")
      .build({ listen: false, drain: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyStore.subscribed).toBe(0);
    // Commit still works — the store's commit protocol is unchanged.
    await app.do(
      "tick",
      { stream: "writer", actor: { id: "u", name: "U" } },
      {}
    );
    // But nothing drains locally.
    await app.drain();
    expect(handler).not.toHaveBeenCalled();
  });
});
