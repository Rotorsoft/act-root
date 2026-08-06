import { z } from "zod";
import { act, InMemoryCache, InMemoryStore, state } from "../src/index.js";
import { sandbox } from "../src/test/index.js";
import type { Store } from "../src/types/index.js";

/**
 * ACT-1207 — correlate cold-start checkpoint must not overshoot an
 * uncorrelated dynamic-resolver event.
 *
 * `init()` set the cold-start checkpoint to the store watermark
 * (`max(at)` across every subscribed stream). A static-target reaction
 * drains directly (subscribed at init, no correlate scan needed), so its
 * watermark can climb ABOVE a dynamic-resolver event that was committed
 * but never correlated before a crash. On restart a plain `max(at)` cold
 * start then scans past that event and its one-shot dynamic target is
 * never subscribed.
 *
 * The fix floors the cold-start checkpoint at `watermark - back_scan`
 * (when dynamic resolvers exist) so the crash-window tail is re-scanned.
 * RED on the old code (the cold dynamic target is never discovered);
 * GREEN once the back-scan re-finds it.
 */

const Order = state({ Order: z.object({ placed: z.boolean() }) })
  .init(() => ({ placed: false }))
  .emits({ OrderPlaced: z.object({ sku: z.string() }) })
  .patch({ OrderPlaced: () => ({ placed: true }) })
  .on({ place: z.object({ sku: z.string() }) })
  .emit((a) => ["OrderPlaced", a])
  .build();

const actor = { id: "a", name: "a" };

describe("correlate cold-start checkpoint overshoot (ACT-1207)", () => {
  it("still discovers a dynamic target committed-but-not-correlated before restart", async () => {
    const store = new InMemoryStore();
    const cache = new InMemoryCache();
    const audited: string[] = [];
    const fulfilled: string[] = [];

    const build = () =>
      act()
        .withState(Order)
        // Static-target reaction: subscribed at init, drains directly
        // without a correlate scan — its watermark climbs on plain drain.
        .on("OrderPlaced")
        .do(async function audit(event) {
          audited.push(event.stream);
        })
        .to({ target: "audit", source: "^order-" })
        // Dynamic-target reaction: needs correlate to discover the
        // per-order fulfillment stream.
        .on("OrderPlaced")
        .do(async function fulfill(event) {
          fulfilled.push(event.stream);
        })
        .to((e) => ({ target: `fulfill:${e.stream}`, source: e.stream }))
        .build();

    // First process: commit the cold trigger, then advance the static
    // "audit" watermark above it by draining WITHOUT ever correlating.
    const ctx1 = await sandbox(
      { build },
      { store: () => store, cache: () => cache }
    );
    try {
      const app1 = ctx1.app as ReturnType<typeof build>;
      // Init + arm the static "audit" subscription on an empty store —
      // this is the last correlate that runs, so anything committed after
      // it stays uncorrelated on the dynamic side.
      await app1.correlate();
      // Cold trigger at a low event id. `place` commits OrderPlaced on
      // order-cold — a source event for BOTH reactions.
      await app1.do("place", { stream: "order-cold", actor }, { sku: "c0" });

      // Drain the static "audit" stream repeatedly as more orders land —
      // audit acks climb well past order-cold's event id. Crucially, NO
      // correlate() runs, so fulfill:order-cold is never subscribed.
      for (let i = 0; i < 6; i++) {
        await app1.do(
          "place",
          { stream: `order-h${i}`, actor },
          { sku: `h${i}` }
        );
        for (;;) {
          const d = await app1.drain({ leaseMillis: 10_000, eventLimit: 100 });
          if (d.acked.length === 0) break;
        }
      }
      expect(audited.length).toBeGreaterThan(0); // static side made progress
      expect(fulfilled).not.toContain("order-cold"); // dynamic side uncorrelated
    } finally {
      await ctx1.dispose();
    }

    // Second process (restart): fresh Act over the same store. Cold start
    // must re-scan far enough to discover fulfill:order-cold.
    const ctx2 = await sandbox(
      { build },
      { store: () => store, cache: () => cache }
    );
    try {
      const app2 = ctx2.app as ReturnType<typeof build>;
      await app2.correlate();
      for (;;) {
        const d = await app2.drain({ leaseMillis: 10_000, eventLimit: 100 });
        if (d.acked.length === 0) break;
      }
      expect(fulfilled).toContain("order-cold");
    } finally {
      await ctx2.dispose();
    }
  });
});

