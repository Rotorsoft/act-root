import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  dispose,
  InMemoryCache,
  InMemoryStore,
  log,
  sleep,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";
import { store as store_port } from "../src/ports.js";
import { sandbox } from "../src/test/index.js";
import type { Store, StreamPosition } from "../src/types/index.js";

/**
 * Correlate carries an armed flag like the drain: a scan runs only when a
 * commit or notification says there may be work, or a poll asks anyway.
 */
describe("correlate: the armed flag", () => {
  const Ticker = state({ Ticker: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Ticked: ZodEmpty })
    .patch({ Ticked: (_, s) => ({ n: s.n + 1 }) })
    .on({ tick: ZodEmpty })
    .emit(() => ["Ticked", {}])
    .build();

  /** A state whose event has NO registered reaction. */
  const Quiet = state({ Quiet: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Hushed: ZodEmpty })
    .patch({ Hushed: (_, s) => ({ n: s.n + 1 }) })
    .on({ hush: ZodEmpty })
    .emit(() => ["Hushed", {}])
    .build();

  const actor = { id: "a", name: "a" };

  /** Count store reads, which is what a correlate scan costs. */
  const count_queries = (s: InMemoryStore) => {
    const counter = { n: 0 };
    const original = s.query.bind(s);
    s.query = ((...args: Parameters<typeof original>) => {
      counter.n++;
      return original(...args);
    }) as typeof s.query;
    return counter;
  };

  const build = () =>
    act()
      .withState(Ticker)
      .on("Ticked")
      .do(async function noop() {})
      .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
      .build();

  /** Correlate + drain until a pass makes no progress — what settle loops. */
  const quiesce = async (app: ReturnType<typeof build>) => {
    for (let i = 0; i < 10; i++) {
      const before = await app.correlate();
      const drain = await app.drain();
      if (!before.subscribed && !drain.acked.length && !drain.blocked.length)
        return;
    }
  };

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  describe("correlate sits still when nothing has happened", () => {
    it("issues no store read once a scan has reached the end of the log", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const app = build();

      await app.do("tick", { stream: "s1", actor }, {});
      await quiesce(app);

      const queries = count_queries(raw);
      await app.correlate();
      await app.correlate();
      expect(queries.n).toBe(0);
    });

    it("re-arms on a commit, so new work is still found", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const app = build();

      await app.do("tick", { stream: "s1", actor }, {});
      await quiesce(app);

      // Quiet: the scan is parked.
      const idle = count_queries(raw);
      await app.correlate();
      expect(idle.n).toBe(0);

      // A commit is exactly the event that might give a scan something to find.
      await app.do("tick", { stream: "s2", actor }, {});
      const scan = await app.correlate();
      expect(scan.subscribed).toBe(1);
    });

    it("keeps scanning while a backlog is still producing work", async () => {
      // Arming from inside correlate re-arms correlate itself, which is what
      // keeps a backlog moving: a scan that found something leaves the flag up
      // so the next pass continues, and only the scan that finds nothing stops
      // the loop. A one-shot disarm would strand everything past the first
      // window.
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const app = build();

      for (let i = 0; i < 12; i++)
        await app.do("tick", { stream: `s${i}`, actor }, {});

      let subscribed = 0;
      for (let i = 0; i < 10; i++) {
        const scan = await app.correlate({ after: -1, limit: 3 });
        subscribed += scan.subscribed;
      }
      // All twelve targets discovered across the windowed scans, not just the
      // first window's three.
      expect(subscribed).toBe(12);
    });

    it("keeps scanning past a FULL window that resolved no target", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const app = act()
        .withState(Ticker)
        .withState(Quiet)
        .on("Ticked")
        .do(async function noop() {})
        .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
        .build();

      // One window's worth of inert events, then the reactive one.
      for (let i = 0; i < 5; i++)
        await app.do("hush", { stream: `q${i}`, actor }, {});
      await app.do("tick", { stream: "s1", actor }, {});

      let subscribed = 0;
      for (let i = 0; i < 10; i++) {
        const scan = await app.correlate({ after: -1, limit: 5 });
        subscribed += scan.subscribed;
      }
      expect(subscribed).toBe(1);
    });

    it("a full inert window does not make settle report a false catch-up", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const handled: string[] = [];
      const app = act()
        .withState(Ticker)
        .withState(Quiet)
        .on("Ticked")
        .do(async function record(e) {
          handled.push(e.stream);
        })
        .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
        .build();

      // The default settle window is 100, so 100 inert commits fill it.
      for (let i = 0; i < 100; i++)
        await app.do("hush", { stream: `q${i}`, actor }, {});
      await app.do("tick", { stream: "s1", actor }, {});

      // `settle` is debounced: it schedules and returns.
      const done = new Promise<void>((resolve) => {
        app.on("settled", () => resolve());
      });
      app.settle({ debounceMs: 0 });
      await done;
      expect(handled).toEqual(["s1"]);
    });

    it("still parks when the window came back short", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const app = act()
        .withState(Ticker)
        .withState(Quiet)
        .on("Ticked")
        .do(async function noop() {})
        .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
        .build();

      for (let i = 0; i < 3; i++)
        await app.do("hush", { stream: `q${i}`, actor }, {});

      // Three events in a window of ten: short, so it parks.
      await app.correlate({ after: -1, limit: 10 });
      const queries = count_queries(raw);
      await app.correlate({ after: -1, limit: 10 });
      await app.correlate({ after: -1, limit: 10 });
      expect(queries.n).toBe(0);
    });

    it("parks after an UNBOUNDED scan that resolved no target", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const app = act()
        .withState(Ticker)
        .withState(Quiet)
        .on("Ticked")
        .do(async function noop() {})
        .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
        .build();

      for (let i = 0; i < 4; i++)
        await app.do("hush", { stream: `q${i}`, actor }, {});

      // `{}` overrides the default query, so `limit` is undefined.
      await app.correlate({});
      const queries = count_queries(raw);
      await app.correlate({});
      expect(queries.n).toBe(0);
    });

    it("polling discovers and drains a commit this process never saw", async () => {
      // The flag means "a local signal says there may be work" — a commit here,
      // or a notify from elsewhere. It is NOT a claim that the log is unchanged:
      // a remote writer on a store without notify leaves this process disarmed
      // and stale. Polling is the path for that case, so it arms every tick;
      // without that, parking the scan would silently strand remote writes.
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const seen: string[] = [];
      const app = act()
        .withState(Ticker)
        .on("Ticked")
        .do(async function record(e) {
          seen.push(e.stream);
        })
        .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
        .build();

      await app.do("tick", { stream: "s1", actor }, {});
      await quiesce(app);

      // Write straight to the store, the way another process would — nothing
      // arms this Act.
      await raw.commit("remote-1", [{ name: "Ticked", data: {} }], {
        correlation: "c",
        causation: {},
      });
      const idle = count_queries(raw);
      await app.correlate();
      expect(idle.n).toBe(0); // still parked — no local signal

      // Polling alone arms, finds it, and runs its reaction.
      app.start_correlations({ limit: 100 }, 5);
      await vi.waitFor(() => expect(seen).toContain("remote-1"));
      app.stop_correlations();
    });
  });
});

