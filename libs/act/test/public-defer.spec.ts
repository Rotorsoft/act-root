import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  act,
  DeferSignal,
  dispose,
  sleep,
  state,
  ZodEmpty,
} from "../src/index.js";

/**
 * The imperative escape hatch (#1091): a reaction throws `DeferSignal` with an
 * unresolved `when`, and the drain resolves it against the triggering event.
 * This is the same hold/redeliver mechanic covered structurally in
 * defer-outcome.spec.ts, exercised through the public throwable and the full
 * `when` vocabulary (`{ at: Date }`, `{ at: (event) => Date }`, `{ after }`).
 */
describe("imperative DeferSignal(when)", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: () => ({}) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  it("{ at: Date } holds until the due-time, then acts", async () => {
    let attempts = 0;
    const until = Date.now() + 120;
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function deadline() {
        attempts++;
        if (Date.now() < until) throw new DeferSignal({ at: new Date(until) });
      })
      .build();

    await app.do("tick", { stream: "at1", actor }, {});
    await app.correlate();
    const first = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    expect(first.acked.length).toBe(0); // deferred, not acked

    await sleep(150);
    const done = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
    expect(done.acked.some((l) => l.stream === "at1")).toBe(true);
  });

  it("{ at: (event) => Date } derives the due-time from the triggering event", async () => {
    let attempts = 0;
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function deadlineFn(event) {
        attempts++;
        if (Date.now() < event.created.getTime() + 100)
          throw new DeferSignal({
            at: (e) => new Date(e.created.getTime() + 100),
          });
      })
      .build();

    await app.do("tick", { stream: "atfn1", actor }, {});
    await app.correlate();
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);

    await sleep(140);
    const done = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
    expect(done.acked.some((l) => l.stream === "atfn1")).toBe(true);
  });

  it("{ after } is measured from the event's created time (parks, not acked)", async () => {
    let attempts = 0;
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function cooldown() {
        attempts++;
        throw new DeferSignal({ after: { minutes: 30 } });
      })
      .build();

    await app.do("tick", { stream: "after1", actor }, {});
    await app.correlate();
    const first = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    expect(first.acked.length).toBe(0); // deferred 30m out, not acked
    // still deferred right after
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
  });
});
