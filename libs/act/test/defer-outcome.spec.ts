import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { act, dispose, sleep, state, store, ZodEmpty } from "../src/index.js";
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

  // The local wake has to run the drain, not just flag it: on an idle app
  // nothing else reads the flag, so the deferred reaction would never fire.
  describe("fires on an idle app with no further calls", () => {
    const deferred = (ran: { n: number }) =>
      act()
        .withState(counter)
        .withLane({ name: "polled", cycleMs: 20 })
        .on("ticked")
        .defer((e) => ({ at: new Date(e.created.getTime() + 100) }))
        .do(async function remindLater() {
          ran.n++;
        });

    it("on the default lane", async () => {
      const ran = { n: 0 };
      const app = deferred(ran).to("reminders").build();
      await app.do("tick", { stream: "idle", actor }, {});
      app.settle({ debounceMs: 0 });
      await sleep(400);
      expect(ran.n).toBe(1);
    });

    it("control — on a lane that polls with cycleMs", async () => {
      const ran = { n: 0 };
      const app = deferred(ran)
        .to({ target: "reminders", lane: "polled" })
        .build();
      await app.do("tick", { stream: "idle", actor }, {});
      app.settle({ debounceMs: 0 });
      await sleep(400);
      expect(ran.n).toBe(1);
    });
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
    const acked: string[] = [];
    app.on("acked", (leases) => acked.push(...leases.map((l) => l.stream)));

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

    // After the due-time: the wake redelivers, the handler succeeds, acked.
    await sleep(150);
    expect(attempts).toBe(2);
    expect(acked).toContain("d1");
  });

  it("keeps the wake for other parked streams when a woken drain claims nothing", async () => {
    // W1 parks two streams. Before its first wake, another worker moves w1's
    // schedule later in the store, so the wake's drain claims nothing. That
    // empty claim must not throw away the wake for w2: the aggregate is idle,
    // so no commit would ever re-arm W1.
    const ran: string[] = [];
    const w1 = act()
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

    await w1.do("tick", { stream: "w1", actor }, {});
    await w1.do("tick", { stream: "w2", actor }, {});
    await w1.correlate();
    await w1.drain({ leaseMillis: 1 }); // both parked
    expect(ran).toEqual([]);

    const claim = vi.spyOn(store(), "claim");
    await store().defer(["remind-w1"], Date.now() + 120);
    await sleep(100); // W1 has woken for w1 and claimed nothing
    expect(claim).toHaveBeenCalled();
    expect(ran).toEqual([]);

    await sleep(200); // past w2's due-time; both are due by then
    expect(ran.sort()).toEqual(["w1", "w2"]);
  });

  it("re-runs a sibling that shares the deferred reaction's target, but not an isolated one", async () => {
    // Documented in state-management.md § Isolating a defer with `.to`:
    // a group is delivered again when its deferred member comes due.
    async function welcomes(isolate: boolean) {
      let welcomed = 0;
      const deferred = act()
        .withState(counter)
        .on("ticked")
        .do(async function welcome() {
          welcomed++;
        })
        .on("ticked")
        .defer((e) => ({ at: new Date(e.created.getTime() + 60) }))
        .do(async function later() {});
      const app = (
        isolate
          ? deferred.to((e) => ({ target: `later-${e.stream}` }))
          : deferred
      ).build();
      await app.do("tick", { stream: isolate ? "iso" : "shared", actor }, {});
      for (let i = 0; i < 4; i++) {
        await app.correlate();
        await app.drain({ leaseMillis: 1 });
        await sleep(50);
      }
      await dispose()();
      return welcomed;
    }
    expect(await welcomes(false)).toBe(2);
    expect(await welcomes(true)).toBe(1);
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
    const acked = new Set<string>();
    app.on("acked", (leases) => {
      for (const l of leases) acked.add(l.stream);
    });

    await app.do("tick", { stream: "g1", actor }, {});
    await app.do("tick", { stream: "g2", actor }, {});
    await app.correlate();

    // Both streams defer in the same cycle, sharing the due-time.
    const first = await app.drain({ leaseMillis: 1 });
    expect(seen.has("g1") && seen.has("g2")).toBe(true);
    expect(first.acked.length).toBe(0);

    // After the due-time the wake redelivers both and they are acked.
    await sleep(150);
    expect(acked.has("g1") && acked.has("g2")).toBe(true);
  });
});