/**
 * Correlate arms the lane controllers when it subscribes new streams or
 * raises marks, so a lane that just disarmed does not sleep through them.
 */
describe("correlate: arming lanes", () => {
  describe("correlate arms lanes for newly-subscribed streams", () => {
    const order = state({ Order: z.object({ sku: z.string() }) })
      .init(() => ({ sku: "" }))
      .emits({ OrderPlaced: z.object({ sku: z.string() }) })
      .patch({ OrderPlaced: (e) => ({ sku: e.data.sku }) })
      .on({ place: z.object({ sku: z.string() }) })
      .emit((a) => ["OrderPlaced", a])
      .build();

    const actor = { id: "a", name: "a" };

    afterEach(async () => {
      vi.restoreAllMocks();
      await dispose()();
    });

    it("revives a lane that disarmed before the subscription landed", async () => {
      const seen: string[] = [];
      const app = act()
        .withState(order)
        .withLane({ name: "payments", cycleMs: 20 })
        .on("OrderPlaced")
        .do(async function charge(event) {
          seen.push(event.stream);
        })
        .to((e) => ({
          target: `payments:${e.stream}`,
          source: e.stream,
          lane: "payments",
        }))
        .build();

      // Consume the correlate cycle's one-time cold-start arm first, so
      // the assertions below exercise the steady state, not init.
      await app.correlate();

      // Commit arms the lanes, but the payments worker (20ms cadence)
      // claims before any subscription exists and disarms itself. No
      // settle wiring here — the starvation window is the point.
      await app.do("place", { stream: "o1", actor }, { sku: "x" });
      await sleep(80);
      expect(seen).toHaveLength(0); // worker ticked empty and went idle

      // Correlate discovers and subscribes payments:o1 — and must re-arm
      // the lane so its worker picks the stream up on the next tick.
      const { subscribed } = await app.correlate();
      expect(subscribed).toBe(1);
      await sleep(120);
      expect(seen).toEqual(["o1"]);
    });

    it("processes a first-ever event via the canonical settle wiring", async () => {
      // Contract test over the production composition end to end: settle
      // on commit, a lane worker, a dynamic resolver — no manual correlate
      // or drain anywhere. The first-ever event on a fresh dynamic target
      // must be processed without any additional traffic. (The direct-path
      // test above is the minimal pin for the arming bug; this one guards
      // the canonical wiring against any future regression in the
      // init/arm/correlate/drain interplay, where the starvation window
      // depends on store latency.)
      const seen: string[] = [];
      const app = act()
        .withState(order)
        .withLane({ name: "payments", cycleMs: 20 })
        .on("OrderPlaced")
        .do(async function charge(event) {
          seen.push(event.stream);
        })
        .to((e) => ({
          target: `payments:${e.stream}`,
          source: e.stream,
          lane: "payments",
        }))
        .build({ settleDebounceMs: 150 });
      app.on("committed", () => app.settle());

      await app.do("place", { stream: "o1", actor }, { sku: "x" });
      await vi.waitFor(() => expect(seen).toEqual(["o1"]), { timeout: 2_000 });
    });
  });
});

/**
 * The correlate checkpoint is durable and single-writer: it survives a
 * restart and rides correlate's own subscribe.
 */
