import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, dispose, log, state, store } from "../src/index.js";
import { AppCodeError } from "../src/internal/app-code-error.js";
import { CloseSignal } from "../src/internal/close-signal.js";

/**
 * App code failing inside a framework loop (a resolver, a close's archive
 * callback) is not the store failing. It never counts on the store circuit
 * breaker and never emits `error`; it stops only what it breaks, and its
 * logs stay bounded.
 */

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Bumped: z.object({}) })
  .patch({ Bumped: (_e, s) => s })
  .on({ bump: z.object({}) })
  .emit("Bumped")
  .build();

const actor = { id: "a", name: "a" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  vi.restoreAllMocks();
  await dispose()();
});

describe("a resolver that throws during correlate", () => {
  it("pauses discovery, stays off the store breaker, and resumes without losing the event", async () => {
    store(new InMemoryStore());
    let broken = true;
    let calls = 0;
    const handled: string[] = [];
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function react(_e, stream) {
        handled.push(stream);
      })
      .to((event) => {
        calls++;
        if (broken) throw new Error("resolver bug");
        return { target: `t-${event.stream}` };
      })
      .build({ circuitBreaker: { failureThreshold: 1, cooldownMs: 100 } });
    const errors: unknown[] = [];
    app.on("error", (e) => errors.push(e));
    const logged = vi.spyOn(log(), "error");

    await app.do("bump", { stream: "s1", actor }, {});
    app.settle({ debounceMs: 0 });
    await vi.waitFor(() =>
      expect(logged).toHaveBeenCalledWith(
        expect.any(AppCodeError),
        expect.stringContaining("Correlation paused")
      )
    );
    const first = logged.mock.calls[0][0] as unknown as AppCodeError;
    expect(first.message).toContain('Resolver of reaction "react" threw');
    expect(first.message).toContain("resolver bug");

    // While paused, more commits don't run the resolver again.
    const paused_at = calls;
    for (const stream of ["s2", "s3"]) {
      await app.do("bump", { stream, actor }, {});
      app.settle({ debounceMs: 0 });
    }
    await sleep(30);
    expect(calls).toBe(paused_at);

    // Fixed: the pause's own retry resumes at the failing event.
    broken = false;
    await vi.waitFor(
      () => expect(handled.sort()).toEqual(["t-s1", "t-s2", "t-s3"]),
      { timeout: 2000 }
    );
    // A threshold-1 store breaker would have opened on the first failure.
    expect(errors).toHaveLength(0);
  });
});

describe("a resolver that throws during drain", () => {
  it("fails only its own stream, which blocks on the reaction's budget", async () => {
    store(new InMemoryStore());
    let fail_bad = false;
    const handled: string[] = [];
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(
        async function react(_e, stream) {
          handled.push(stream);
        },
        { maxRetries: 0, blockOnError: true }
      )
      .to((event) => {
        if (fail_bad && event.stream === "bad")
          throw new Error("drain-time bug");
        // With a source, each target reads only its own stream's events.
        return { target: `t-${event.stream}`, source: event.stream };
      })
      .build({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
    const errors: unknown[] = [];
    app.on("error", (e) => errors.push(e));
    const blocked: { stream: string; error: string }[] = [];
    app.on("blocked", (leases) => blocked.push(...leases));
    vi.spyOn(log(), "error").mockImplementation(() => {});

    await app.do("bump", { stream: "bad", actor }, {});
    await app.do("bump", { stream: "good", actor }, {});
    await app.correlate();
    fail_bad = true;
    await app.drain();

    expect(handled).toEqual(["t-good"]);
    expect(blocked.map((b) => b.stream)).toEqual(["t-bad"]);
    expect(blocked[0].error).toContain('Resolver of reaction "react" threw');
    expect(errors).toHaveLength(0);

    // The breaker stayed closed: the drain still claims.
    await app.do("bump", { stream: "later", actor }, {});
    await app.correlate();
    await app.drain();
    expect(handled).toEqual(["t-good", "t-later"]);
  });

  it("retries on the reaction's backoff while budget remains", async () => {
    store(new InMemoryStore());
    let fail = false;
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function react() {}, { maxRetries: 3, blockOnError: true })
      .to((event) => {
        if (fail) throw new Error("drain-time bug");
        return { target: `t-${event.stream}`, source: event.stream };
      })
      .build();
    const blocked: unknown[] = [];
    app.on("blocked", (leases) => blocked.push(...leases));
    vi.spyOn(log(), "error").mockImplementation(() => {});

    await app.do("bump", { stream: "r1", actor }, {});
    await app.correlate();
    fail = true;
    await app.drain();

    expect(blocked).toHaveLength(0);
    let deferred_at: number | undefined;
    await store().query_streams(
      (p) => {
        deferred_at = p.deferred_at;
      },
      { stream: "t-r1", stream_exact: true }
    );
    expect(deferred_at).toBeGreaterThan(Date.now());
  });
});

describe("a reaction-requested close whose archive callback throws", () => {
  it("is logged as app code and never counts on the store breaker", async () => {
    store(new InMemoryStore());
    const app = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function closing() {
        throw new CloseSignal({
          archive: async () => {
            throw new Error("s3 down");
          },
        });
      })
      .build({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });
    const errors: unknown[] = [];
    app.on("error", (e) => errors.push(e));
    const logged = vi.spyOn(log(), "error").mockImplementation(() => {});

    await app.do("bump", { stream: "c1", actor }, {});
    await app.correlate();
    await app.drain();

    expect(errors).toHaveLength(0);
    const app_errors = logged.mock.calls
      .map(([e]) => e as unknown)
      .filter((e) => e instanceof AppCodeError);
    expect(app_errors).toHaveLength(1);
    expect((app_errors[0] as Error).message).toContain(
      'Archive callback for close of "c1" threw: s3 down'
    );
  });
});

describe("AppCodeError", () => {
  it("names the context and keeps the cause, whatever was thrown", () => {
    const from_error = new AppCodeError("ctx", new Error("boom"));
    expect(from_error.message).toBe("ctx: boom");
    expect(from_error.name).toBe("AppCodeError");
    const from_string = new AppCodeError("ctx", "boom");
    expect(from_string.message).toBe("ctx: boom");
    expect(from_string.cause).toBe("boom");
  });
});
