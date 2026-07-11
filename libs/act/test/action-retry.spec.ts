import { z } from "zod";
import {
  act,
  ConcurrencyError,
  dispose,
  InMemoryStore,
  state,
  store,
} from "../src/index.js";
import type { EventMeta, Message, Schemas } from "../src/types/index.js";

/**
 * Subclass of `InMemoryStore` that injects {@link ConcurrencyError} on
 * the first `failTimes` calls to `commit`, then delegates. Lets us
 * exercise the orchestrator's per-action retry loop deterministically
 * without racing real concurrent writers.
 */
class FlakyStore extends InMemoryStore {
  attempts = 0;
  failTimes: number;

  constructor(failTimes: number) {
    super();
    this.failTimes = failTimes;
  }

  override async commit<E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ) {
    this.attempts++;
    if (this.attempts <= this.failTimes) {
      throw new ConcurrencyError(
        stream,
        -1,
        msgs as Message<Schemas, keyof Schemas>[],
        expectedVersion ?? -1
      );
    }
    return super.commit<E>(stream, msgs, meta, expectedVersion);
  }
}

const actor = { id: "a", name: "a" };
const target = { stream: "counter-1", actor } as const;

// Action with NO options — current single-attempt behavior.
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

// Action with retry budget but no backoff (immediate retry).
const RetryCounter = state({ RetryCounter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .on({ increment: z.object({ by: z.number() }) }, { maxRetries: 3 })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

// Action with retry + backoff (paced retry).
const PacedCounter = state({ PacedCounter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .on(
    { increment: z.object({ by: z.number() }) },
    { maxRetries: 3, backoff: { strategy: "fixed", baseMs: 80 } }
  )
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

// Action with retry + zero-delay backoff (delayMs short-circuit).
const ZeroBackoffCounter = state({
  ZeroBackoffCounter: z.object({ count: z.number() }),
})
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .on(
    { increment: z.object({ by: z.number() }) },
    { maxRetries: 2, backoff: { strategy: "fixed", baseMs: 0 } }
  )
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

// Action with explicit maxRetries: 0 — same effect as no options.
const ZeroRetryCounter = state({
  ZeroRetryCounter: z.object({ count: z.number() }),
})
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .on({ increment: z.object({ by: z.number() }) }, { maxRetries: 0 })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

describe("per-action retry policy", () => {
  afterEach(async () => {
    await dispose()();
  });

  describe("State.options registry", () => {
    it("undeclared action has no options entry", () => {
      expect(Counter.options).toBeUndefined();
    });

    it("declared action stores its options keyed by action name", () => {
      expect(RetryCounter.options).toEqual({ increment: { maxRetries: 3 } });
    });

    it("multiple options coexist on the same state via separate .on calls", () => {
      const Multi = state({ Multi: z.object({ count: z.number() }) })
        .init(() => ({ count: 0 }))
        .emits({
          A: z.object({}),
          B: z.object({}),
        })
        .on({ a: z.object({}) }, { maxRetries: 2 })
        .emit("A")
        .on({ b: z.object({}) })
        .emit("B")
        .build();
      expect(Multi.options).toEqual({ a: { maxRetries: 2 } });
    });
  });

  describe("no options (current behavior)", () => {
    it("ConcurrencyError surfaces on first conflict, no retry", async () => {
      const flaky = new FlakyStore(1);
      store(flaky);
      const app = act().withState(Counter).build();
      await expect(app.do("increment", target, { by: 1 })).rejects.toThrow(
        ConcurrencyError
      );
      expect(flaky.attempts).toBe(1);
    });

    it("explicit maxRetries: 0 behaves like undeclared", async () => {
      const flaky = new FlakyStore(1);
      store(flaky);
      const app = act().withState(ZeroRetryCounter).build();
      await expect(app.do("increment", target, { by: 1 })).rejects.toThrow(
        ConcurrencyError
      );
      expect(flaky.attempts).toBe(1);
    });
  });

  describe("retry policy", () => {
    it("succeeds on second attempt after one conflict", async () => {
      const flaky = new FlakyStore(1);
      store(flaky);
      const app = act().withState(RetryCounter).build();
      const snaps = await app.do("increment", target, { by: 1 });
      expect(flaky.attempts).toBe(2);
      expect(snaps[0].event?.name).toBe("Incremented");
    });

    it("succeeds on fourth attempt after three conflicts (budget fully consumed)", async () => {
      const flaky = new FlakyStore(3);
      store(flaky);
      const app = act().withState(RetryCounter).build();
      const snaps = await app.do("increment", target, { by: 2 });
      expect(flaky.attempts).toBe(4);
      expect(snaps[0].event?.name).toBe("Incremented");
    });

    it("throws the last ConcurrencyError when the budget is exhausted", async () => {
      const flaky = new FlakyStore(4); // 1 initial + 3 retries all fail
      store(flaky);
      const app = act().withState(RetryCounter).build();
      await expect(app.do("increment", target, { by: 1 })).rejects.toThrow(
        ConcurrencyError
      );
      expect(flaky.attempts).toBe(4); // budget = maxRetries(3) + 1 = 4 total attempts
    });

    it("non-ConcurrencyError bypasses the retry budget and propagates immediately", async () => {
      // Wrap the default store, overriding commit to throw a plain Error
      // on first call. Type-checks via the public Store interface — no
      // narrow override of a generic base method.
      const real = new InMemoryStore();
      let calls = 0;
      const boom: typeof real = Object.assign(
        Object.create(Object.getPrototypeOf(real)) as InMemoryStore,
        real,
        {
          async commit() {
            calls++;
            throw new Error("boom");
          },
        }
      );
      store(boom);
      const app = act().withState(RetryCounter).build();
      await expect(app.do("increment", target, { by: 1 })).rejects.toThrow(
        "boom"
      );
      expect(calls).toBe(1); // no retry path taken
    });
  });

  describe("caller-pinned expectedVersion (ACT-1208)", () => {
    it("rethrows immediately without consuming the retry budget or sleeping", async () => {
      // A caller-pinned expectedVersion is a fixed target: reloading and
      // re-committing against the same pinned version is guaranteed to
      // conflict again, so retrying only burns the budget and sleeps out
      // the backoff. The conflict must surface on the first attempt.
      const flaky = new FlakyStore(1);
      store(flaky);
      const app = act().withState(PacedCounter).build();
      const t0 = Date.now();
      await expect(
        app.do("increment", { ...target, expectedVersion: 5 }, { by: 1 })
      ).rejects.toThrow(ConcurrencyError);
      const elapsed = Date.now() - t0;
      expect(flaky.attempts).toBe(1); // no retry — budget untouched
      expect(elapsed).toBeLessThan(60); // no backoff sleep
    });

    it("still retries framework-derived versions (no caller expectedVersion)", async () => {
      // The retry loop stays live when the version was framework-derived:
      // a concurrent writer advanced the head, the reload picks up the new
      // frontier, and the next attempt succeeds.
      const flaky = new FlakyStore(1);
      store(flaky);
      const app = act().withState(RetryCounter).build();
      const snaps = await app.do("increment", target, { by: 1 });
      expect(flaky.attempts).toBe(2);
      expect(snaps[0].event?.name).toBe("Incremented");
    });
  });

  describe("backoff", () => {
    it("paces retries using compute_backoff_delay when backoff is declared", async () => {
      const flaky = new FlakyStore(1);
      store(flaky);
      const app = act().withState(PacedCounter).build();
      const t0 = Date.now();
      await app.do("increment", target, { by: 1 });
      const elapsed = Date.now() - t0;
      expect(flaky.attempts).toBe(2);
      // Fixed backoff of 80ms between attempt 0 (failed) and attempt 1.
      // Allow a generous lower bound to account for timer slop on slow CI.
      expect(elapsed).toBeGreaterThanOrEqual(60);
    });

    it("skips sleep when baseMs is zero (compute_backoff_delay returns 0)", async () => {
      const flaky = new FlakyStore(1);
      store(flaky);
      const app = act().withState(ZeroBackoffCounter).build();
      const t0 = Date.now();
      await app.do("increment", target, { by: 1 });
      const elapsed = Date.now() - t0;
      expect(flaky.attempts).toBe(2);
      expect(elapsed).toBeLessThan(50); // immediate retry, no sleep
    });

    it("retries immediately when backoff is omitted", async () => {
      const flaky = new FlakyStore(1);
      store(flaky);
      const app = act().withState(RetryCounter).build();
      const t0 = Date.now();
      await app.do("increment", target, { by: 1 });
      const elapsed = Date.now() - t0;
      expect(flaky.attempts).toBe(2);
      expect(elapsed).toBeLessThan(50);
    });
  });
});
