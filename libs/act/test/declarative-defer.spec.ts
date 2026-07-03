import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { act, dispose, sleep, slice, state, ZodEmpty } from "../src/index.js";

/**
 * The declarative `.defer(when)` builder step (#1091): a reaction holds until
 * its schedule is due, then runs. `when` is either a literal {@link DeferWhen}
 * or a function of the triggering event (read the payload to choose). It's
 * available on both the `act()` and `slice()` builders.
 */
describe("declarative .defer(when)", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: () => ({}) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  const job = state({ Job: z.object({ status: z.string() }) })
    .init(() => ({ status: "" }))
    .emits({ queued: z.object({ delayMs: z.number() }) })
    .patch({ queued: () => ({ status: "queued" }) })
    .on({ enqueue: z.object({ delayMs: z.number() }) })
    .emit((a) => ["queued", a])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  it("literal { after } holds the reaction (handler not run, not acked)", async () => {
    let ran = 0;
    const app = act()
      .withState(counter)
      .on("ticked")
      .defer({ after: { minutes: 30 } })
      .do(async function cooldown() {
        ran++;
      })
      .build();

    await app.do("tick", { stream: "d1", actor }, {});
    await app.correlate();
    const first = await app.drain({ leaseMillis: 1 });
    expect(ran).toBe(0); // held before the handler ran
    expect(first.acked.length).toBe(0);
    // still deferred on the next pass
    await app.drain({ leaseMillis: 1 });
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
      .build();

    await app.do("tick", { stream: "dh1", actor }, {});
    await app.correlate();
    const first = await app.drain({ leaseMillis: 1 });
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
      .build();

    await app.do("enqueue", { stream: "j1", actor }, { delayMs: 100 });
    await app.correlate();
    await app.drain({ leaseMillis: 1 });
    expect(ran).toBe(0); // deferred by the payload-derived delay

    await sleep(150);
    const done = await app.drain({ leaseMillis: 1 });
    expect(ran).toBe(1);
    expect(done.acked.some((l) => l.stream === "j1")).toBe(true);
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
      .build();

    await app.do("tick", { stream: "now1", actor }, {});
    await app.correlate();
    const done = await app.drain({ leaseMillis: 1 });
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
      .build();

    await app.do("tick", { stream: "r1", actor }, {});
    await app.correlate();
    const done = await app.drain({ leaseMillis: 1 });
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
      .build();

    await app.do("tick", { stream: "fb1", actor }, {});
    await app.correlate();
    // The wrapper resolves the schedule on delivery; a bad shape fails the
    // reaction (blockOnError defaults on), so nothing is acked.
    const res = await app.drain({ leaseMillis: 1 });
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

    const app = act().withSlice(s).build();
    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();
    const first = await app.drain({ leaseMillis: 1 });
    expect(ran).toBe(0);
    expect(first.acked.length).toBe(0);
  });
});
