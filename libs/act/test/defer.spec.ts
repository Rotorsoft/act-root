import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  type CloseResult,
  DeferSignal,
  dispose,
  StoreError,
  sleep,
  slice,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";
import { CloseSignal } from "../src/internal/reaction-dispatch.js";

/**
 * Deferred reactions. A reaction holds until its schedule is due, then runs:
 * declared with `.defer(when)` on the builder, or thrown at run time as a
 * `DeferSignal`. The drain holds the triggering event pending (no ack, no
 * retry bump), persists the due-time atomically with the cycle's acks so
 * `claim` skips the stream on every worker, and a per-worker wake runs the
 * drain when it comes due.
 */

const counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ ticked: ZodEmpty })
  .patch({ ticked: () => ({}) })
  .on({ tick: ZodEmpty })
  .emit(() => ["ticked", {}])
  .build();

const actor = { id: "a", name: "a" };

afterEach(async () => {
  vi.restoreAllMocks();
  await dispose()();
});

describe("declarative .defer(when)", () => {
  const job = state({ Job: z.object({ status: z.string() }) })
    .init(() => ({ status: "" }))
    .emits({ queued: z.object({ delayMs: z.number() }) })
    .patch({ queued: () => ({ status: "queued" }) })
    .on({ enqueue: z.object({ delayMs: z.number() }) })
    .emit((a) => ["queued", a])
    .build();

  it("literal { after } holds the reaction (handler not run, not acked)", async () => {
    let ran = 0;
    const app = act()
      .withState(counter)
      .on("ticked")
      .defer({ after: { minutes: 30 } })
      .do(async function cooldown() {
        ran++;
      })
      .build({ autoSettle: false });

    await app.do("tick", { stream: "d1", actor }, {});
    await app.correlate();
    const first = await app.drain();
    expect(ran).toBe(0); // held before the handler ran
    expect(first.acked.length).toBe(0);
    // still deferred on the next pass
    await app.drain();
    expect(ran).toBe(0);
  });

  it("sums a { days, hours } duration (minutes omitted)", async () => {
    let ran = 0;
    const app = act()
      .withState(counter)
      .on("ticked")
      .defer({ after: { days: 1, hours: 2 } })
      .do(async function longCooldown() {
        ran++;
      })
      .build({ autoSettle: false });

    await app.do("tick", { stream: "dh1", actor }, {});
    await app.correlate();
    const first = await app.drain();
    expect(ran).toBe(0); // ~26h out, held
    expect(first.acked.length).toBe(0);
  });

  it("function form reads the payload to choose the schedule, then runs", async () => {
    let ran = 0;
    const app = act()
      .withState(job)
      .on("queued")
      .defer((event) => ({
        at: new Date(event.created.getTime() + event.data.delayMs),
      }))
      .do(async function start() {
        ran++;
      })
      .build({ autoSettle: false });
    const acked: string[] = [];
    app.on("acked", (leases) => acked.push(...leases.map((l) => l.stream)));

    await app.do("enqueue", { stream: "j1", actor }, { delayMs: 100 });
    await app.correlate();
    await app.drain();
    expect(ran).toBe(0); // deferred by the payload-derived delay

    // The local wake runs the drain at the due-time.
    await vi.waitFor(() => {
      expect(ran).toBe(1);
      expect(acked).toContain("j1");
    });
  });

  it("runs immediately once the schedule is already due", async () => {
    let ran = 0;
    const app = act()
      .withState(counter)
      .on("ticked")
      // A past instant: due on first delivery, so the handler runs right away.
      .defer({ at: new Date(0) })
      .do(async function immediate() {
        ran++;
      })
      .build({ autoSettle: false });

    await app.do("tick", { stream: "now1", actor }, {});
    await app.correlate();
    const done = await app.drain();
    expect(ran).toBe(1);
    expect(done.acked.some((l) => l.stream === "now1")).toBe(true);
  });

  it("composes with .to(target) for opt-in isolation", async () => {
    let ran = 0;
    const app = act()
      .withState(counter)
      .on("ticked")
      .defer({ at: new Date(0) })
      .do(async function routed() {
        ran++;
      })
      .to("counter-deadlines")
      .build({ autoSettle: false });

    await app.do("tick", { stream: "r1", actor }, {});
    await app.correlate();
    const done = await app.drain();
    expect(ran).toBe(1);
    // ran on the routed target, not the source stream
    expect(done.acked.some((l) => l.stream === "counter-deadlines")).toBe(true);
  });

  it("rejects a bad literal schedule at build time", () => {
    const on = () => act().withState(counter).on("ticked");
    // neither after nor at
    expect(() =>
      on()
        .defer({} as never)
        .do(async function n() {})
    ).toThrow(/exactly one of/);
    // both after and at
    expect(() =>
      on()
        .defer({ after: { minutes: 1 }, at: new Date() } as never)
        .do(async function b() {})
    ).toThrow(/exactly one of/);
    // empty duration
    expect(() =>
      on()
        .defer({ after: {} })
        .do(async function e() {})
    ).toThrow(/at least one of/);
  });

  it("a bad schedule from the function form throws when it runs", async () => {
    const app = act()
      .withState(counter)
      .on("ticked")
      .defer(() => ({}) as never)
      .do(async function fnBad() {})
      .build({ autoSettle: false });

    await app.do("tick", { stream: "fb1", actor }, {});
    await app.correlate();
    // The wrapper resolves the schedule on delivery; a bad shape fails the
    // reaction (blockOnError defaults on), so nothing is acked.
    const res = await app.drain();
    expect(res.acked.length).toBe(0);
  });

  it("is available on the slice() builder too", async () => {
    let ran = 0;
    const s = slice()
      .withState(counter)
      .on("ticked")
      .defer({ after: { minutes: 30 } })
      .do(async function sliceCooldown() {
        ran++;
      })
      .build();

    const app = act().withSlice(s).build({ autoSettle: false });
    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();
    const first = await app.drain();
    expect(ran).toBe(0);
    expect(first.acked.length).toBe(0);
  });
});

