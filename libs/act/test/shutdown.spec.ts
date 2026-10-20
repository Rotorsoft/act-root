/**
 * `shutdown()` stops scheduling, then waits for whatever is already in
 * flight (drain cycles and a settle cycle) up to a grace budget, and hands
 * the correlation lease back last. A handler or settle left running past
 * teardown keeps its stream leased and lands its store calls on a disposed
 * store.
 */
import {
  act,
  DeferSignal,
  dispose,
  InMemoryStore,
  state,
  store,
} from "@rotorsoft/act";
import type {
  Store,
  StoreNotification,
  StreamPosition,
} from "@rotorsoft/act/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const ZodEmpty = z.object({});

const Ticker = state({ Ticker: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Ticked: ZodEmpty })
  .patch({ Ticked: (_, s) => ({ count: s.count + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Ticked", {}])
  .build();

const actor = { id: "a", name: "a" };

/** A promise a handler parks on until the test releases it. */
const gate = () => {
  let release!: () => void;
  let entered = false;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return {
    release,
    get entered() {
      return entered;
    },
    wait: async () => {
      entered = true;
      await promise;
    },
  };
};

/** An Act whose only reaction parks on `g`, on the default lane. */
const parked_app = (g: ReturnType<typeof gate>) =>
  act()
    .withState(Ticker)
    .on("Ticked")
    .do(async function parkedHandler() {
      await g.wait();
    })
    .to({ target: "out" })
    .build({ autoSettle: false });

/** Same, but the reaction runs on a lane with its own lease budget. */
const laned_parked_app = (g: ReturnType<typeof gate>, leaseMillis: number) =>
  act()
    .withState(Ticker)
    .withLane({ name: "slow", leaseMillis })
    .on("Ticked")
    .do(async function parkedHandler() {
      await g.wait();
    })
    .to({ target: "out", lane: "slow" })
    .build({ autoSettle: false });

/** A dynamic resolver is what makes correlate actually scan the log. */
const scanning_app = () =>
  act()
    .withState(Ticker)
    .on("Ticked")
    .do(async function noop() {})
    .to((e) => ({ target: `dyn-${e.stream}` }))
    .build({ autoSettle: false });

/** Spin until `check` holds or the deadline passes. */
const until = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise<void>((r) => setTimeout(r, 5));
};

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const positions = async () => {
  const seen: StreamPosition[] = [];
  await store().query_streams((s) => seen.push(s), {});
  return seen;
};

/**
 * A store that parks the first call to `park_on` once `flags.parking` is
 * set, records every call made after `flags.shut`, and records the
 * correlation lease each `subscribe` asks for.
 */
const harness = (park_on: string) => {
  const raw = new InMemoryStore();
  const after_shutdown: string[] = [];
  const correlator_millis: number[] = [];
  const flags = { shut: false, parking: false, entered: false };
  let release!: () => void;
  const parked = new Promise<void>((r) => {
    release = r;
  });
  const wrapped = new Proxy(raw, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        const name = String(p);
        if (flags.shut) after_shutdown.push(name);
        if (name === "subscribe") {
          const correlator = args[2] as { millis: number } | undefined;
          if (correlator) correlator_millis.push(correlator.millis);
        }
        if (flags.parking && name === park_on && !flags.entered) {
          flags.entered = true;
          await parked;
        }
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  }) as unknown as Store;
  return {
    wrapped,
    after_shutdown,
    correlator_millis,
    flags,
    release: () => release(),
  };
};

/** Start a settle and park it inside correlate's read of the log. */
const parked_settle = async () => {
  const h = harness("query");
  store(h.wrapped);
  const app = scanning_app();
  await app.do("tick", { stream: "src", actor }, {});
  h.flags.parking = true;
  app.settle({ debounceMs: 0 });
  await until(() => h.flags.entered);
  return { h, app };
};

/** Start a drain whose handler parks on `g`. */
const parked_drain = async (
  g: ReturnType<typeof gate>,
  app: ReturnType<typeof parked_app>
) => {
  await app.do("tick", { stream: "src", actor }, {});
  await app.correlate();
  // Wrapped: an async function would flatten the promise and wait for it.
  const draining = app.drain({ leaseMillis: 5_000 });
  await until(() => g.entered);
  return { draining };
};

afterEach(async () => {
  await dispose()("EXIT").catch(() => {});
  vi.useRealTimers();
});

// Each `await app.shutdown(...)` below runs while the gate is still closed,
// so a shutdown that waited for the parked work would hang to the test
// timeout instead of resolving.
describe("shutdown grace budget", () => {
  it("awaits an in-flight cycle so the handler finishes and the lease is released", async () => {
    const g = gate();
    const app = parked_app(g);
    const { draining } = await parked_drain(g, app);

    let settled = false;
    const shutting = app.shutdown({ graceMs: 5_000 }).then(() => {
      settled = true;
    });
    await pause(50);
    expect(settled).toBe(false);

    g.release();
    await shutting;
    await draining;

    // The handler reached its ack, so nothing is left leased for the
    // replacement worker to wait out.
    const [out] = (await positions()).filter((s) => s.stream === "out");
    expect(out.leased_by).toBeFalsy();
    expect(out.at).toBeGreaterThanOrEqual(0);
  });

  it("still observes acked listeners for work that completes during the window", async () => {
    const g = gate();
    const app = parked_app(g);
    const acked = vi.fn();
    app.on("acked", acked);
    const { draining } = await parked_drain(g, app);
    const shutting = app.shutdown({ graceMs: 5_000 });
    g.release();
    await shutting;
    await draining;
    expect(acked).toHaveBeenCalled();
  });

  it("graceMs: 0 keeps the old behavior — returns without waiting", async () => {
    const g = gate();
    const app = parked_app(g);
    const { draining } = await parked_drain(g, app);
    await app.shutdown({ graceMs: 0 });
    g.release();
    await draining;
  });

  it("proceeds when the budget is exhausted — one stuck handler cannot hang teardown", async () => {
    const g = gate();
    const app = parked_app(g);
    const { draining } = await parked_drain(g, app);
    await app.shutdown({ graceMs: 30 });
    g.release();
    await draining;
  });

  it("is idempotent — the first call's budget applies", async () => {
    const app = parked_app(gate());
    const first = app.shutdown({ graceMs: 0 });
    expect(app.shutdown({ graceMs: 5_000 })).toBe(first);
    await first;
  });

  it("returns immediately when nothing is in flight", async () => {
    const app = parked_app(gate());
    await app.shutdown();
  });

  it("rejects a nonsensical graceMs at the call, not on the next tick", async () => {
    const app = parked_app(gate());
    expect(() => app.shutdown({ graceMs: -1 })).toThrow();
    expect(() => app.shutdown({ graceMs: Number.NaN })).toThrow();
    await app.shutdown({ graceMs: 0 });
  });
});

describe("default grace budget derivation", () => {
  /** Park a cycle, then measure the budget by advancing fake time. */
  const budget_of = async (lane?: number) => {
    const g = gate();
    const app = lane === undefined ? parked_app(g) : laned_parked_app(g, lane);
    await app.do("tick", { stream: "src", actor }, {});
    await app.correlate();
    const draining = app.drain({ leaseMillis: 60_000 });
    await until(() => g.entered);

    vi.useFakeTimers();
    let settled = false;
    const shutting = app.shutdown().then(() => {
      settled = true;
    });
    return {
      /** True once teardown gave up waiting at `ms`. */
      settles_at: async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms - 1);
        const before = settled;
        await vi.advanceTimersByTimeAsync(2);
        const after = settled;
        vi.useRealTimers();
        g.release();
        await shutting;
        await draining;
        return { before, after };
      },
    };
  };

  it("defaults to drain's own 10s lease fallback when no lane pinned one", async () => {
    const { settles_at } = await budget_of();
    expect(await settles_at(10_000)).toEqual({ before: false, after: true });
  });

  it("uses the lane's configured leaseMillis", async () => {
    const { settles_at } = await budget_of(3_000);
    expect(await settles_at(3_000)).toEqual({ before: false, after: true });
  });

  it("caps a long lane lease at 30s so one handler cannot hold a deploy open", async () => {
    const { settles_at } = await budget_of(120_000);
    expect(await settles_at(30_000)).toEqual({ before: false, after: true });
  });

  it("does not abandon a parked handler on a zero-lease lane", async () => {
    const g = gate();
    const app = laned_parked_app(g, 0);
    await app.do("tick", { stream: "src", actor }, {});
    await app.correlate();
    const draining = app.drain({ leaseMillis: 60_000 });
    await until(() => g.entered);

    let settled = false;
    const shutting = app.shutdown().then(() => {
      settled = true;
    });
    await pause(50);
    expect(settled).toBe(false);

    g.release();
    await shutting;
    await draining;
    expect(settled).toBe(true);
  });

  it("treats a lane's leaseMillis: 0 as no pinned lease, not a zero budget", async () => {
    // A lease that expires the instant it is granted says nothing about how
    // long a handler may hold the stream, so it takes the same fallback a
    // lane that pinned no lease at all takes.
    const { settles_at } = await budget_of(0);
    expect(await settles_at(10_000)).toEqual({ before: false, after: true });
  });
});

