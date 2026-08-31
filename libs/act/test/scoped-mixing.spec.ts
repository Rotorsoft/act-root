/**
 * A process resolves its ports one way (#1597).
 *
 * A scoped Act reads `store()`/`cache()` from an ambient frame; a singleton
 * one reads the process-wide adapters. With both alive, which store a call
 * reaches depends on the frame it happens to be running in — a singleton Act
 * dispatched from inside a scoped handler wrote to that tenant's store. Rather
 * than pick a winner for that, the combination is refused at build.
 */
import { act, InMemoryCache, InMemoryStore, state } from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Bumped: z.object({}) })
  .patch({ Bumped: (_, s) => ({ n: s.n + 1 }) })
  .on({ bump: z.object({}) })
  .emit(() => ["Bumped", {}])
  .build();

const singleton = () => act().withState(Counter).build();
const scoped = () =>
  act()
    .withState(Counter)
    .build({
      scoped: { store: new InMemoryStore(), cache: new InMemoryCache() },
    });

describe("a process does not mix scoped and singleton Acts (#1597)", () => {
  it("refuses a scoped Act while a singleton one is live", async () => {
    const app = singleton();
    expect(() => scoped()).toThrow(/Cannot build a scoped Act/);
    await app.shutdown();
  });

  it("refuses a singleton Act while a scoped one is live", async () => {
    const app = scoped();
    expect(() => singleton()).toThrow(/Cannot build a singleton Act/);
    await app.shutdown();
  });

  it("allows either kind once the other has shut down", async () => {
    const first = singleton();
    await first.shutdown();
    const second = scoped();
    await second.shutdown();
    // and back again — the count tracks live Acts, not ever-built ones
    const third = singleton();
    await third.shutdown();
    expect(true).toBe(true);
  });

  it("allows many Acts of the same kind", async () => {
    const a = singleton();
    const b = singleton();
    expect(() => scoped()).toThrow();
    await a.shutdown();
    // b still holds the process
    expect(() => scoped()).toThrow();
    await b.shutdown();
    const c = scoped();
    await c.shutdown();
  });

  it("gives the slot back once, however often shutdown is called", async () => {
    // `shutdown()` memoizes its promise, so repeated calls release once —
    // several releases for one Act would leave the count negative, which the
    // next Act of the other kind would silently inherit as headroom.
    const app = singleton();
    await app.shutdown();
    await app.shutdown();
    await app.shutdown();
    const s = scoped();
    expect(() => singleton()).toThrow(/Cannot build a singleton Act/);
    await s.shutdown();
  });

  it("does not hold a slot when the build itself throws", async () => {
    // The Act is constructed before the registry is classified, so a build
    // that fails after construction must not leave the process pinned.
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "fast" })
        .on("Bumped")
        .do(async function onBumped() {})
        .to({ target: "t", lane: "typo" as "fast" })
        .build()
    ).toThrow(/undeclared lane/);
    const app = scoped();
    await app.shutdown();
  });
});