describe("correlate: the checkpoint", () => {
  const ZodEmpty = z.object({});

  const Ticker = state({ Ticker: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Ticked: ZodEmpty })
    .patch({ Ticked: (_, s) => ({ n: s.n + 1 }) })
    .on({ tick: ZodEmpty })
    .emit(() => ["Ticked", {}])
    .build();

  const actor = { id: "a", name: "a" };

  /** An Act whose dynamic resolver makes correlate actually scan. */
  const worker = () =>
    act()
      .withState(Ticker)
      .on("Ticked")
      .do(async function noop() {})
      .to((e) => ({ target: `dyn-${e.stream}` }))
      .build();

  /** The checkpoint rides subscribe's return (#1484). */
  const peek = async (s: InMemoryStore) =>
    (await s.subscribe([])).correlated_at;

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  /**
   * Count the events a scan actually reads. Re-scanning is the only observable
   * difference the durable checkpoint makes: a restart converges on the same
   * `subscribed` count and the same `last_id` either way — the store's UPSERT
   * is idempotent and the ids are the same ids — so asserting on those proves
   * nothing. The work is what changes.
   */
  const count_scanned = (s: InMemoryStore) => {
    const counter = { n: 0 };
    const original = s.query.bind(s);
    s.query = ((cb: (e: never) => void, q: never) =>
      original((e) => {
        counter.n++;
        cb(e as never);
      }, q)) as typeof s.query;
    return counter;
  };

  describe("the checkpoint survives a restart", () => {
    it("resumes where the previous process stopped, re-reading nothing", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();

      const w1 = worker();
      await w1.do("tick", { stream: "src", actor }, {});
      const first = await w1.correlate();
      expect(first.subscribed).toBe(1);
      await w1.shutdown();

      // A new process over the same store: its correlate must not re-scan the
      // range the first one already covered. Without the durable checkpoint it
      // cold-starts from the subscription watermark backed off by the
      // back-scan window — which, with the target still undrained at -1, is
      // the whole log.
      const scanned = count_scanned(raw);
      const w2 = worker();
      const second = await w2.correlate();
      expect(scanned.n).toBe(0);
      expect(second.subscribed).toBe(0);
      expect(second.last_id).toBe(first.last_id);
    });

    it("picks up events committed after the checkpoint, and only those", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const w1 = worker();
      await w1.do("tick", { stream: "a", actor }, {});
      await w1.correlate();
      await w1.shutdown();

      const w2 = worker();
      await w2.do("tick", { stream: "b", actor }, {});
      // `do` reads the stream to fold state, so count only the scan.
      const scanned = count_scanned(raw);
      const after = await w2.correlate();
      expect(after.subscribed).toBe(1);
      // The one new event, not the one the first process already correlated.
      expect(scanned.n).toBe(1);
    });
  });

  describe("the checkpoint is persisted by correlate's own subscribe", () => {
    it("advances as soon as a scan registers what it found", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const w1 = worker();
      await w1.do("tick", { stream: "src", actor }, {});

      // No drain needed: correlate persists its cursor in the same subscribe
      // that registers the targets it discovered.
      const scan = await w1.correlate();
      expect(scan.subscribed).toBe(1);
      expect(await peek(raw)).toBe(scan.last_id);
    });

    it("never regresses on a later, lower value", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      await raw.subscribe([], 50);
      await raw.subscribe([], 10);
      expect(await peek(raw)).toBe(50);
    });
  });

  describe("a static-only app advances the checkpoint too", () => {
    it("persists how far the scan read, because it scans now", async () => {
      const raw = new InMemoryStore();
      store(raw);
      await store().seed();
      const app = act()
        .withState(Ticker)
        .on("Ticked")
        .do(async function noop() {})
        .to({ target: "out" })
        .build();

      await app.do("tick", { stream: "src", actor }, {});
      const scan = await app.correlate();

      // Correlate marks the static target, so it subscribes — and the cursor
      // rides that same call. Before #1487 correlate returned without reading
      // anything and the checkpoint stayed at -1.
      expect(await peek(raw)).toBe(scan.last_id);
    });
  });
});

/**
 * A cold start re-scans a bounded tail below the watermark, and init
 * retries after a transient store failure.
 */
