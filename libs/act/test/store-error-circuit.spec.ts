import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, dispose, StoreError, state, store } from "../src/index.js";
import { CircuitBreaker } from "../src/internal/circuit-breaker.js";
import { SettleLoop } from "../src/internal/settle.js";

/**
 * ACT-984: StoreError + orchestrator circuit breaker. The drain loop turns
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
        .build({ autoSettle: false, circuitBreaker: { failureThreshold: 0 } })
    ).toThrow();
  });

  it("throws at build() on an out-of-range cooldownMs", () => {
    expect(() =>
      act()
        .withState(Counter)
        .build({ autoSettle: false, circuitBreaker: { cooldownMs: 1 } })
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
    await new Promise((r) => setTimeout(r, 250));
    expect(claimSpy.mock.calls.length).toBeGreaterThan(1);

    await dispose()();
  });
});

describe("settle loop store-error handling", () => {
  it("records a failing correlate on the breaker, which surfaces the error", async () => {
    const errored = new Promise<{ error: unknown; circuit: string }>(
      (resolve) => {
        // The breaker owns the error callback now; the settle loop just
        // calls failed(now, err) on a failed correlate.
        const breaker = new CircuitBreaker(
          { failureThreshold: 5, cooldownMs: 1000 },
          { on_error: (error, circuit) => resolve({ error, circuit }) }
        );
        const loop = new SettleLoop(
          {
            init: async () => {},
            checkpoint: () => -1,
            correlate: () => Promise.reject(new StoreError("subscribe")),
            drain: async () => ({
              fetched: [],
              leased: [],
              acked: [],
              blocked: [],
            }),
            on_settled: () => {},
            breaker,
          },
          0
        );
        loop.schedule({ debounceMs: 0 });
      }
    );
    const e = await errored;
    expect(e.error).toBeInstanceOf(StoreError);
    expect(e.circuit).toBe("closed"); // 1 failure < threshold 5
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
