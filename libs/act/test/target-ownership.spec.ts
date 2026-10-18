/**
 * Who may own a handler name or a target.
 *
 * - Reactions and projection handlers are keyed by name; two different
 *   handlers sharing a name on one event would overwrite each other, so the
 *   build throws.
 * - A target is served by exactly one thing: one batch handler or one state
 *   projection, and no ordinary reaction on a projection's target. The drain
 *   dispatches such a stream through the projection alone, so anything else
 *   pointed at it would silently never run.
 * - Registering the same projection object twice is a no-op, not a duplicate.
 * - A dynamic `.to(fn)` target is only known at correlate, which applies the
 *   same rule by logging and skipping: a throw there would pin the
 *   checkpoint for the whole app.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { act, dispose, log, projection, slice, state } from "../src/index.js";
import { sandbox } from "../src/test/index.js";

const Inc = z.object({ by: z.number() });
const Ping = z.object({ label: z.string() });

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: Inc })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.by }) })
  .on({ increment: Inc })
  .emit("Incremented")
  .build();

const Other = state({ Other: z.object({ label: z.string() }) })
  .init(() => ({ label: "" }))
  .emits({ Pinged: Ping })
  .patch({ Pinged: ({ data }) => ({ label: data.label }) })
  .on({ ping: Ping })
  .emit("Pinged")
  .build();

const actor = { id: "a", name: "a" };

/** A state projection (fold) of Counter on `target`. */
const fold = (target: string, rows?: unknown[]) =>
  projection(target)
    .of(Counter)
    .flush(async (r) => {
      rows?.push(...r.map((x) => ({ stream: x.stream, state: x.state })));
    })
    .build();

/** A batch projection on `target`, recording the event names it sees. */
const batch = (target: string, seen?: string[]) =>
  projection(target)
    .on({ Incremented: Inc })
    .do(async function hb() {})
    .batch((async (events: any) => {
      for (const e of events) seen?.push(String(e.name));
    }) as never)
    .build();

/** A per-event projection on `target`. */
const per_event = (target: string) =>
  projection(target)
    .on({ Pinged: Ping })
    .do(async function onPingedProj() {})
    .build();

const SERVED = /conflicts with the projection that already serves it/;
const DUP = /Duplicate projection target/;

afterEach(async () => {
  await dispose()("EXIT").catch(() => {});
});

describe("duplicate reaction names", () => {
  it("throws on duplicate reaction names within one slice", () => {
    expect(() =>
      slice()
        .withState(Counter)
        .on("Incremented")
        .do(async function track() {})
        .on("Incremented")
        .do(async function track() {})
    ).toThrow('Duplicate reaction "track" for event "Incremented"');
  });

  it("throws on duplicate reaction names within inline act().on().do()", () => {
    expect(() =>
      act()
        .withState(Counter)
        .on("Incremented")
        .do(async function track() {})
        .on("Incremented")
        .do(async function track() {})
    ).toThrow('Duplicate reaction "track" for event "Incremented"');
  });

  it("throws when two slices register same-named reactions on one event", () => {
    const on_inc = () =>
      slice()
        .withState(Counter)
        .on("Incremented")
        .do(async function onInc() {})
        .build();
    expect(() => act().withSlice(on_inc()).withSlice(on_inc())).toThrow(
      'Duplicate reaction "onInc" for event "Incremented"'
    );
  });

  it("throws on duplicate projection handler names", () => {
    expect(() =>
      projection()
        .on({ Incremented: Inc })
        .do(async function apply() {})
        .on({ Incremented: Inc })
        .do(async function apply() {})
    ).toThrow('Duplicate projection handler "apply" for event "Incremented"');
  });

  it("allows distinct reaction names on the same event (no false positive)", () => {
    const s = slice()
      .withState(Counter)
      .on("Incremented")
      .do(async function trackA() {})
      .on("Incremented")
      .do(async function trackB() {})
      .build();
    expect(s.events.Incremented.reactions.size).toBe(2);
  });
});