describe("shutdown waits for an in-flight settle cycle", () => {
  it("issues no store operations after teardown resolves", async () => {
    const { h, app } = await parked_settle();
    const shutting = app.shutdown({ graceMs: 5_000 }).then(() => {
      // Anything the settle does from here on is post-teardown.
      h.flags.shut = true;
    });
    await pause(50);
    h.release();
    await shutting;

    // Give any escaped continuation a chance to run before asserting.
    await pause(50);
    expect(h.after_shutdown).toEqual([]);
  });

  it("does not return while a settle is parked mid-correlate", async () => {
    const { h, app } = await parked_settle();
    let settled = false;
    const shutting = app.shutdown({ graceMs: 5_000 }).then(() => {
      settled = true;
    });
    await pause(50);
    expect(settled).toBe(false);

    h.release();
    await shutting;
    expect(settled).toBe(true);
  });

  it("proceeds when the grace budget expires on a stuck settle", async () => {
    const { h, app } = await parked_settle();
    await app.shutdown({ graceMs: 40 });
    h.release();
  });

  it("graceMs: 0 returns immediately", async () => {
    const { h, app } = await parked_settle();
    await app.shutdown({ graceMs: 0 });
    h.release();
  });

  it("returns promptly when nothing is settling", async () => {
    store(new InMemoryStore());
    await scanning_app().shutdown();
  });

  it("the DEFAULT budget waits for a settle that is the only thing in flight", async () => {
    const { h, app } = await parked_settle();
    let returned = false;
    // No graceMs: the derived path, with no drain controller in flight, so
    // the budget comes from the settle alone.
    const shutting = app.shutdown().then(() => {
      returned = true;
    });
    await pause(50);
    expect(returned).toBe(false);

    h.release();
    await shutting;
    expect(returned).toBe(true);
  });

  it("hands the correlation lease back last, so nothing re-takes it", async () => {
    const { h, app } = await parked_settle();
    const shutting = app.shutdown({ graceMs: 5_000 });
    await pause(50);
    h.release();
    await shutting;
    await pause(50);

    // `millis: 0` is the handback; anything positive is an acquisition.
    // The release has to be the last word, or the lease outlives teardown.
    expect(h.correlator_millis.at(-1)).toBe(0);
  });
});

