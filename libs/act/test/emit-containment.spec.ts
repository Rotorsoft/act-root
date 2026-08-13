import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Actor,
  act,
  dispose,
  sensitive,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";

/**
 * #1437 — lifecycle containment belongs to `Act.emit`, not to each call site.
 *
 * Two defects, one root cause. The drain contained `acked` and `blocked`, but
 * `committed`, `forgotten` and `close()`'s `closed` were bare `this.emit(...)`
 * calls that ran AFTER their durable work landed — so a throwing observability
 * listener rejected `do()`, `forget()` and `close()` for work that had already
 * succeeded. And even where a call site did wrap, it wrapped the *emit* rather
 * than each *listener*, so the first thrower aborted `EventEmitter.emit` and
 * every later listener on that event was skipped — the same shape as #1423.
 */

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Ticked: ZodEmpty })
  .patch({ Ticked: (_e, s) => ({ n: s.n + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Ticked", {}])
  .build();

const userRegistered = z.object({
  email: sensitive(z.string()),
  plan: z.enum(["free", "pro"]),
});
const User = state({ User: z.object({ email: z.string().optional() }) })
  .init(() => ({}))
  .emits({ UserRegistered: userRegistered })
  .patch({ UserRegistered: ({ data }) => ({ email: data.email }) })
  .on({ register: userRegistered })
  .emit((p) => ["UserRegistered", p])
  .discloses(() => true)
  .build();

const actor: Actor = { id: "a", name: "a" };
const boom = () => {
  throw new Error("metrics bridge exploded");
};

describe("lifecycle emits are contained per listener (#1437)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("a throwing committed listener does not fail do() after the commit lands", async () => {
    const app = act().withState(Counter).build();
    app.on("committed", boom);

    let thrown: unknown;
    await app.do("tick", { stream: "u1", actor }, {}).catch((e) => {
      thrown = e;
    });

    // Durability first, so the ordering is proven rather than inferred: the
    // events are already committed when the listener throws. A caller that
    // treats the rejection as failure and retries would double-write, since
    // the framework has no request dedup by design.
    const rows: unknown[] = [];
    await store().query((e) => rows.push(e), { stream: "u1" });
    expect(rows).toHaveLength(1);
    expect(thrown).toBeUndefined();

    await app.shutdown();
  });

  it("a throwing forgotten listener does not fail forget() after the PII is wiped", async () => {
    const app = act().withState(User).build();
    app.on("forgotten", boom);

    await app.do(
      "register",
      { stream: "u2", actor },
      { email: "a@b.c", plan: "free" }
    );

    let thrown: unknown;
    const result = await app.forget("u2").catch((e) => {
      thrown = e;
      return undefined;
    });

    expect(thrown).toBeUndefined();
    expect(result?.eventCount).toBe(1);
    // The retry an operator would run after a spurious rejection hits the
    // idempotent zero-path, which is why a false failure here makes an
    // erasure unverifiable.
    expect((await app.forget("u2")).eventCount).toBe(0);

    await app.shutdown();
  });

  it("a throwing closed listener does not fail close() after the truncate lands", async () => {
    const app = act().withState(Counter).build();
    app.on("closed", boom);

    await app.do("tick", { stream: "u3", actor }, {});

    let thrown: unknown;
    const result = await app.close([{ stream: "u3" }]).catch((e) => {
      thrown = e;
      return undefined;
    });

    expect(thrown).toBeUndefined();
    expect(result?.truncated).toBeDefined();

    await app.shutdown();
  });

  it("a throwing listener does not suppress the listeners after it", async () => {
    const app = act()
      .withState(Counter)
      .on("Ticked")
      .do(async function react() {})
      .to((e) => ({ target: `t-${e.stream}` }))
      .build();

    let second = 0;
    let third = 0;
    app.on("acked", boom);
    app.on("acked", () => {
      second++;
    });
    app.on("acked", () => {
      third++;
    });

    await app.do("tick", { stream: "u4", actor }, {});
    await app.correlate();
    const drained = await app.drain();

    expect(drained.acked.length).toBeGreaterThan(0);
    expect({ second, third }).toEqual({ second: 1, third: 1 });

    await app.shutdown();
  });

  it("control — a real failure inside do() still reaches the caller", async () => {
    // Containment must cover observers only. If it started swallowing the
    // operation's own errors, every one of the tests above would pass for
    // the wrong reason.
    const app = act().withState(Counter).build();
    app.on("committed", boom);
    let thrown: unknown;
    // A genuine ConcurrencyError: the stream is at version -1, not 5.
    await app
      .do("tick", { stream: "u5", actor, expectedVersion: 5 }, {})
      .catch((e) => {
        thrown = e;
      });
    expect((thrown as Error)?.name).toBe("ERR_CONCURRENCY");
    await app.shutdown();
  });

  it("control — emit reports whether the event had listeners", async () => {
    const app = act().withState(Counter).build();
    expect(app.emit("committed", [] as never)).toBe(false);
    app.on("committed", () => {});
    expect(app.emit("committed", [] as never)).toBe(true);
    await app.shutdown();
  });
});