describe("the same projection registered twice", () => {
  const make = () => {
    let calls = 0;
    const p = projection("tally")
      .on({ Incremented: Inc })
      .do(async function handleIncremented() {
        calls++;
      })
      .build();
    return { p, calls: () => calls };
  };

  const run = async (twice: boolean, stream: string) => {
    const { p, calls } = make();
    const once = act().withState(Counter).withProjection(p);
    const builder = twice ? once.withProjection(p) : once;
    const app = builder.build();
    const keys = [...(builder.events.Incremented?.reactions.keys() ?? [])];
    await app.do("increment", { stream, actor }, { by: 1 });
    await app.correlate();
    await app.drain();
    return { keys, calls: calls() };
  };

  it("runs its handler once per event, not twice", async () => {
    expect(await run(true, "d1")).toEqual({
      keys: ["handleIncremented"],
      calls: 1,
    });
  });

  it("control — registered once behaves identically", async () => {
    expect(await run(false, "d2")).toEqual({
      keys: ["handleIncremented"],
      calls: 1,
    });
  });

  it("control — two DIFFERENT handlers sharing a name still dedupe via _p", async () => {
    // The `_p` rename exists for this case: two genuinely distinct handlers
    // that happen to share a function name. Both stay live.
    let a = 0;
    let b = 0;
    const p1 = projection("t1")
      .on({ Incremented: Inc })
      .do(async function apply() {
        a++;
      })
      .build();
    const p2 = projection("t2")
      .on({ Incremented: Inc })
      .do(async function apply() {
        b++;
      })
      .build();

    const builder = act()
      .withState(Counter)
      .withProjection(p1)
      .withProjection(p2);
    const keys = [...(builder.events.Incremented?.reactions.keys() ?? [])];
    expect(keys).toEqual(["apply", "apply_p"]);

    const app = builder.build();
    await app.do("increment", { stream: "d4", actor }, { by: 1 });
    await app.correlate();
    await app.drain();
    await app.drain();
    expect({ a, b }).toEqual({ a: 1, b: 1 });
  });
});

describe("re-registering one projection is idempotent", () => {
  it("accepts the same fold projection registered twice", () => {
    const p = fold("counters");
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(p)
        .withProjection(p)
        .build({ autoSettle: false })
    ).not.toThrow();
  });

  it("accepts the same batch projection registered twice", () => {
    const p = batch("sink");
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(p)
        .withProjection(p)
        .build({ autoSettle: false })
    ).not.toThrow();
  });
});

describe("one target, one owner", () => {
  it("rejects batch + batch", () => {
    const other = projection("tally")
      .on({ Incremented: Inc })
      .do(async function h2() {})
      .batch(async () => {})
      .build();
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(batch("tally"))
        .withProjection(other)
        .build({ autoSettle: false })
    ).toThrow(DUP);
  });

  it("rejects batch + fold", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(batch("tally"))
        .withProjection(fold("tally"))
        .build({ autoSettle: false })
    ).toThrow(DUP);
  });

  it("rejects fold + batch — the reverse order too", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(fold("tally"))
        .withProjection(batch("tally"))
        .build({ autoSettle: false })
    ).toThrow(DUP);
  });

  it("rejects fold + fold", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(fold("tally"))
        .withProjection(fold("tally"))
        .build({ autoSettle: false })
    ).toThrow(DUP);
  });

  it("refuses the cross-state hijack at build instead of corrupting the read model", () => {
    // Otherwise the batch projection goes dead and the Counter fold receives
    // Other aggregates: foreign state written into the counters read model.
    const ping_batch = projection("mixed")
      .on({ Pinged: Ping })
      .do(async function hPing() {})
      .batch(async () => {})
      .build();
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(ping_batch)
        .withProjection(fold("mixed"))
        .build({ autoSettle: false })
    ).toThrow(DUP);
  });

  it("control — distinct targets coexist, and both run", async () => {
    const seen: string[] = [];
    const app = act()
      .withState(Counter)
      .withProjection(batch("batch-target", seen))
      .withProjection(fold("fold-target"))
      .build({ autoSettle: false });
    await app.do("increment", { stream: "d3", actor }, { by: 1 });
    await app.correlate();
    await app.drain({ eventLimit: 100 });
    expect(seen).toContain("Incremented");
  });
});

describe("a reaction may not target a projection's target", () => {
  it("rejects a reaction pointed at a fold's target", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold("counters"))
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "counters" })
        .build({ autoSettle: false })
    ).toThrow(SERVED);
  });

  it("rejects a reaction pointed at a batch projection's target", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(batch("sink"))
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "sink" })
        .build({ autoSettle: false })
    ).toThrow(SERVED);
  });

  it("rejects it regardless of registration order", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "counters" })
        .withProjection(fold("counters"))
        .build({ autoSettle: false })
    ).toThrow(SERVED);
  });

  it("allows a projection's OWN reactions on its target", () => {
    // Per-event handlers plus a batch handler is the documented pattern the
    // batch handler exists for.
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(batch("mixed"))
        .build({ autoSettle: false })
    ).not.toThrow();
  });

  it("allows a reaction on a target no projection serves", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold("counters"))
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "elsewhere" })
        .build({ autoSettle: false })
    ).not.toThrow();
  });
});