/**
 * #1387 — `init()` latched "already initialized" BEFORE the awaited
 * `subscribe`, so one transient store failure at cold start left every
 * static target unsubscribed for the process lifetime. Nothing reset the
 * flag, and the failure was invisible afterwards: no subscription row
 * means `claim` can never return the stream, `blocked_streams()` is
 * empty, and the audit has no row to report.
 */
describe("init retries after a transient store failure (#1387)", () => {
  const actor = { id: "a", name: "a" };

  const Src = state({ Src: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Fired: z.object({}) })
    .patch({ Fired: (_e, s) => ({ n: s.n + 1 }) })
    .on({ fire: z.object({}) })
    .emit(() => ["Fired", {}])
    .build();

  /** Fails the first `fail_times` subscribe calls, then delegates. */
  const flaky_subscribe = (inner: Store, fail_times: number): Store => {
    let calls = 0;
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "subscribe")
          return async (...args: unknown[]) => {
            if (calls++ < fail_times) throw new Error("connection reset");
            return (target.subscribe as never as (...a: unknown[]) => unknown)(
              ...args
            );
          };
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;
  };

  const run = async (fail_times: number) => {
    let handled = 0;
    const store = flaky_subscribe(new InMemoryStore(), fail_times);
    await store.seed();
    const cache = new InMemoryCache();
    const app = act()
      .withState(Src)
      .on("Fired")
      .do(async function react() {
        handled++;
      })
      .to("out")
      .build({ scoped: { store, cache } });

    await app.do("fire", { stream: "s1", actor }, {});
    let threw = false;
    try {
      await app.correlate();
    } catch {
      threw = true;
    }
    // Store is healthy now — the retry must repair init.
    await app.correlate();
    await app.drain();

    const subs: string[] = [];
    await store.query_streams((p) => subs.push(p.stream), { limit: 50 });

    await app.shutdown();
    await store.dispose();
    await cache.dispose();
    return { handled, threw, subs };
  };

  it("subscribes static targets on a retry after subscribe throws", async () => {
    const r = await run(1);
    expect(r.threw).toBe(true);
    expect(r.subs).toContain("out");
    expect(r.handled).toBe(1);
  });

  it("control — a healthy store subscribes on the first call", async () => {
    const r = await run(0);
    expect(r.threw).toBe(false);
    expect(r.subs).toContain("out");
    expect(r.handled).toBe(1);
  });

  it("shares one init across concurrent callers (single-flight)", async () => {
    let calls = 0;
    const inner = new InMemoryStore();
    await inner.seed();
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "subscribe")
          return async (...args: unknown[]) => {
            calls++;
            // Hold the first call open so the second caller arrives while
            // init is still in flight.
            await new Promise((r) => setTimeout(r, 10));
            return (target.subscribe as never as (...a: unknown[]) => unknown)(
              ...args
            );
          };
        return Reflect.get(target, prop, receiver);
      },
    }) as Store;

    const cache = new InMemoryCache();
    const app = act()
      .withState(Src)
      .on("Fired")
      .do(async function react() {})
      .to("out")
      .build({ scoped: { store, cache } });

    await Promise.all([app.correlate(), app.correlate(), app.correlate()]);
    expect(calls).toBe(1);

    await app.shutdown();
    await store.dispose();
    await cache.dispose();
  });
});