describe("imperative DeferSignal(when)", () => {
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
      .build({ autoSettle: false });
    const acked: string[] = [];
    app.on("acked", (leases) => acked.push(...leases.map((l) => l.stream)));

    await app.do("tick", { stream: "at1", actor }, {});
    await app.correlate();
    const first = await app.drain();
    expect(attempts).toBe(1);
    expect(first.acked.length).toBe(0); // deferred, not acked

    await vi.waitFor(() => {
      expect(attempts).toBe(2);
      expect(acked).toContain("at1");
    });
  });

  it("{ at: Date } derived from the event in the handler", async () => {
    let attempts = 0;
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function deadlineFn(event) {
        attempts++;
        const due = event.created.getTime() + 100;
        if (Date.now() < due) throw new DeferSignal({ at: new Date(due) });
      })
      .build({ autoSettle: false });
    const acked: string[] = [];
    app.on("acked", (leases) => acked.push(...leases.map((l) => l.stream)));

    await app.do("tick", { stream: "atfn1", actor }, {});
    await app.correlate();
    await app.drain();
    expect(attempts).toBe(1);

    await vi.waitFor(() => {
      expect(attempts).toBe(2);
      expect(acked).toContain("atfn1");
    });
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
      .build({ autoSettle: false });

    await app.do("tick", { stream: "after1", actor }, {});
    await app.correlate();
    const first = await app.drain();
    expect(attempts).toBe(1);
    expect(first.acked.length).toBe(0); // deferred 30m out, not acked
    // still deferred right after
    await app.drain();
    expect(attempts).toBe(1);
  });

  it("an invalid schedule fails its own reaction, never the drain pass", async () => {
    // The type admits `{ after: { minutes: 0 } }`; the schema rejects it.
    // That reaction spends its budget and blocks like any handler error,
    // the other reaction in the same pass acks, and nothing is counted
    // against the store circuit breaker.
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function healthy() {})
      .to("defer-ok")
      .on("ticked")
      .do(
        async function bad_schedule() {
          throw new DeferSignal({ after: { minutes: 0 } });
        },
        { maxRetries: 0 }
      )
      .to("defer-bad")
      .build({ autoSettle: false });
    const acked: string[] = [];
    const blocked: string[] = [];
    const errors: unknown[] = [];
    app.on("acked", (leases) => acked.push(...leases.map((l) => l.stream)));
    app.on("blocked", (leases) => blocked.push(...leases.map((l) => l.stream)));
    app.on("error", (e) => errors.push(e));

    await app.do("tick", { stream: "bad-when", actor }, {});
    await app.correlate();
    await app.drain();

    expect(acked).toEqual(["defer-ok"]);
    expect(blocked).toEqual(["defer-bad"]);
    expect(errors).toEqual([]);
  });
});