describe("a per-event projection may not share a served target", () => {
  it("rejects a per-event projection on a fold's target", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold("counters"))
        .withProjection(per_event("counters"))
        .build({ autoSettle: false })
    ).toThrow(SERVED);
  });

  it("rejects a per-event projection on a batch projection's target", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(batch("sink"))
        .withProjection(per_event("sink"))
        .build({ autoSettle: false })
    ).toThrow(SERVED);
  });

  it("rejects it when the two arrive through different slices", () => {
    const folds = slice()
      .withState(Counter)
      .withProjection(fold("counters"))
      .build();
    const pings = slice()
      .withState(Other)
      .withProjection(per_event("counters"))
      .build();
    expect(() =>
      act().withSlice(folds).withSlice(pings).build({ autoSettle: false })
    ).toThrow(SERVED);
  });

  it("still allows per-event projections to share a target nobody serves", () => {
    const counted = projection("feed")
      .on({ Incremented: Inc })
      .do(async function onIncrementedProj() {})
      .build();
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(counted)
        .withProjection(per_event("feed"))
        .build({ autoSettle: false })
    ).not.toThrow();
  });
});

describe("a dynamic resolution onto a projection's target", () => {
  it("is skipped, and never feeds the projection a foreign aggregate", async () => {
    const rows: unknown[] = [];
    const { app, dispose } = await sandbox(
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold("counters", rows))
        .on("Pinged")
        .do(async function onPinged() {})
        .to(() => ({ target: "counters" })),
      { actOptions: { autoSettle: false } }
    );
    await app.do("increment", { stream: "c1", actor }, { by: 1 });
    await app.do("ping", { stream: "o1", actor }, { label: "ping" });
    for (let i = 0; i < 2; i++) {
      await app.correlate();
      await app.drain();
    }
    // The projection holds its own aggregate and nothing else.
    expect(rows).toEqual([{ stream: "c1", state: { count: 1 } }]);
    await dispose();
  });

  it("says so — a skipped misrouting is not silent", async () => {
    // Its own target: the report is deduped per stream|handler|event, so a
    // test reusing "counters" would be correctly suppressed by the case above.
    const errors: string[] = [];
    const real = log().error.bind(log());
    (log() as unknown as { error: unknown }).error = (e: unknown) => {
      errors.push(e instanceof Error ? e.message : String(e));
    };
    const { app, dispose } = await sandbox(
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold("counters-solo"))
        .on("Pinged")
        .do(async function onPinged() {})
        .to(() => ({ target: "counters-solo" })),
      { actOptions: { autoSettle: false } }
    );
    await app.do("ping", { stream: "o1", actor }, { label: "ping" });
    for (let i = 0; i < 2; i++) {
      await app.correlate();
      await app.drain();
    }
    (log() as unknown as { error: unknown }).error = real;

    const reported = errors.find((m) => /a projection already serves/.test(m));
    expect(reported).toMatch(/Reaction "onPinged" on "Pinged"/);
    expect(reported).toMatch(/counters-solo/);
    expect(reported).toMatch(/rejected at build/);
    await dispose();
  });

  it("does not stall correlation for everything else", async () => {
    let healthy = 0;
    const { app, dispose } = await sandbox(
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold("counters"))
        .on("Pinged")
        .do(async function bad() {})
        .to(() => ({ target: "counters" }))
        .on("Incremented")
        .do(async function good() {
          healthy++;
        })
        .to(() => ({ target: "healthy-out" })),
      { actOptions: { autoSettle: false } }
    );
    await app.do("ping", { stream: "o1", actor }, { label: "poison" });
    await app.do("increment", { stream: "c1", actor }, { by: 1 });
    for (let i = 0; i < 2; i++) {
      await app.correlate();
      await app.drain();
    }
    // A neighbour's reaction still runs: the checkpoint is not pinned.
    expect(healthy).toBe(1);
    await dispose();
  });
});
