/**
 * A target is served by exactly one thing.
 *
 * #1467 — the duplicate-target guard covered projection-vs-projection but not
 * the third claimant: an ordinary reaction pointed at a target a batch handler
 * or fold already owns. The drain dispatches such a stream through the batch
 * handler and nothing else, so the reaction never ran — silently — while the
 * fold cold-loaded the foreign event's stream as its own state.
 *
 * #1469 — re-registering the SAME projection object is a no-op, not a
 * duplicate. Both sibling paths already treated it that way; the fold path
 * threw.
 */
import { act, dispose, projection, state } from "@rotorsoft/act";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({}) })
  .patch({ Incremented: (_, s) => ({ count: s.count + 1 }) })
  .on({ bump: z.object({}) })
  .emit(() => ["Incremented", {}])
  .build();

const Other = state({ Other: z.object({ pings: z.number() }) })
  .init(() => ({ pings: 0 }))
  .emits({ Pinged: z.object({}) })
  .patch({ Pinged: (_, s) => ({ pings: s.pings + 1 }) })
  .on({ ping: z.object({}) })
  .emit(() => ["Pinged", {}])
  .build();

const fold_projection = (target: string) =>
  projection(target)
    .of(Counter)
    .flush(async () => {})
    .build();

const batch_projection = (target: string) =>
  projection(target)
    .batch(async function sink() {})
    .build();

afterEach(async () => {
  await dispose()("EXIT").catch(() => {});
});

describe("a reaction may not target a projection's target (#1467)", () => {
  it("rejects a reaction pointed at a fold's target", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold_projection("counters"))
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "counters" })
        .build()
    ).toThrow(/conflicts with the projection that already serves it/);
  });

  it("rejects a reaction pointed at a batch projection's target", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(batch_projection("sink"))
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "sink" })
        .build()
    ).toThrow(/conflicts with the projection that already serves it/);
  });

  it("rejects it regardless of registration order", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "counters" })
        .withProjection(fold_projection("counters"))
        .build()
    ).toThrow(/conflicts with the projection that already serves it/);
  });

  it("allows a projection's OWN reactions on its target", () => {
    // A projection that declares per-event handlers AND a batch handler is
    // the documented pattern the batch handler exists for.
    const p = projection("mixed")
      .on({ Incremented: z.object({}) })
      .do(async function handleIncremented() {})
      .batch(async function sink() {})
      .build();
    expect(() =>
      act().withState(Counter).withProjection(p).build()
    ).not.toThrow();
  });

  it("allows a reaction on a target no projection serves", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold_projection("counters"))
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "elsewhere" })
        .build()
    ).not.toThrow();
  });
});

describe("re-registering one projection is idempotent (#1469)", () => {
  it("accepts the same fold projection registered twice", () => {
    const p = fold_projection("counters");
    expect(() =>
      act().withState(Counter).withProjection(p).withProjection(p).build()
    ).not.toThrow();
  });

  it("accepts the same batch projection registered twice", () => {
    const p = batch_projection("sink");
    expect(() =>
      act().withState(Counter).withProjection(p).withProjection(p).build()
    ).not.toThrow();
  });

  it("still rejects two DIFFERENT projections on one target", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(fold_projection("counters"))
        .withProjection(fold_projection("counters"))
        .build()
    ).toThrow(/Duplicate projection target/);
  });

  it("still rejects a fold and a batch projection on one target", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withProjection(batch_projection("counters"))
        .withProjection(fold_projection("counters"))
        .build()
    ).toThrow(/Duplicate projection target/);
  });
});
