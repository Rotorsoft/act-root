import { z } from "zod";
import { act, projection, slice, state } from "../src/index.js";

/**
 * ACT-979 — duplicate reaction/projection handler-name guard.
 *
 * Reaction/projection handlers are keyed in the registry by `handler.name`.
 * Before this guard, two handlers sharing a function name (a realistic
 * copy-paste, especially across independently-authored slices) silently
 * overwrote each other — last write wins — so one reaction never fired.
 * That silent data loss is now a build-time throw, consistent with the
 * existing "Duplicate action" / "Duplicate batch handler" guards.
 */
describe("ACT-979 duplicate reaction names", () => {
  const schema = z.object({ count: z.number() });

  const Thing = state({ Thing: schema })
    .init(() => ({ count: 0 }))
    .emits({ Incremented: z.object({ by: z.number() }) })
    .patch({ Incremented: (e, s) => ({ count: s.count + e.data.by }) })
    .on({ increment: z.object({ by: z.number() }) })
    .emit((a) => ["Incremented", { by: a.by }])
    .build();

  it("throws on duplicate reaction names within one slice", () => {
    expect(() =>
      slice()
        .withState(Thing)
        .on("Incremented")
        .do(function track() {
          return Promise.resolve();
        })
        .on("Incremented")
        .do(function track() {
          return Promise.resolve();
        })
    ).toThrow('Duplicate reaction "track" for event "Incremented"');
  });

  it("throws on duplicate reaction names within inline act().on().do()", () => {
    expect(() =>
      act()
        .withState(Thing)
        .on("Incremented")
        .do(function track() {
          return Promise.resolve();
        })
        .on("Incremented")
        .do(function track() {
          return Promise.resolve();
        })
    ).toThrow('Duplicate reaction "track" for event "Incremented"');
  });

  it("throws when two slices register same-named reactions on one event", () => {
    const SliceA = slice()
      .withState(Thing)
      .on("Incremented")
      .do(function onInc() {
        return Promise.resolve();
      })
      .build();

    const SliceB = slice()
      .withState(Thing)
      .on("Incremented")
      .do(function onInc() {
        return Promise.resolve();
      })
      .build();

    expect(() => act().withSlice(SliceA).withSlice(SliceB)).toThrow(
      'Duplicate reaction "onInc" for event "Incremented"'
    );
  });

  it("throws on duplicate projection handler names", () => {
    expect(() =>
      projection()
        .on({ Incremented: z.object({ by: z.number() }) })
        .do(function apply() {
          return Promise.resolve();
        })
        .on({ Incremented: z.object({ by: z.number() }) })
        .do(function apply() {
          return Promise.resolve();
        })
    ).toThrow('Duplicate projection handler "apply" for event "Incremented"');
  });

  it("allows distinct reaction names on the same event (no false positive)", () => {
    const s = slice()
      .withState(Thing)
      .on("Incremented")
      .do(function trackA() {
        return Promise.resolve();
      })
      .on("Incremented")
      .do(function trackB() {
        return Promise.resolve();
      })
      .build();

    expect(s.events.Incremented.reactions.size).toBe(2);
  });
});
