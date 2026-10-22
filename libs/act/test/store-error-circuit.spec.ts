import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, dispose, StoreError, state, store } from "../src/index.js";
import type { CircuitBreaker } from "../src/internal/circuit-breaker.js";

/**
 * StoreError + orchestrator circuit breaker. The drain loop turns
 * a degraded store into an `error` lifecycle event and trips a breaker so it
 * stops hammering a down backend, rather than silently returning "no work".
 */

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Bumped: z.object({}) })
  .patch({ Bumped: (_e, s) => s })
  .on({ bump: z.object({}) })
  .emit("Bumped")
  .build();

const actor = { id: "a", name: "a" };
let n = 0;
const nextStream = () => `cb-${++n}`;

describe("StoreError", () => {
  it("carries the operation, name, and cause", () => {
    const cause = new Error("connection reset");
    const err = new StoreError("claim", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ERR_STORE");
    expect(err.operation).toBe("claim");
    expect(err.cause).toBe(cause);
    expect(err.message).toContain("claim");
  });
});

describe("circuit breaker config validation", () => {
  it("throws at build() on an out-of-range failureThreshold", () => {
    expect(() =>
      act()
        .withState(Counter)
        .build({ circuitBreaker: { failureThreshold: 0 } })
    ).toThrow();
  });

  it("throws at build() on an out-of-range cooldownMs", () => {
    expect(() =>
      act()
        .withState(Counter)
        .build({ circuitBreaker: { cooldownMs: 1 } })
    ).toThrow();
  });
});

describe("drain circuit breaker", () => {
  const setup = async () => {
    const s = new InMemoryStore();
    store(s);
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function react() {})
      .build({
        autoSettle: false,
        circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
      });
    // Commit a reactive event (arms the drain controller) and subscribe the
    // reaction target so a drain would claim it.
    await app.do("bump", { stream: nextStream(), actor }, {});
    await app.correlate();
    return { s, app };
  };

  it("surfaces a store failure as an `error` event and stays resilient", async () => {
    const { s, app } = await setup();
    const claimSpy = vi.fn(() =>
      Promise.reject(new StoreError("claim", { cause: new Error("db down") }))
    );
    s.claim = claimSpy as never;

    const errors: { error: unknown; circuit: string }[] = [];
    app.on("error", (e) => errors.push(e));

    // Two failures reach the threshold (2) → breaker opens.
    await app.drain();
    await app.drain();
    // Third drain is skipped while the breaker is open — claim not called.
    await app.drain();

    expect(claimSpy).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);
    expect(errors[0].circuit).toBe("closed");
    expect(errors[1].circuit).toBe("open");
    expect(errors[1].error).toBeInstanceOf(StoreError);

    await dispose()();
  });

  it("does not throw when no `error` listener is registered (EventEmitter guard)", async () => {
    const { s, app } = await setup();
    s.claim = (() => Promise.reject(new StoreError("claim"))) as never;
    // No app.on("error", ...) — a naive emit("error") would crash the process.
    await expect(app.drain()).resolves.toBeDefined();
    await dispose()();
  });

  it("auto-recovers after the cooldown via the breaker's retry (no manual drain)", async () => {
    const s = new InMemoryStore();
    store(s);
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function react() {})
      .build({
        autoSettle: false,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 100 },
      });
    await app.do("bump", { stream: nextStream(), actor }, {});
    await app.correlate();

    const realClaim = s.claim.bind(s);
    let fail = true;
    const claimSpy = vi.fn((...args: unknown[]) =>
      fail
        ? Promise.reject(new StoreError("claim"))
        : (realClaim as (...a: unknown[]) => unknown)(...args)
    );
    s.claim = claimSpy as never;

    await app.drain(); // fails → threshold 1 → open, schedules the retry wake
    expect(claimSpy).toHaveBeenCalledTimes(1);
    fail = false; // store recovers before the wake fires

    // No manual drain: the breaker's own retry (wired to app.drain) fires
    // ~cooldownMs later, re-attempts claim, succeeds, and closes.
    await vi.waitFor(() =>
      expect(claimSpy.mock.calls.length).toBeGreaterThan(1)
    );

    await dispose()();
  });
});

/**
 * Correlate records its own store outcome on the shared breaker, like the
 * drain controllers: a scan that came back is a success, a throw is a
 * failure. A pass that never reached the store records nothing, so it can't
 * re-close an OPEN breaker mid-outage and let the drain hammer a store
 * nobody has heard from.
 */