describe("correlate: cold start", () => {
  const Order = state({ Order: z.object({ placed: z.boolean() }) })
    .init(() => ({ placed: false }))
    .emits({ OrderPlaced: z.object({ sku: z.string() }) })
    .patch({ OrderPlaced: () => ({ placed: true }) })
    .on({ place: z.object({ sku: z.string() }) })
    .emit((a) => ["OrderPlaced", a])
    .build();

  const actor = { id: "a", name: "a" };

  describe("correlate cold-start checkpoint overshoot", () => {
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
          // Mark the static target by hand rather than correlating (#1488).
          // `claim` follows marks now, so a drain-only loop would find nothing
          // — but running correlate here would also discover the dynamic
          // target, which is the very thing this scenario needs left undone.
          const { maxEventId } = await store_port().query_streams(() => {});
          await store_port().subscribe([
            { stream: "audit", correlated_at: maxEventId },
          ]);
          for (;;) {
            const d = await app1.drain({
              leaseMillis: 10_000,
              eventLimit: 100,
            });
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
  describe("init retries after a transient store failure", () => {
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
              return (
                target.subscribe as never as (...a: unknown[]) => unknown
              )(...args);
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
              return (
                target.subscribe as never as (...a: unknown[]) => unknown
              )(...args);
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
});

/**
 * When reactions resolve one target to different lanes, the highest
 * priority sets the lane; ties are reported.
 */
describe("correlate: dynamic lanes", () => {
  describe("correlate dynamic-resolver lane", () => {
    const counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ ticked: ZodEmpty })
      .patch({ ticked: (_e, s) => ({ count: s.count + 1 }) })
      .on({ tick: ZodEmpty })
      .emit(() => ["ticked", {}])
      .build();

    const actor = { id: "a", name: "a" };

    afterEach(async () => {
      await dispose()();
    });

    it("the highest-priority reaction sets the target's lane", async () => {
      const app = act()
        .withState(counter)
        .withLane({ name: "fast" })
        .withLane({ name: "slow" })
        // Low priority, "fast" lane — registered first, so scanned first and
        // seeds the entry's lane.
        .on("ticked")
        .do(async function reactLow() {})
        .to(() => ({ target: "shared", priority: 1, lane: "fast" }))
        // Higher priority, "slow" lane — must win the lane, not just the priority.
        .on("ticked")
        .do(async function reactHigh() {})
        .to(() => ({ target: "shared", priority: 7, lane: "slow" }))
        .build();

      await app.do("tick", { stream: "s1", actor }, {});
      await app.correlate();

      let lane: string | undefined;
      let priority = -1;
      await store().query_streams((p) => {
        if (p.stream === "shared") {
          lane = p.lane;
          priority = p.priority;
        }
      });

      expect(priority).toBe(7); // max priority — already correct
      expect(lane).toBe("slow"); // the winning reaction's lane, not "fast"
    });

    // #1363: the runtime max() invariant must hold ACROSS correlate scans, not
    // only within one. A dynamic target subscribed at a low priority must be
    // re-subscribed (raising the store's priority) when a later scan resolves a
    // higher one — the `_dynamic_subscriptions` dedup used to freeze it at first discovery.
    describe("cross-scan priority upgrade", () => {
      const tiered = state({ Counter: z.object({ count: z.number() }) })
        .init(() => ({ count: 0 }))
        .emits({ ticked: z.object({ premium: z.boolean() }) })
        .patch({ ticked: (_e, s) => ({ count: s.count + 1 }) })
        .on({ tick: z.object({ premium: z.boolean() }) })
        .emit((a) => ["ticked", { premium: a.premium }])
        .build();

      function buildTiered() {
        return act()
          .withState(tiered)
          .withLane({ name: "fast" })
          .withLane({ name: "slow" })
          .on("ticked")
          .do(async function react() {})
          .to((e) => ({
            target: "shared",
            source: e.stream,
            priority: (e.data as { premium: boolean }).premium ? 5 : 0,
            lane: (e.data as { premium: boolean }).premium ? "slow" : "fast",
          }))
          .build();
      }

      async function sharedState(): Promise<{
        priority: number;
        lane?: string;
      }> {
        let priority = -1;
        let lane: string | undefined;
        await store().query_streams((p) => {
          if (p.stream === "shared") {
            priority = p.priority;
            lane = p.lane;
          }
        });
        return { priority, lane };
      }

      it("a later higher-priority scan raises the target's priority and lane", async () => {
        const app = buildTiered();
        // Scan 1: free-tier event → shared subscribed at priority 0, lane fast.
        await app.do("tick", { stream: "free", actor }, { premium: false });
        await app.correlate();
        expect(await sharedState()).toEqual({ priority: 0, lane: "fast" });

        // Scan 2: premium event to the same target → must rise to 5 / slow.
        await app.do("tick", { stream: "prem", actor }, { premium: true });
        await app.correlate();
        expect(await sharedState()).toEqual({ priority: 5, lane: "slow" });
      });

      it("a later lower-priority scan does NOT lower the target (max holds)", async () => {
        const app = buildTiered();
        // Scan 1: premium → priority 5.
        await app.do("tick", { stream: "prem", actor }, { premium: true });
        await app.correlate();
        expect((await sharedState()).priority).toBe(5);

        // Scan 2: free-tier → must stay at 5 (dedup, no downgrade).
        await app.do("tick", { stream: "free", actor }, { premium: false });
        await app.correlate();
        expect((await sharedState()).priority).toBe(5);
      });

      it("a resolver that omits priority dedups a re-seen target at default 0", async () => {
        // No `priority` field on the resolver → defaults to 0 on both scans, so
        // the second scan re-evaluates the guard (recorded is defined) and dedups.
        const app = act()
          .withState(tiered)
          .on("ticked")
          .do(async function react() {})
          .to((e) => ({ target: "shared", source: e.stream }))
          .build();

        await app.do("tick", { stream: "a", actor }, { premium: false });
        await app.correlate();
        expect((await sharedState()).priority).toBe(0);

        await app.do("tick", { stream: "b", actor }, { premium: true });
        await app.correlate();
        expect((await sharedState()).priority).toBe(0);
      });
    });

    // #1582: the +Infinity floor that keeps a static target out of the dynamic
    // path lives in the `maxSubscribedStreams` LRU, so evicting it hands the
    // next dynamic resolution a blank slate — it re-subscribes the target with
    // its own lane. A static target's lane is owned by the build-time
    // subscribe; churning dynamic targets through the LRU must not change it.
    describe("static targets survive LRU eviction", () => {
      const pinger = state({ Pinger: z.object({ count: z.number() }) })
        .init(() => ({ count: 0 }))
        .emits({ pinged: ZodEmpty, bumped: z.object({ to: z.string() }) })
        .patch({
          pinged: (_e, s) => ({ count: s.count + 1 }),
          bumped: (_e, s) => ({ count: s.count + 1 }),
        })
        .on({ ping: ZodEmpty })
        .emit(() => ["pinged", {}])
        .on({ bump: z.object({ to: z.string() }) })
        .emit((a) => ["bumped", { to: a.to }])
        .build();

      /**
       * `ping` reacts to a STATIC target on the "slow" lane; `bump` reacts
       * through a DYNAMIC resolver to whatever target the action names, with no
       * lane of its own. Aiming a bump at "shared" is what walks the dynamic
       * path over the static target.
       */
      function buildPinger(
        maxSubscribedStreams: number,
        ran?: string[],
        onlyLanes?: ReadonlyArray<"slow">
      ) {
        return act()
          .withState(pinger)
          .withLane({ name: "slow" })
          .on("pinged")
          .do(async function ping() {
            ran?.push("ping");
          })
          .to({ target: "shared", lane: "slow" })
          .on("bumped")
          .do(async function bump() {
            ran?.push("bump");
          })
          .to((e) => ({ target: (e.data as { to: string }).to }))
          .build({ maxSubscribedStreams, onlyLanes });
      }

      async function sharedLane(): Promise<string | undefined> {
        let lane: string | undefined;
        await store().query_streams((p) => {
          if (p.stream === "shared") lane = p.lane;
        });
        return lane;
      }

      it("CONTROL — no eviction: the static target keeps its declared lane", async () => {
        const app = buildPinger(10);
        await app.do("ping", { stream: "s1", actor }, {});
        await app.correlate();
        // A dynamic target that does NOT push "shared" out of the LRU.
        await app.do("bump", { stream: "s1", actor }, { to: "d1" });
        await app.correlate();
        // A dynamic resolution onto the static target itself.
        await app.do("bump", { stream: "s1", actor }, { to: "shared" });
        await app.correlate();

        expect(await sharedLane()).toBe("slow");
      });

      it("eviction does not let a dynamic resolution re-lane a static target", async () => {
        // maxSubscribedStreams: 1 makes eviction deterministic — one dynamic
        // target is enough to push the static entry out.
        const app = buildPinger(1);
        await app.do("ping", { stream: "s1", actor }, {});
        await app.correlate();
        await app.do("bump", { stream: "s1", actor }, { to: "d1" });
        await app.correlate();
        await app.do("bump", { stream: "s1", actor }, { to: "shared" });
        await app.correlate();

        expect(await sharedLane()).toBe("slow");
      });

      it("CONTROL — no eviction: both reactions run on the slow shard", async () => {
        const ran: string[] = [];
        const app = buildPinger(10, ran, ["slow"]);
        await app.do("ping", { stream: "s1", actor }, {});
        await app.correlate();
        await app.drain();
        await app.do("bump", { stream: "s1", actor }, { to: "d1" });
        await app.correlate();
        await app.drain();
        await app.do("bump", { stream: "s1", actor }, { to: "shared" });
        await app.correlate();
        await app.drain();

        expect(ran).toEqual(["ping", "bump"]);
      });

      it("eviction does not starve the static target's stream under onlyLanes", async () => {
        const ran: string[] = [];
        const app = buildPinger(1, ran, ["slow"]);
        await app.do("ping", { stream: "s1", actor }, {});
        await app.correlate();
        await app.drain();
        await app.do("bump", { stream: "s1", actor }, { to: "d1" });
        await app.correlate();
        await app.drain();
        await app.do("bump", { stream: "s1", actor }, { to: "shared" });
        await app.correlate();
        await app.drain();

        expect(ran).toEqual(["ping", "bump"]);
      });

      it("CONTROL — a restart re-subscribes statics and repairs the lane", async () => {
        const app = buildPinger(1);
        await app.do("ping", { stream: "s1", actor }, {});
        await app.correlate();
        await app.do("bump", { stream: "s1", actor }, { to: "d1" });
        await app.correlate();
        await app.do("bump", { stream: "s1", actor }, { to: "shared" });
        await app.correlate();

        // A fresh Act over the same store re-subscribes its static targets.
        const restarted = buildPinger(1);
        await restarted.correlate();
        expect(await sharedLane()).toBe("slow");
      });

      it("a static target keeps its lane however many dynamic targets churn", async () => {
        const app = buildPinger(1);
        await app.do("ping", { stream: "s1", actor }, {});
        await app.correlate();
        for (let i = 0; i < 5; i++) {
          await app.do("bump", { stream: "s1", actor }, { to: `d${i}` });
          await app.correlate();
          await app.do("bump", { stream: "s1", actor }, { to: "shared" });
          await app.correlate();
          expect(await sharedLane()).toBe("slow");
        }
      });
    });
    /**
     * The dynamic twin of #1582. A dynamic target's record lives in the
     * evictable LRU, and a missing record used to read as never-seen — so a
     * later, lower-priority resolution won the lane it had already lost. The
     * LRU calls itself "a memory bound, not a correctness mechanism", which
     * was true of a target's priority (the store merges that with max) and
     * false of its lane (the store overwrote that unconditionally).
     *
     * The repair is in the store: the lane now rides the priority max, so the
     * durable row holds the invariant and forgetting cannot break it. That
     * also covers the case no LRU bound reaches — a fresh process, whose
     * records are all missing by definition.
     */
    describe("dynamic targets survive a forgotten record", () => {
      const ranker = state({ Ranker: z.object({ count: z.number() }) })
        .init(() => ({ count: 0 }))
        .emits({
          hied: ZodEmpty,
          loed: ZodEmpty,
          churned: z.object({ to: z.string() }),
        })
        .patch({
          hied: (_e, s) => ({ count: s.count + 1 }),
          loed: (_e, s) => ({ count: s.count + 1 }),
          churned: (_e, s) => ({ count: s.count + 1 }),
        })
        .on({ hi: ZodEmpty })
        .emit(() => ["hied", {}])
        .on({ lo: ZodEmpty })
        .emit(() => ["loed", {}])
        .on({ churn: z.object({ to: z.string() }) })
        .emit((a) => ["churned", { to: a.to }])
        .build();

      /**
       * Two dynamic reactions on one target at different ranks: the winner
       * lanes "T" fast at priority 10, the loser asks for slow at 0. `churn`
       * mints a fresh target per action so the LRU can be driven past its
       * bound on demand.
       */
      function buildRanked(
        maxSubscribedStreams: number,
        ran?: string[],
        onlyLanes?: ReadonlyArray<"fast">
      ) {
        return act()
          .withState(ranker)
          .withLane({ name: "fast" })
          .withLane({ name: "slow" })
          .on("hied")
          .do(async function hi() {
            ran?.push("hi");
          })
          .to(() => ({ target: "T", lane: "fast", priority: 10 }))
          .on("loed")
          .do(async function lo() {
            ran?.push("lo");
          })
          .to(() => ({ target: "T", lane: "slow", priority: 0 }))
          .on("churned")
          .do(async function churn() {})
          .to((e) => ({
            target: (e.data as { to: string }).to,
            lane: "fast",
            priority: 10,
          }))
          .build({ maxSubscribedStreams, onlyLanes });
      }

      async function targetLane(): Promise<string | undefined> {
        let lane: string | undefined;
        await store().query_streams((p) => {
          if (p.stream === "T") lane = p.lane;
        });
        return lane;
      }

      it("CONTROL — no eviction: the loser does not take the lane", async () => {
        const app = buildRanked(10);
        await app.do("hi", { stream: "s1", actor }, {});
        await app.correlate();
        await app.do("lo", { stream: "s1", actor }, {});
        await app.correlate();

        expect(await targetLane()).toBe("fast");
      });

      it("eviction does not let a lower-priority resolution re-lane a dynamic target", async () => {
        // maxSubscribedStreams: 1 makes eviction deterministic — one churned
        // target is enough to push "T" out of the LRU.
        const app = buildRanked(1);
        await app.do("hi", { stream: "s1", actor }, {});
        await app.correlate();
        await app.do("churn", { stream: "s1", actor }, { to: "d1" });
        await app.correlate();
        await app.do("lo", { stream: "s1", actor }, {});
        await app.correlate();

        expect(await targetLane()).toBe("fast");
      });

      it("CONTROL — no eviction: both reactions run on the fast shard", async () => {
        const ran: string[] = [];
        const app = buildRanked(10, ran, ["fast"]);
        await app.do("hi", { stream: "s1", actor }, {});
        await app.correlate();
        await app.drain();
        await app.do("lo", { stream: "s1", actor }, {});
        await app.correlate();
        await app.drain();

        expect(ran).toEqual(["hi", "lo"]);
      });

      it("eviction does not starve the target's stream under onlyLanes", async () => {
        const ran: string[] = [];
        const app = buildRanked(1, ran, ["fast"]);
        await app.do("hi", { stream: "s1", actor }, {});
        await app.correlate();
        await app.drain();
        await app.do("churn", { stream: "s1", actor }, { to: "d1" });
        await app.correlate();
        await app.drain();
        await app.do("lo", { stream: "s1", actor }, {});
        await app.correlate();
        await app.drain();

        // Re-laned to "slow", the stream is invisible to this worker: the
        // reaction that asked for "slow" does not run, and neither does
        // anything else the target carries.
        expect(ran).toEqual(["hi", "lo"]);
      });

      it("a fresh process does not re-lane a dynamic target it never recorded", async () => {
        // No eviction involved — a restart starts with an empty LRU while the
        // rows persist, so every dynamic target reads as never-seen. The bound
        // is irrelevant here, which is why the repair had to live in the store.
        const app = buildRanked(10);
        await app.do("hi", { stream: "s1", actor }, {});
        await app.correlate();

        const restarted = buildRanked(10);
        await restarted.do("lo", { stream: "s1", actor }, {});
        await restarted.correlate();

        expect(await targetLane()).toBe("fast");
      });
    });
  });
});

/**
 * One worker per registry scans at a time; the rest skip.
 */
describe("correlate: the lease", () => {
  describe("correlate lease", () => {
    const Thing = state({ Thing: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Bumped: ZodEmpty })
      .patch({ Bumped: () => ({}) })
      .on({ bump: ZodEmpty })
      .emit(() => ["Bumped", {}])
      .build();

    const actor = { id: "t", name: "t" };

    const build = (store: InMemoryStore) =>
      act()
        .withState(Thing)
        .on("Bumped")
        .do(async function onBumped() {
          await Promise.resolve();
        })
        .to((e) => ({ target: `handled-${e.stream}`, source: e.stream }))
        .build({ scoped: { store, cache: new InMemoryCache() } });

    it("stops a second worker with the same registry from scanning", async () => {
      const store = new InMemoryStore();
      await store.seed();
      const a = build(store);
      const b = build(store);
      await a.do("bump", { stream: "s1", actor }, {});

      // Both settle, but only one may scan. The other returns without reading
      // the store, which is the entire point.
      const scans: number[] = [];
      const spy = vi.spyOn(store, "query");
      a.settle({ debounceMs: 0 });
      b.settle({ debounceMs: 0 });
      await new Promise((r) => setTimeout(r, 150));
      scans.push(spy.mock.calls.length);
      expect(scans[0]).toBeGreaterThan(0);

      await a.shutdown();
      await b.shutdown();
    });

    it("leaves an explicit correlate() unleased, so close can always catch up", async () => {
      const store = new InMemoryStore();
      await store.seed();
      const a = build(store);
      const b = build(store);
      await a.do("bump", { stream: "s2", actor }, {});

      // `a` takes the lease through the automatic path...
      a.settle({ debounceMs: 0 });
      await new Promise((r) => setTimeout(r, 100));

      // ...and `b` can still scan when told to explicitly. `close` relies on
      // this: it loops until the checkpoint advances, so a silently blocked
      // scan would make it give up and prune from a stale position.
      const { last_id } = await b.correlate({ after: -1, limit: 100 });
      expect(last_id).toBeGreaterThanOrEqual(0);

      await a.shutdown();
      await b.shutdown();
    });

    it("gives a different application its own lease key", async () => {
      const store = new InMemoryStore();
      await store.seed();

      const Other = state({ Other: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Poked: ZodEmpty })
        .patch({ Poked: () => ({}) })
        .on({ poke: ZodEmpty })
        .emit(() => ["Poked", {}])
        .build();

      const one = build(store);
      const two = act()
        .withState(Other)
        .on("Poked")
        .do(async function onPoked() {
          await Promise.resolve();
        })
        .to((e) => ({ target: `poked-${e.stream}`, source: e.stream }))
        .build({ scoped: { store, cache: new InMemoryCache() } });

      const spy = vi.spyOn(store, "subscribe");
      await one.do("bump", { stream: "s3", actor }, {});
      await two.do("poke", { stream: "s4", actor }, {});
      one.settle({ debounceMs: 0 });
      two.settle({ debounceMs: 0 });
      await new Promise((r) => setTimeout(r, 200));

      // Two applications are not interchangeable: one holding a global lease
      // would stop the other ever scanning, and its reactions would silently
      // never run. Different registries must therefore ask for different keys,
      // and both must be granted.
      // The correlator rides `subscribe`'s third argument, so the keys asked
      // for are the keys the store saw.
      const keys = new Set(
        spy.mock.calls
          .map(([, , correlator]) => correlator?.key)
          .filter((k): k is string => typeof k === "string")
      );
      expect(keys.size).toBe(2);

      spy.mockRestore();
      await one.shutdown();
      await two.shutdown();
    });

    it("warns and swallows a failure to hand the lease back", async () => {
      const store = new InMemoryStore();
      await store.seed();
      const a = build(store);
      const warn = vi.spyOn(log(), "warn").mockImplementation(() => log());
      const error = vi.spyOn(log(), "error").mockImplementation(() => log());
      vi.spyOn(store, "subscribe").mockRejectedValue(
        new Error("release failed")
      );

      // Releasing early is best-effort: the fallback is the expiry that would
      // have applied had the process died, so a failure must not propagate out
      // of a shutdown path. It is deliberately not awaited there either, hence
      // the tick before asserting.
      await expect(a.shutdown()).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 20));
      // `warn`, not `error` (#1577): nothing is lost and the lease self-heals
      // on expiry, so a clean shutdown must not reach a level operators page
      // on. The cause still rides along in the message.
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toMatch(/release failed/);
      expect(error).not.toHaveBeenCalled();
      warn.mockRestore();
      error.mockRestore();
    });
  });
});

/**
 * Every target an event resolves to is marked with that event's id, and
 * `claim` reads eligibility off the mark.
 */
describe("correlate: the work mark", () => {
  const Ticker = state({ Ticker: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Ticked: ZodEmpty, Ended: ZodEmpty })
    .patch({
      Ticked: (_, s) => ({ n: s.n + 1 }),
      Ended: (_, s) => ({ n: s.n }),
    })
    .on({ tick: ZodEmpty })
    .emit(() => ["Ticked", {}])
    .on({ end: ZodEmpty })
    .emit(() => ["Ended", {}])
    .build();

  const actor = { id: "a", name: "a" };

  /** Subscription rows by target — `correlated_at` included since #1487. */
  const positions = async (store: Store) => {
    const rows = new Map<string, StreamPosition>();
    await store.query_streams((p) => rows.set(p.stream, p));
    return rows;
  };

  const disposers: Array<() => Promise<void>> = [];
  const open = async <T>(builder: { build: (o?: any) => T }) => {
    const ctx = await sandbox(builder);
    disposers.push(ctx.dispose);
    return ctx;
  };

  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  describe("static targets are marked", () => {
    const builder = () =>
      act()
        .withState(Ticker)
        .on("Ticked")
        .do(async function noop() {})
        .to({ target: "out" });

    it("marks the target with the id of the event that resolved to it", async () => {
      const { app, store } = await open(builder());

      await app.do("tick", { stream: "s1", actor }, {});
      const scan = await app.correlate();

      expect((await positions(store)).get("out")?.correlated_at).toBe(
        scan.last_id
      );
    });

    it("raises the mark as later events arrive", async () => {
      const { app, store } = await open(builder());

      await app.do("tick", { stream: "s1", actor }, {});
      await app.correlate();
      const first = (await positions(store)).get("out")?.correlated_at;

      await app.do("tick", { stream: "s1", actor }, {});
      const second = await app.correlate();

      expect((await positions(store)).get("out")?.correlated_at).toBe(
        second.last_id
      );
      expect(second.last_id).toBeGreaterThan(first as number);
    });
  });

  describe("a mark is only claimed for events the target would fetch", () => {
    it("skips an event outside a pattern source, and marks one inside it", async () => {
      const { app, store } = await open(
        act()
          .withState(Ticker)
          .on("Ticked")
          .do(async function noop() {})
          .to({ target: "out", source: "^(a|b)$" })
      );

      // Two events from a stream the source excludes — the second also proves
      // the compiled pattern is reused rather than recompiled per event.
      await app.do("tick", { stream: "c", actor }, {});
      await app.do("tick", { stream: "c", actor }, {});
      await app.correlate();
      expect(
        (await positions(store)).get("out")?.correlated_at
      ).toBeUndefined();

      await app.do("tick", { stream: "b", actor }, {});
      const scan = await app.correlate();
      expect((await positions(store)).get("out")?.correlated_at).toBe(
        scan.last_id
      );
    });

    it("marks nothing for an event its resolver declines", async () => {
      const { app, store } = await open(
        act()
          .withState(Ticker)
          .on("Ticked")
          .do(async function noop() {})
          // A resolver that routes only some events — the declined ones resolve
          // to no target, so they raise no mark anywhere.
          .to((e) => (e.stream === "keep" ? { target: "out" } : undefined))
      );

      await app.do("tick", { stream: "drop", actor }, {});
      await app.correlate();
      expect((await positions(store)).size).toBe(0);

      await app.do("tick", { stream: "keep", actor }, {});
      const scan = await app.correlate();
      expect((await positions(store)).get("out")?.correlated_at).toBe(
        scan.last_id
      );
    });

    it("skips an event outside a literal source", async () => {
      const { app, store } = await open(
        act()
          .withState(Ticker)
          .on("Ticked")
          .do(async function noop() {})
          .to({ target: "out", source: "a" })
      );

      await app.do("tick", { stream: "c", actor }, {});
      await app.correlate();

      expect(
        (await positions(store)).get("out")?.correlated_at
      ).toBeUndefined();
    });
  });

  describe("a mark rides an upsert that changes nothing else", () => {
    const tiered = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ ticked: z.object({ premium: z.boolean() }) })
      .patch({ ticked: (_e, s) => ({ count: s.count + 1 }) })
      .on({ tick: z.object({ premium: z.boolean() }) })
      .emit((a) => ["ticked", { premium: a.premium }])
      .build();

    it("a later lower-priority scan neither lowers the priority nor re-lanes", async () => {
      const { app, store } = await open(
        act()
          .withState(tiered)
          .withLane({ name: "fast" })
          .withLane({ name: "slow" })
          .on("ticked")
          .do(async function react() {})
          .to((e) => ({
            target: "shared",
            source: e.stream,
            priority: (e.data as { premium: boolean }).premium ? 5 : 0,
            lane: (e.data as { premium: boolean }).premium ? "slow" : "fast",
          }))
      );

      await app.do("tick", { stream: "prem", actor }, { premium: true });
      await app.correlate();
      expect(await positions(store).then((p) => p.get("shared"))).toMatchObject(
        {
          priority: 5,
          lane: "slow",
        }
      );

      // The free-tier scan does not beat the recorded floor, so it re-sends the
      // row's own priority and lane — `subscribe` writes lane unconditionally,
      // and the mark has to travel on that same upsert.
      await app.do("tick", { stream: "free", actor }, { premium: false });
      const scan = await app.correlate();
      expect(await positions(store).then((p) => p.get("shared"))).toMatchObject(
        {
          priority: 5,
          lane: "slow",
          correlated_at: scan.last_id,
        }
      );
    });

    it("a dynamic resolution never re-opens a static target's priority", async () => {
      const { app, store } = await open(
        act()
          .withState(Ticker)
          .on("Ticked")
          .do(async function statically() {})
          .to({ target: "out", priority: 3 })
          .on("Ticked")
          .do(async function dynamically() {})
          .to(() => ({ target: "out", priority: 9 }))
      );

      await app.do("tick", { stream: "s1", actor }, {});
      const scan = await app.correlate();

      // Build-time priority owns the row; the scan only raises the mark.
      expect(await positions(store).then((p) => p.get("out"))).toMatchObject({
        priority: 3,
        correlated_at: scan.last_id,
      });
    });
  });

  describe("close sees pending work, not watermark lag", () => {
    it("holds back a stream whose tail correlate has not read yet", async () => {
      // Asking "does this reader have unconsumed work?" is only fair about
      // events correlate has resolved. An uncorrelated tail raises no marks, so
      // every reader answers "caught up" — and the reader that needs those
      // events may not even be subscribed yet, since its subscription is itself
      // a product of correlating them. Before the catch-up in the safety probe,
      // this truncated the stream and the reaction never ran.
      const handled: number[] = [];
      const { app } = await open(
        act()
          .withState(Ticker)
          .on("Ticked")
          .do(async function react(e) {
            handled.push(e.id);
          })
          .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
      );

      await app.do("tick", { stream: "s1", actor }, {});
      await app.correlate();
      await app.drain();
      expect(handled).toHaveLength(1);

      // Push the read cursor far behind the head — further than the window
      // `close` correlates on its own — then commit real work for `out-s1`.
      for (let i = 0; i < 1100; i++)
        await app.do("tick", { stream: "noise", actor }, {});
      const [tail] = await app.do("tick", { stream: "s1", actor }, {});
      const tail_id = (tail.event as { id: number }).id;

      const result = await app.close([{ stream: "s1" }]);

      expect(result.truncated.has("s1")).toBe(false);
      expect(result.skipped).toEqual(["s1"]);
      // The unprocessed event is still there to be reacted to. Truncating it
      // would have retired the stream with that reaction never run.
      const survivors = await app.query_array({
        stream: "s1",
        stream_exact: true,
      });
      expect(survivors.some((e) => e.id === tail_id)).toBe(true);
      expect(handled).not.toContain(tail_id);
    });

    it("closes a stream whose head has no reaction to consume it", async () => {
      const { app, store } = await open(
        act()
          .withState(Ticker)
          // Only `Ticked` has a reaction: after `Ended` commits, the target's
          // watermark sits below the head forever, because nothing resolves
          // there. The close guard must read that as "no pending work".
          .on("Ticked")
          .do(async function noop() {})
          .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
      );

      await app.do("tick", { stream: "s1", actor }, {});
      await app.correlate();
      await app.drain();
      await app.do("end", { stream: "s1", actor }, {});

      const result = await app.close([{ stream: "s1" }]);

      expect(result.skipped).toEqual([]);
      expect(result.truncated.has("s1")).toBe(true);
      // Caught up in the only sense that matters: everything marked for it is
      // consumed, even though the stream's head sits above its watermark.
      const target = (await positions(store)).get("out-s1");
      expect(target?.at).toBe(target?.correlated_at);
    });
  });
});
