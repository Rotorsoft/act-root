import { z } from "zod";
import { act, dispose, slice, state, ZodEmpty } from "../src/index.js";

// Minimal counter to attach reactions to. Slice 1 doesn't yet wire
// per-lane controllers — these tests cover the builder type fanout,
// runtime stub bookkeeping, and validation gates.
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: ZodEmpty })
  .patch({ Incremented: (_, s) => ({ count: s.count + 1 }) })
  .on({ increment: ZodEmpty })
  .emit(() => ["Incremented", {}])
  .build();

describe("lanes (ACT-1103, slice 1)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("records declared lanes on the built Act and excludes the implicit default", () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000, streamLimit: 5 })
      .withLane({ name: "fast", cycleMs: 50 })
      .build();

    expect(app.lanes).toHaveLength(2);
    expect(app.lanes.map((l) => l.name)).toEqual(["slow", "fast"]);
    expect(app.lanes[0]).toMatchObject({
      name: "slow",
      leaseMillis: 30_000,
      streamLimit: 5,
    });
    expect(app.lanes[1]).toMatchObject({ name: "fast", cycleMs: 50 });
  });

  it("preserves today's single-lane behavior when no lane is declared", () => {
    const app = act().withState(Counter).build();
    expect(app.lanes).toEqual([]);
  });

  it("rejects re-declaring the reserved 'default' lane name", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "default" as never })
    ).toThrow(/reserved/);
  });

  it("rejects duplicate lane declarations", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "slow" })
        .withLane({ name: "slow" as never })
    ).toThrow(/already declared/);
  });

  it("accepts inline .to({lane}) when the lane was declared", () => {
    const app = act()
      .withState(Counter)
      .withLane({ name: "slow" })
      .on("Incremented")
      .do(function react() {
        return Promise.resolve();
      })
      .to({ target: "slow-target", lane: "slow" })
      .build();

    const reaction = app.registry.events.Incremented.reactions.get("react");
    expect(reaction?.resolver).toEqual({
      target: "slow-target",
      lane: "slow",
    });
  });

  it("rejects slice-declared lane references that weren't declared on the Act", () => {
    const stale = slice<typeof Counter>()
      .withState(Counter)
      .on("Incremented")
      .do(function staleHandler() {
        return Promise.resolve();
      })
      // Slice can't see the parent Act's lane set; loose-typed at slice
      // builder so this compiles. Runtime gate kicks in at act().build().
      .to({ target: "anywhere", lane: "ghost" })
      .build();

    expect(() => act().withSlice(stale).build()).toThrow(
      /undeclared lane "ghost"/
    );
  });

  it("allows slice-declared 'default' lane references even without withLane", () => {
    const ok = slice<typeof Counter>()
      .withState(Counter)
      .on("Incremented")
      .do(function defaultHandler() {
        return Promise.resolve();
      })
      .to({ target: "default-target", lane: "default" })
      .build();

    expect(() => act().withSlice(ok).build()).not.toThrow();
  });

  it("rejects ActOptions.onlyLanes references to undeclared lanes", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "slow" })
        .build({ onlyLanes: ["slow", "ghost" as never] })
    ).toThrow(/undeclared lane.*ghost/);
  });

  it("accepts onlyLanes that name only the implicit 'default' lane", () => {
    expect(() =>
      act()
        .withState(Counter)
        .build({ onlyLanes: ["default"] })
    ).not.toThrow();
  });

  it("accepts an empty onlyLanes array as a no-op (no validation tripped)", () => {
    expect(() =>
      act().withState(Counter).build({ onlyLanes: [] })
    ).not.toThrow();
  });

  it("skips lane validation for dynamic resolvers (their return is opaque)", () => {
    // Dynamic resolvers can return any lane name at runtime — the static
    // check only inspects literal-object resolvers. This guarantees a
    // dynamic resolver pointing at an undeclared lane doesn't trip the
    // build-time gate; the subscribe-time check (later slice) is where
    // that's caught.
    const dynamic = slice<typeof Counter>()
      .withState(Counter)
      .on("Incremented")
      .do(function dynamicHandler() {
        return Promise.resolve();
      })
      .to(() => ({ target: "x", lane: "ghost" }))
      .build();

    expect(() => act().withSlice(dynamic).build()).not.toThrow();
  });
});