describe("correlate circuit breaker", () => {
  const build = (failureThreshold: number) => {
    const s = new InMemoryStore();
    store(s);
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function react() {})
      .build({
        autoSettle: false,
        circuitBreaker: { failureThreshold, cooldownMs: 60_000 },
      });
    const breaker = (app as unknown as { _breaker: CircuitBreaker })._breaker;
    const real_query = s.query.bind(s);
    let failing = false;
    s.query = ((...args: unknown[]) =>
      failing
        ? Promise.reject(new StoreError("query"))
        : (real_query as (...a: unknown[]) => unknown)(...args)) as never;
    const open = () => {
      breaker.failed(Date.now(), new Error("store down"));
      expect(breaker.state(Date.now())).toBe("open");
    };
    const fail = (on: boolean) => {
      failing = on;
    };
    return { app, breaker, open, fail };
  };

  afterEach(async () => {
    await dispose()();
  });

  it("records a failing correlate on the breaker, which surfaces the error", async () => {
    const { app, fail } = build(5);
    const errors: { error: unknown; circuit: string }[] = [];
    app.on("error", (e) => errors.push(e));
    await app.do("bump", { stream: nextStream(), actor }, {});
    fail(true);
    await expect(app.correlate()).rejects.toBeInstanceOf(StoreError);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBeInstanceOf(StoreError);
    expect(errors[0].circuit).toBe("closed"); // 1 failure < threshold 5
  });

  it("closes the breaker when the scan returns (control)", async () => {
    const { app, breaker, open } = build(1);
    await app.do("bump", { stream: nextStream(), actor }, {});
    open();
    await app.correlate();
    expect(breaker.state(Date.now())).toBe("closed");
  });

  it("leaves the breaker OPEN when correlate was disarmed and read nothing", async () => {
    const { app, breaker, open } = build(1);
    await app.do("bump", { stream: nextStream(), actor }, {});
    // Correlate stays armed after the first pass, which marked work; the
    // second reads nothing and disarms it.
    await app.correlate();
    await app.correlate();
    open();
    await app.correlate();
    expect(breaker.state(Date.now())).toBe("open");
  });

  it("leaves the breaker OPEN when the correlation lease is refused", async () => {
    const { app, breaker, open } = build(1);
    const s = store();
    const real_subscribe = s.subscribe.bind(s);
    s.subscribe = (async (...args: Parameters<typeof real_subscribe>) => {
      const result = await real_subscribe(...args);
      // Another worker holds the lease: "may I scan?" is refused.
      return args[2] ? { ...result, correlating: false } : result;
    }) as typeof real_subscribe;
    await app.do("bump", { stream: nextStream(), actor }, {});
    open();
    await (
      app as unknown as {
        _correlate_pass: (q: object, o: object) => Promise<unknown>;
      }
    )._correlate_pass({ limit: 10 }, { lease: true });
    expect(breaker.state(Date.now())).toBe("open");
  });

  it("a failed catch-up inside app.close() rejects and records nothing", async () => {
    const { app, breaker, fail } = build(5);
    const errors: unknown[] = [];
    app.on("error", (e) => errors.push(e));
    const stream = nextStream();
    // Uncorrelated, so the close has to catch correlation up first.
    await app.do("bump", { stream, actor }, {});
    fail(true);
    await expect(app.close([{ stream }])).rejects.toBeInstanceOf(StoreError);
    expect(errors).toHaveLength(0);
    expect((breaker as unknown as { _failures: number })._failures).toBe(0);
  });

  it("leaves the breaker OPEN when the scan fails against a down store", async () => {
    const { app, breaker, open, fail } = build(1);
    app.on("error", () => {});
    await app.do("bump", { stream: nextStream(), actor }, {});
    open();
    fail(true);
    await expect(app.correlate()).rejects.toBeInstanceOf(StoreError);
    expect(breaker.state(Date.now())).toBe("open");
  });
});

describe("a failed settle retries on an idle app", () => {
  // One failed read during settle's correlate leaves the breaker closed
  // (threshold 5). Nothing else would settle an idle app, so the breaker's
  // retry has to follow every failure, not only the one that opens it.
  const run = async (fail: boolean) => {
    const s = new InMemoryStore();
    store(s);
    let ran = 0;
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function react() {
        ran++;
      })
      .build({ autoSettle: false, circuitBreaker: { cooldownMs: 100 } });
    await app.do("bump", { stream: nextStream(), actor }, {});
    const real_query = s.query.bind(s);
    let failing = fail;
    s.query = ((...args: unknown[]) => {
      if (failing) {
        failing = false;
        return Promise.reject(new StoreError("query"));
      }
      return (real_query as (...a: unknown[]) => unknown)(...args);
    }) as never;
    try {
      app.settle({ debounceMs: 0 });
      await vi.waitFor(() => expect(ran).toBe(1), { timeout: 1000 });
    } finally {
      await dispose()();
    }
  };

  it("re-drives settle cooldownMs after a store failure, before the breaker opens", () =>
    run(true));

  it("control — runs the reaction when settle's read doesn't fail", () =>
    run(false));
});

describe("breaker scope: a whole-store outage detector", () => {
  // Correlate's scan is the only store read with `with_pii: false`; failing
  // it alone leaves `claim`, `ack` and commits healthy.
  const partly_broken = () => {
    const s = new InMemoryStore();
    const real_query = s.query.bind(s);
    s.query = ((callback: never, query?: { with_pii?: boolean }) =>
      query?.with_pii === false
        ? Promise.reject(new StoreError("query"))
        : real_query(callback, query as never)) as never;
    store(s);
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function react() {})
      .build({
        autoSettle: false,
        circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
      });
    const errors: { error: unknown; circuit: string }[] = [];
    app.on("error", (e) => errors.push(e));
    return { app, errors };
  };

  const fail_correlate_once = async (
    app: ReturnType<typeof partly_broken>["app"],
    errors: unknown[]
  ) => {
    const before = errors.length;
    await app.do("bump", { stream: nextStream(), actor }, {});
    app.settle({ debounceMs: 0 });
    await vi.waitFor(() => expect(errors.length).toBe(before + 1));
  };

  it("stays closed while another loop's store calls keep succeeding", async () => {
    const { app, errors } = partly_broken();
    for (let i = 0; i < 6; i++) {
      await fail_correlate_once(app, errors);
      // A drain whose claim succeeds resets the shared failure count.
      await app.drain();
    }
    expect(errors).toHaveLength(6);
    expect(errors.every((e) => e.error instanceof StoreError)).toBe(true);
    expect(errors.every((e) => e.circuit === "closed")).toBe(true);
    await dispose()();
  });

  it("control — opens when nothing else touches the store", async () => {
    const { app, errors } = partly_broken();
    for (let i = 0; i < 3; i++) await fail_correlate_once(app, errors);
    expect(errors.map((e) => e.circuit)).toEqual(["closed", "closed", "open"]);
    await dispose()();
  });
});
