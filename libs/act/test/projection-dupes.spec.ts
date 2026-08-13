import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { act, dispose, projection, state } from "../src/index.js";

/**
 * #1439 / #1440 — two ways a projection could be registered twice, both
 * silent, both frozen into the registry at build.
 *
 * #1439: `merge_projection`'s `_p` rename resolves a NAME collision between
 * two different handlers. It had no identity check, so the SAME reaction
 * object arriving twice was treated as a collision and registered again under
 * `name_p` — the handler ran twice per event, forever. Not the at-least-once
 * redelivery contract: a structural duplicate, deterministic, unsignalled.
 *
 * #1440: a target may be served by one batch handler OR one state projection.
 * `register_batch_handler` early-returns on `!proj.batchHandler`, and a fold
 * projection has a target but no batch handler, so the fold path bypassed the
 * guard in both directions and `make_batch_handlers` let the last
 * registration win. Only batch x batch of the four pairings was guarded.
 */

const Inc = z.object({ by: z.number() });
const Tag = z.object({ label: z.string() });

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Incremented: Inc })
  .patch({ Incremented: (e, s) => ({ n: s.n + e.data.by }) })
  .on({ increment: Inc })
  .emit((a) => ["Incremented", a])
  .build();

const Tagger = state({ Tagger: z.object({ label: z.string() }) })
  .init(() => ({ label: "" }))
  .emits({ Tagged: Tag })
  .patch({ Tagged: (e) => ({ label: e.data.label }) })
  .on({ tag: Tag })
  .emit((a) => ["Tagged", a])
  .build();

const actor = { id: "a", name: "a" };

describe("the same projection registered twice (#1439)", () => {
  afterEach(async () => {
    await dispose()();
  });

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

  it("runs its handler once per event, not twice", async () => {
    const { p, calls } = make();
    const builder = act()
      .withState(Counter)
      .withProjection(p)
      .withProjection(p);
    const app = builder.build();
    const keys = [...(builder.events.Incremented?.reactions.keys() ?? [])];

    await app.do("increment", { stream: "d1", actor }, { by: 1 });
    await app.correlate();
    await app.drain();

    expect({ keys, calls: calls() }).toEqual({
      keys: ["handleIncremented"],
      calls: 1,
    });
    await app.shutdown();
  });

  it("control — registered once behaves identically", async () => {
    const { p, calls } = make();
    const builder = act().withState(Counter).withProjection(p);
    const app = builder.build();
    const keys = [...(builder.events.Incremented?.reactions.keys() ?? [])];

    await app.do("increment", { stream: "d2", actor }, { by: 1 });
    await app.correlate();
    await app.drain();

    expect({ keys, calls: calls() }).toEqual({
      keys: ["handleIncremented"],
      calls: 1,
    });
    await app.shutdown();
  });

  it("control — two DIFFERENT handlers sharing a name still dedupe via _p", async () => {
    // The `_p` rename exists for this case and must keep working: two
    // genuinely distinct handlers that happen to share a function name.
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

    // And both are live: the `_p` entry is a real second handler, not a
    // registry artifact — which is exactly what makes it wrong to create
    // one for a repeat registration of the SAME handler.
    const app = builder.build();
    await app.do("increment", { stream: "d4", actor }, { by: 1 });
    await app.correlate();
    await app.drain();
    await app.drain();
    expect({ a, b }).toEqual({ a: 1, b: 1 });
    await app.shutdown();
  });
});

describe("one target, one owner (#1440)", () => {
  afterEach(async () => {
    await dispose()();
  });

  const batchProj = (target: string, seen?: string[]) =>
    projection(target)
      .on({ Incremented: Inc })
      .do(async function hb() {})
      .batch((async (events: any) => {
        for (const e of events) seen?.push(String(e.name));
      }) as never)
      .build();

  const foldProj = (target: string) =>
    projection(target)
      .of(Counter)
      .flush(async () => {})
      .build();

  const DUP = /Duplicate projection target/;

  it("rejects batch + batch", () => {
    const other = projection("tally")
      .on({ Incremented: Inc })
      .do(async function h2() {})
      .batch(async () => {})
      .build();
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(batchProj("tally"))
        .withProjection(other)
        .build()
    ).toThrow(DUP);
  });

  it("rejects batch + fold", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(batchProj("tally"))
        .withProjection(foldProj("tally"))
        .build()
    ).toThrow(DUP);
  });

  it("rejects fold + batch — the reverse order too", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(foldProj("tally"))
        .withProjection(batchProj("tally"))
        .build()
    ).toThrow(DUP);
  });

  it("rejects fold + fold", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(foldProj("tally"))
        .withProjection(foldProj("tally"))
        .build()
    ).toThrow(DUP);
  });

  it("refuses the cross-state hijack at build instead of corrupting the read model", () => {
    // Previously this built silently, the batch projection went dead, and
    // the Counter fold received Tagger aggregates — foreign state written
    // into the counters read table.
    const tagBatch = projection("mixed")
      .on({ Tagged: Tag })
      .do(async function hTag() {})
      .batch(async () => {})
      .build();
    expect(() =>
      act()
        .withState(Counter)
        .withState(Tagger)
        .withProjection(tagBatch)
        .withProjection(foldProj("mixed"))
        .build()
    ).toThrow(DUP);
  });

  it("control — distinct targets coexist, and both run", async () => {
    const seen: string[] = [];
    const app = act()
      .withState(Counter)
      .withProjection(batchProj("batch-target", seen))
      .withProjection(foldProj("fold-target"))
      .build();

    await app.do("increment", { stream: "d3", actor }, { by: 1 });
    await app.correlate();
    await app.drain({ eventLimit: 100 });

    expect(seen).toContain("Incremented");
    await app.shutdown();
  });
});
