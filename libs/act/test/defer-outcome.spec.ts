import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { act, dispose, sleep, state, ZodEmpty } from "../src/index.js";
import { DeferSignal } from "../src/internal/defer-signal.js";

/**
 * End-to-end coverage of the `defer` outcome (#1090): a reaction handler
 * throws {@link DeferSignal}, the drain holds the triggering event pending
 * (no ack, no retry bump), persists the due-time via `Store.defer` so
 * `claim` skips the stream, and re-delivers once the due-time passes.
 */
describe("defer outcome (integration)", () => {
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

  it("holds pending until the due-time, then redelivers and acks", async () => {
    let attempts = 0;
    const until = Date.now() + 120;
    const deferring = async () => {
      attempts++;
      // Derivable due-time (not Date.now()-relative at call): re-evaluated on
      // every redelivery so the decision survives a re-claim.
      if (Date.now() < until) throw new DeferSignal({ at: new Date(until) });
    };

    const app = act().withState(counter).on("ticked").do(deferring).build();

    await app.do("tick", { stream: "d1", actor }, {});
    await app.correlate();

    // First drain: handler defers — no ack, watermark held.
    const first = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    expect(first.acked.length).toBe(0);
    expect(first.blocked.length).toBe(0);

    // Before the due-time: the stream is skipped, handler is not re-run.
    await sleep(20);
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);

    // After the due-time: redelivered, the handler succeeds, stream acked.
    await sleep(150);
    const done = await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
    expect(done.acked.some((l) => l.stream === "d1")).toBe(true);
  });

  it("keeps the wake for other parked streams when a woken drain claims nothing", async () => {
    // W1 parks two streams. Its timer wakes for the first, but a competing
    // worker handles that one first, so W1's next drain claims nothing.
    // That empty claim must not throw away the wake for the second stream:
    // the aggregate is idle, so no commit would ever re-arm W1.
    const ran: string[] = [];
    const worker = () =>
      act()
        .withState(counter)
        .on("ticked")
        .defer((e) => ({
          at: new Date(e.created.getTime() + (e.stream === "w1" ? 60 : 200)),
        }))
        .do(async function remind(e) {
          ran.push(e.stream);
        })
        .to((e) => ({ target: `remind-${e.stream}` }))
        .build();

    const w1 = worker();
    await w1.do("tick", { stream: "w1", actor }, {});
    await w1.do("tick", { stream: "w2", actor }, {});
    await w1.correlate();
    await w1.drain({ leaseMillis: 1 }); // both parked
    expect(ran).toEqual([]);

    await sleep(100); // W1's timer has woken for w1
    const competitor = worker();
    await competitor.correlate();
    await competitor.drain({ leaseMillis: 1 });
    expect(ran).toEqual(["w1"]);

    const empty = await w1.drain({ leaseMillis: 1 });
    expect(empty.leased.length).toBe(0);

    await sleep(200); // past w2's due-time
    await w1.drain({ leaseMillis: 1 });
    expect(ran).toEqual(["w1", "w2"]);
  });

  it("groups streams sharing one due-time into a single defer call", async () => {
    // A fixed due-time shared by both streams so the cycle's persist loop
    // groups them under one key (exercises the same-due-time branch).
    const until = Date.now() + 120;
    const seen = new Set<string>();
    const deferring = async (_e: unknown, stream: string) => {
      seen.add(stream);
      if (Date.now() < until) throw new DeferSignal({ at: new Date(until) });
    };

    const app = act().withState(counter).on("ticked").do(deferring).build();

    await app.do("tick", { stream: "g1", actor }, {});
    await app.do("tick", { stream: "g2", actor }, {});
    await app.correlate();

    // Both streams defer in the same cycle, sharing the due-time.
    const first = await app.drain({ leaseMillis: 1 });
    expect(seen.has("g1") && seen.has("g2")).toBe(true);
    expect(first.acked.length).toBe(0);

    // After the due-time both are redelivered and acked.
    await sleep(150);
    const done = await app.drain({ leaseMillis: 1 });
    const acked = new Set(done.acked.map((l) => l.stream));
    expect(acked.has("g1") && acked.has("g2")).toBe(true);
  });
});
