import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, dispose, log, state, store } from "../src/index.js";
import { CloseSignal } from "../src/internal/reaction-dispatch.js";

/**
 * App code failing inside a framework loop (a resolver, a close's archive
 * callback) never leaves the loop that ran it: it stops only what it
 * breaks, logs a bounded number of lines, and never emits `error` or counts
 * on the store circuit breaker.
 */

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Bumped: z.object({}) })
  .patch({ Bumped: (_e, s) => s })
  .on({ bump: z.object({}) })
  .emit("Bumped")
  .build();

const actor = { id: "a", name: "a" };

const messages = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([e, msg]) =>
    String(msg ?? (e instanceof Error ? e.message : e))
  );

afterEach(async () => {
  vi.restoreAllMocks();
  await dispose()();
});

describe("a resolver that throws during correlate", () => {
  it("stops the scan before that event, logs once, and resumes without losing it", async () => {
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
        if (broken && event.stream === "s1") throw new Error("resolver bug");
        return { target: `t-${event.stream}` };
      })
      .build({
        autoSettle: false,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      });
    const errors: unknown[] = [];
    app.on("error", (e) => errors.push(e));
    const logged = vi.spyOn(log(), "error").mockImplementation(() => {});

    // s1 fails; s2 and s3 sit behind it and must wait, not be skipped.
    for (const stream of ["s1", "s2", "s3"]) {
      await app.do("bump", { stream, actor }, {});
      await app.correlate();
      await app.drain();
    }
    expect(handled).toEqual([]);
    expect(calls).toBeGreaterThan(1); // retried on every trigger...
    const reports = messages(logged).filter((m) =>
      m.includes('Resolver of reaction "react" threw on Bumped')
    );
    expect(reports).toHaveLength(1); // ...but logged once
    expect(reports[0]).toContain("resolver bug");
    // A threshold-1 store breaker would have opened on the first failure.
    expect(errors).toHaveLength(0);

    broken = false;
    await app.correlate();
    await app.drain();
    expect(handled.sort()).toEqual(["t-s1", "t-s2", "t-s3"]);
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
      .build({
        autoSettle: false,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      });
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
        if (fail) throw "drain-time bug";
        return { target: `t-${event.stream}`, source: event.stream };
      })
      .build({ autoSettle: false });
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
  it("is logged and never counts on the store breaker", async () => {
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
      .build({
        autoSettle: false,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      });
    const errors: unknown[] = [];
    app.on("error", (e) => errors.push(e));
    const logged = vi.spyOn(log(), "error").mockImplementation(() => {});

    await app.do("bump", { stream: "c1", actor }, {});
    await app.correlate();
    await app.drain();

    expect(errors).toHaveLength(0);
    expect(
      messages(logged).filter((m) =>
        m.includes('Reaction-requested close of "c1" failed')
      )
    ).toHaveLength(1);
  });
});
