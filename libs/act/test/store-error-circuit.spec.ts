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

describe("drain circuit breaker (ACT-984)", () => {
  const setup = async () => {
    const s = new InMemoryStore();
    store(s);
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function react() {})
      .build({ circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 } });
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

  it("recovers: skips while open, then re-attempts after the cooldown", async () => {
    const s = new InMemoryStore();
    store(s);
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function react() {})
      .build({ circuitBreaker: { failureThreshold: 1, cooldownMs: 100 } });
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

    await app.drain(); // fails → threshold 1 → open
    expect(claimSpy).toHaveBeenCalledTimes(1);
    await app.drain(); // open → skipped, claim NOT called
    expect(claimSpy).toHaveBeenCalledTimes(1);

    // After the cooldown the breaker half-opens and a trial is allowed.
    await new Promise((r) => setTimeout(r, 130));
    fail = false; // store recovered
    await app.drain(); // half-open trial → claim attempted, succeeds → closed
    expect(claimSpy).toHaveBeenCalledTimes(2);

    await dispose()();
  });
});

describe("settle loop store-error handling (ACT-984)", () => {
  it("records a failing correlate on the breaker and surfaces via on_error", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownMs: 1000,
    });
    const errored = new Promise<{ error: unknown; circuit: string }>(
      (resolve) => {
        const loop = new SettleLoop(
          {
            logger: { error: () => {} } as never,
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
            on_error: (error, circuit) => resolve({ error, circuit }),
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