describe("defer outcome (integration)", () => {
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
      await vi.waitFor(() => {
        expect(ran.n).toBe(1);
      });
    });

    it("control — on a lane that polls with cycleMs", async () => {
      const ran = { n: 0 };
      const app = deferred(ran)
        .to({ target: "reminders", lane: "polled" })
        .build();
      await app.do("tick", { stream: "idle", actor }, {});
      app.settle({ debounceMs: 0 });
      await vi.waitFor(() => {
        expect(ran.n).toBe(1);
      });
    });

    // A pass whose claimed streams all deferred still has work: more streams
    // were marked than one claim takes (streamLimit 10).
    it("runs every stream of a burst whose first pass only deferred", async () => {
      const tried = new Set<string>();
      const ran = new Set<string>();
      const app = act()
        .withState(counter)
        .on("ticked")
        .do(async function remindLater(event) {
          if (!tried.has(event.stream)) {
            tried.add(event.stream);
            throw new DeferSignal({ at: new Date(Date.now() + 200) });
          }
          ran.add(event.stream);
        })
        .to((e) => ({ target: `r-${e.stream}`, source: e.stream }))
        .build();
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          app.do("tick", { stream: `b${i}`, actor }, {})
        )
      );
      await vi.waitFor(() => expect(ran.size).toBe(12), { timeout: 3000 });
    });

    // A failed finalize persisted nothing, so the reaction redelivers; the
    // drain retries after the breaker's cooldown without waiting for it to
    // open (threshold 5).
    it("re-fires after the finalize that would persist its schedule fails", async () => {
      let runs = 0;
      const app = act()
        .withState(counter)
        .on("ticked")
        .do(async function remindLater() {
          runs++;
          if (runs === 1)
            throw new DeferSignal({ at: new Date(Date.now() + 300) });
        })
        .to("reminders")
        .build({ autoSettle: false, circuitBreaker: { cooldownMs: 100 } });
      app.on("error", () => {});
      await app.do("tick", { stream: "flaky", actor }, {});
      const s = store();
      const ack = s.ack.bind(s);
      let once = true;
      vi.spyOn(s, "ack").mockImplementation((leases) => {
        if (!once) return ack(leases);
        once = false;
        return Promise.reject(new StoreError("ack"));
      });
      await app.correlate();
      await app.drain({ leaseMillis: 200 });
      await vi.waitFor(() => expect(runs).toBe(2), { timeout: 1500 });
    });
  });

  it("holds pending until the due-time, then redelivers and acks", async () => {
    // Only `Date` is faked, so "before the due-time" holds on a slow runner.
    vi.useFakeTimers({ toFake: ["Date"] });
    let attempts = 0;
    const until = Date.now() + 120;
    const deferring = async () => {
      attempts++;
      // Derivable due-time (not Date.now()-relative at call): re-evaluated on
      // every redelivery so the decision survives a re-claim.
      if (Date.now() < until) throw new DeferSignal({ at: new Date(until) });
    };

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(deferring)
      .build({ autoSettle: false });
    const acked: string[] = [];
    app.on("acked", (leases) => acked.push(...leases.map((l) => l.stream)));

    await app.do("tick", { stream: "d1", actor }, {});
    await app.correlate();

    // First drain: handler defers — no ack, watermark held.
    const first = await app.drain();
    expect(attempts).toBe(1);
    expect(first.acked.length).toBe(0);
    expect(first.blocked.length).toBe(0);

    try {
      // Before the due-time: the stream is skipped, handler is not re-run.
      vi.setSystemTime(Date.now() + 20);
      await app.drain();
      expect(attempts).toBe(1);

      // After the due-time: the wake redelivers, the handler succeeds, acked.
      vi.setSystemTime(until + 1);
      await vi.waitFor(() => {
        expect(attempts).toBe(2);
        expect(acked).toContain("d1");
      });
    } finally {
      vi.useRealTimers();
    }
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
      .build({ autoSettle: false });

    await w1.do("tick", { stream: "w1", actor }, {});
    await w1.do("tick", { stream: "w2", actor }, {});
    await w1.correlate();
    await w1.drain(); // both parked
    expect(ran).toEqual([]);

    const claim = vi.spyOn(store(), "claim");
    await store().defer(["remind-w1"], Date.now() + 120);
    // W1 wakes for w1 and claims nothing.
    await vi.waitFor(() => expect(claim).toHaveBeenCalled());
    expect(ran).toEqual([]);

    await vi.waitFor(() => {
      expect(ran.sort()).toEqual(["w1", "w2"]);
    });
  });

  it("keeps the wake for parked streams when it fires while the breaker is open", async () => {
    // w1's wake fires while the breaker is open, so its drain skips the
    // store. Nothing is lost: the breaker's own wake settles after the
    // cooldown, that drain runs w1 and re-aims the wake for w2.
    const ran: string[] = [];
    const app = act()
      .withState(counter)
      .on("ticked")
      .defer((e) => ({
        at: new Date(e.created.getTime() + (e.stream === "w1" ? 250 : 1000)),
      }))
      .do(async function remind(e) {
        ran.push(e.stream);
      })
      .to((e) => ({ target: `remind-${e.stream}` }))
      .build({
        autoSettle: false,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 500 },
      });
    app.on("error", () => {});
    const [committed] = await app.do("tick", { stream: "w1", actor }, {});
    await app.do("tick", { stream: "w2", actor }, {});
    await app.correlate();
    await app.drain(); // both parked

    // One failed claim opens the breaker (threshold 1).
    vi.spyOn(store(), "claim").mockRejectedValueOnce(new StoreError("claim"));
    await app.drain();
    // w1's wake fires at +250ms while the breaker is open (until ~+500ms)
    await sleep(committed.event!.created.getTime() + 300 - Date.now());
    expect(ran).toEqual([]);
    await vi.waitFor(() => expect(ran).toEqual(["w1", "w2"]), {
      timeout: 3000,
    });
  });

  describe("a wake that lands while another drain is running", () => {
    it("still runs the stream that came due", async () => {
      // b comes due while a slow drain of a holds the lock, so the wake's
      // own drain returns at once. b must still run without a new commit.
      const ran: string[] = [];
      const until = Date.now() + 100;
      const app = act()
        .withState(counter)
        .on("ticked")
        .do(async function slow(e) {
          if (e.stream === "b" && Date.now() < until)
            throw new DeferSignal({ at: new Date(until) });
          if (e.stream === "a") await sleep(300);
          ran.push(e.stream);
        })
        .to((e) => ({ target: `t-${e.stream}` }))
        .build({ autoSettle: false });
      await app.do("tick", { stream: "b", actor }, {});
      await app.correlate();
      await app.drain(); // b parked until +100
      await app.do("tick", { stream: "a", actor }, {});
      await app.correlate();
      const running = app.drain(); // still running at b's due-time
      await vi.waitFor(() => expect(ran).toEqual(["a", "b"]), {
        timeout: 1500,
      });
      await running;
    });
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
      ).build({ autoSettle: false });
      await app.do("tick", { stream: isolate ? "iso" : "shared", actor }, {});
      for (let i = 0; i < 4; i++) {
        await app.correlate();
        await app.drain();
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

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(deferring)
      .build({ autoSettle: false });
    const acked = new Set<string>();
    app.on("acked", (leases) => {
      for (const l of leases) acked.add(l.stream);
    });

    await app.do("tick", { stream: "g1", actor }, {});
    await app.do("tick", { stream: "g2", actor }, {});
    await app.correlate();

    // Both streams defer in the same cycle, sharing the due-time.
    const first = await app.drain();
    expect(seen.has("g1") && seen.has("g2")).toBe(true);
    expect(first.acked.length).toBe(0);

    // After the due-time the wake redelivers both and they are acked.
    await vi.waitFor(() => {
      expect(acked.has("g1") && acked.has("g2")).toBe(true);
    });
  });
});