describe("a notification during shutdown cannot arm a new cycle", () => {
  /** An in-memory store with a `notify` capability the test fires by hand. */
  const notifiable = (after_shutdown: string[], flags: { shut: boolean }) => {
    const raw = new InMemoryStore();
    let handler: ((n: StoreNotification) => void) | undefined;
    const wrapped = new Proxy(raw, {
      get(t, p, r) {
        if (p === "notify")
          return (h: (n: StoreNotification) => void) => {
            handler = h;
            return () => {
              handler = undefined;
            };
          };
        const v = Reflect.get(t, p, r);
        if (typeof v !== "function" || typeof p !== "string") return v;
        return (...args: unknown[]) => {
          if (flags.shut) after_shutdown.push(p);
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    }) as unknown as Store;
    return { wrapped, fire: (n: StoreNotification) => handler?.(n) };
  };

  const scenario = async (fire_during_grace: boolean) => {
    const after_shutdown: string[] = [];
    const flags = { shut: false };
    const n = notifiable(after_shutdown, flags);
    store(n.wrapped);

    let release!: () => void;
    const parked = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const app = act()
      .withState(Ticker)
      .on("Ticked")
      .do(async function hold() {
        if (first) {
          first = false;
          await parked;
        }
      })
      .to(() => ({ target: "t" }))
      .build({ autoSettle: false });

    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();
    const draining = app.drain();
    await pause(20);

    // Shutdown is now waiting out its grace budget on the parked handler.
    const shutting = app.shutdown({ graceMs: 5_000 });
    await pause(20);
    if (fire_during_grace)
      n.fire({ stream: "s2", events: [{ id: 99, name: "Ticked" }] });
    release();
    await draining;
    await shutting;

    flags.shut = true;
    // Give any cycle the notification armed a chance to run.
    await pause(150);
    const escaped = [...after_shutdown];
    await dispose()();
    return escaped;
  };

  it("takes no lease after shutdown resolves, notified or not", async () => {
    // The control fixes everything except the notification, so a difference
    // between the two is the notification's doing and nothing else.
    expect(await scenario(false)).toEqual([]);
    expect(await scenario(true)).toEqual([]);
  }, 20_000);
});

describe("the defer wake stops draining at shutdown", () => {
  // Three streams come due together on a lane that claims one per pass, so
  // the wake needs three passes. Shutdown waits for the pass in flight; the
  // wake must not start another after it.
  const scenario = async (streamLimit: number) => {
    store(new InMemoryStore());
    const due = new Date(Date.now() + 100);
    const after_shutdown: string[] = [];
    let down = false;
    const app = act()
      .withState(Ticker)
      .withLane({ name: "one", streamLimit })
      .on("Ticked")
      .do(async function remind(event) {
        if (Date.now() < due.getTime()) throw new DeferSignal({ at: due });
        await pause(60);
        if (down) after_shutdown.push(event.stream);
      })
      .to((event) => ({ target: `r-${event.stream}`, lane: "one" }))
      .build({ autoSettle: false });
    for (const s of ["x1", "x2", "x3"])
      await app.do("tick", { stream: s, actor }, {});
    await app.correlate();
    await app.drain({ streamLimit: 10 });
    await pause(130); // the wake fired and its first pass is running
    await app.shutdown();
    down = true;
    await pause(250);
    return after_shutdown;
  };

  it("runs no handler after shutdown resolves", async () => {
    expect(await scenario(1)).toEqual([]);
  });

  it("control — a wake that needs one pass also runs none", async () => {
    expect(await scenario(10)).toEqual([]);
  });
});

describe("the settle loop stops at shutdown", () => {
  // Three streams on a settle that claims one per pass, so it needs three
  // passes. Shutdown waits for the pass in flight, up to its budget; when
  // the budget runs out the loop must not start another pass.
  const scenario = async (streamLimit: number) => {
    store(new InMemoryStore());
    const after_shutdown: string[] = [];
    let down = false;
    const app = act()
      .withState(Ticker)
      .on("Ticked")
      .do(async function slow(event) {
        await pause(60);
        if (down) after_shutdown.push(event.stream);
      })
      .to((event) => ({ target: `r-${event.stream}` }))
      .build({ autoSettle: false });
    for (const s of ["x1", "x2", "x3"])
      await app.do("tick", { stream: s, actor }, {});
    app.settle({ streamLimit, debounceMs: 0 });
    await pause(30); // the first pass is running
    // A budget the first pass fits in but the whole loop doesn't.
    await app.shutdown({ graceMs: 100 });
    down = true;
    await pause(250);
    return after_shutdown;
  };

  it("starts no settle pass after shutdown resolves", async () => {
    expect(await scenario(1)).toEqual([]);
  });

  it("control — a settle that needs one pass also runs none", async () => {
    expect(await scenario(10)).toEqual([]);
  });
});

describe("shutdown stops the work already in flight", () => {
  // A settle pass whose correlate scan is still running when the grace
  // budget runs out: the pass must not drain or re-take the lease after.
  const slow_scan = async (graceMs: number) => {
    const raw = new InMemoryStore();
    const query = raw.query.bind(raw);
    const subscribe = raw.subscribe.bind(raw);
    let slow = false;
    let down = false;
    const leased_after: number[] = [];
    raw.query = (async (...args: Parameters<typeof raw.query>) => {
      if (slow) await pause(150);
      return query(...args);
    }) as typeof raw.query;
    raw.subscribe = (async (...args: Parameters<typeof raw.subscribe>) => {
      const millis = args[2]?.millis;
      if (down && millis) leased_after.push(millis);
      return subscribe(...args);
    }) as typeof raw.subscribe;
    store(raw);
    const ran_after: string[] = [];
    const app = act()
      .withState(Ticker)
      .on("Ticked")
      .do(async function handle(event) {
        if (down) ran_after.push(event.stream);
      })
      .to((event) => ({ target: `t-${event.stream}` }))
      .build();
    await pause(30); // the cold-start settle is done
    slow = true;
    await app.do("tick", { stream: "x1", actor }, {});
    await pause(30); // the scheduled pass is in its slow scan
    await app.shutdown({ graceMs });
    down = true;
    await pause(400);
    return { ran_after, leased_after };
  };

  it("a pass still scanning when the grace runs out starts nothing after shutdown", async () => {
    expect(await slow_scan(30)).toEqual({ ran_after: [], leased_after: [] });
  });

  it("control — a grace the scan fits in also starts nothing after", async () => {
    expect(await slow_scan(400)).toEqual({ ran_after: [], leased_after: [] });
  });

  // A pass `do()` scheduled right before `shutdown()`, while the notify
  // subscription takes its time to come down.
  const slow_disposal = async (dispose_ms: number) => {
    const raw = new InMemoryStore();
    const wrapped = new Proxy(raw, {
      get(t, p, r) {
        if (p === "notify")
          return () =>
            Promise.resolve(async () => {
              await pause(dispose_ms);
            });
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as unknown as Store;
    store(wrapped);
    const ran: string[] = [];
    const app = act()
      .withState(Ticker)
      .on("Ticked")
      .do(async function handle(event) {
        ran.push(event.stream);
      })
      .to((event) => ({ target: `t-${event.stream}` }))
      .build();
    await pause(30);
    await app.do("tick", { stream: "x1", actor }, {});
    await app.shutdown();
    await pause(200);
    return ran;
  };

  it("a slow notify disposal can't let a scheduled pass run", async () => {
    expect(await slow_disposal(60)).toEqual([]);
  });

  it("control — an instant disposal cancels it too", async () => {
    expect(await slow_disposal(0)).toEqual([]);
  });
});