describe("defer durability", () => {
  it("a failed finalize lands nothing — close requests are never lost", async () => {
    // Two streams in one cycle: one defers (far-future due-time), one
    // closes. When the atomic ack call fails, the close target must NOT
    // have been acked — a schedule write failing after the acks would drop
    // the close permanently (the terminal event, once acked, is never
    // redelivered).
    let defer_attempts = 0;
    const handler = async (_e: unknown, stream: string) => {
      if (stream === "d-defer") {
        defer_attempts++;
        throw new DeferSignal({ at: new Date(Date.now() + 60_000) });
      }
      throw new CloseSignal();
    };

    const app = act()
      .withState(counter)
      .on("ticked")
      .do(handler)
      .build({ autoSettle: false });
    const closed: CloseResult[] = [];
    const errors: string[] = [];
    app.on("closed", (r) => closed.push(r));
    app.on("error", ({ error }) => errors.push(String(error)));

    const ack_spy = vi.spyOn(store(), "ack");
    ack_spy.mockRejectedValueOnce(new Error("disk full"));

    await app.do("tick", { stream: "d-defer", actor }, {});
    await app.do("tick", { stream: "d-close", actor }, {});
    await app.correlate();

    // Cycle 1: the atomic finalize fails — nothing lands. No close, no
    // ack, and the failure is an operator-visible lifecycle event.
    const first = await app.drain({ leaseMillis: 1 });
    expect(first.acked).toHaveLength(0);
    expect(closed).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);

    // Cycle 2: everything redelivers — the close lands, the handler
    // re-throws its DeferSignal, and the retried finalize persists the
    // schedule. Nothing was lost to the failure.
    const second = await app.drain({ leaseMillis: 1 });
    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.has("d-close")).toBe(true);
    expect(second.acked.some((l) => l.stream === "d-close")).toBe(true);
    expect(defer_attempts).toBe(2);

    // Cycle 3: the schedule is durable — claim skips the deferred stream
    // until its due-time, so the handler is not re-run.
    await app.drain({ leaseMillis: 1 });
    expect(defer_attempts).toBe(2);
  });

  it("persists the defer schedule in the same store call as the acks", async () => {
    const due = new Date(Date.now() + 60_000);
    const deferring = async () => {
      throw new DeferSignal({ at: due });
    };
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(deferring)
      .build({ autoSettle: false });

    const ack_spy = vi.spyOn(store(), "ack");
    const defer_spy = vi.spyOn(store(), "defer");

    await app.do("tick", { stream: "h1", actor }, {});
    await app.correlate();
    await app.drain();

    // One atomic call: the deferred lease rides the finalize batch marked
    // with `due`; the standalone defer() op is not part of drain
    // finalization anymore.
    expect(ack_spy).toHaveBeenCalledWith([
      expect.objectContaining({ stream: "h1", due: due.getTime() }),
    ]);
    expect(defer_spy).not.toHaveBeenCalled();
  });

  describe("a cold start re-arms each still-future deferred_at", () => {
    // A restart empties the in-memory wake; the cold start reads the
    // persisted schedule back. Nothing commits to the parked stream, so only
    // a re-armed wake can claim it once it is due.
    const cold_start = async (lanes: string[] = [], onlyLanes?: string[]) => {
      let builder = act().withState(counter);
      for (const name of lanes) builder = builder.withLane({ name }) as never;
      const app = builder
        .on("ticked")
        .do(async function noop() {})
        .build({ autoSettle: false, onlyLanes: onlyLanes as never });
      // Nothing drains an app built with `autoSettle: false` but a wake.
      const claim = vi.spyOn(store(), "claim");
      await app.correlate();
      return claim;
    };
    const lane_of = (call: unknown[]) => call[4];

    it("runs the drain at the persisted due-time with no intervening commit", async () => {
      await store().subscribe([{ stream: "idle-agg", source: "idle-agg" }]);
      await store().defer(["idle-agg"], Date.now() + 40);
      const claim = await cold_start();
      await vi.waitFor(() => expect(claim).toHaveBeenCalled());
    });

    it("re-seeds a deferred stream sorting past the first stream page", async () => {
      const filler = Array.from(
        { length: 150 },
        (_, i) => `filler-${String(i).padStart(3, "0")}`
      );
      await store().subscribe(
        filler.map((stream) => ({ stream, source: stream }))
      );
      await store().subscribe([{ stream: "zzz-idle", source: "zzz-idle" }]);
      await store().defer(["zzz-idle"], Date.now() + 40);
      const claim = await cold_start();
      await vi.waitFor(() => expect(claim).toHaveBeenCalled());
    });

    it("seeds a non-default lane's controller from persisted deferred_at", async () => {
      await store().subscribe([
        { stream: "slow-agg", source: "slow-agg", lane: "slow" },
      ]);
      await store().defer(["slow-agg"], Date.now() + 40);
      const claim = await cold_start(["slow"]);
      // A wake that fires a hair before the due-time claims nothing and
      // re-aims, so the slow lane may claim more than once; no other lane may.
      await vi.waitFor(() => expect(claim).toHaveBeenCalled());
      expect(new Set(claim.mock.calls.map(lane_of))).toEqual(new Set(["slow"]));
    });

    it("routes a lane-less persisted defer to the default controller", async () => {
      // `StreamPosition.lane` is optional on the port.
      vi.spyOn(store(), "query_streams").mockImplementationOnce(
        async (callback) => {
          callback({
            stream: "lane-less",
            at: -1,
            retry: -1,
            blocked: false,
            error: "",
            priority: 0,
            deferred_at: Date.now() + 40,
          });
          return { maxEventId: -1, count: 1 };
        }
      );
      const claim = await cold_start();
      await vi.waitFor(() => expect(claim).toHaveBeenCalled());
    });

    it("skips a stream another worker's lane owns, and one already due", async () => {
      // No controller here owns "slow"; a past-due stream is already
      // claimable, so neither gets a wake.
      await store().subscribe([
        { stream: "slow-agg", source: "slow-agg", lane: "slow" },
        { stream: "past-agg", source: "past-agg" },
      ]);
      await store().defer(["slow-agg"], Date.now() + 20);
      await store().defer(["past-agg"], Date.now() - 1_000);
      const claim = await cold_start(["slow", "fast"], ["fast", "default"]);
      await sleep(60);
      expect(claim).not.toHaveBeenCalled();
    });
  });

  it("keeps the drain armed while finalization is unhealed", async () => {
    let attempts = 0;
    const deferring = async () => {
      attempts++;
      throw new DeferSignal({ at: new Date(Date.now() + 60_000) });
    };
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(deferring)
      .build({ autoSettle: false });
    app.on("error", () => {});

    vi.spyOn(store(), "ack").mockRejectedValue(new Error("still down"));

    await app.do("tick", { stream: "h2", actor }, {});
    await app.correlate();

    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(1);
    // The failed finalize keeps the controller armed (catch path) and the
    // schedule unpersisted, so the next drain redelivers — the loop that
    // eventually heals the schedule keeps running while the store is down.
    // The short wait lets the 1ms lease from the failed cycle expire.
    await sleep(10);
    await app.drain({ leaseMillis: 1 });
    expect(attempts).toBe(2);
  });
});
