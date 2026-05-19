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

  it("compile-time-rejects slice .to({lane}) referencing an undeclared lane", () => {
    // Slices now carry their own TLanes union via .withLane(...). The
    // builder narrows .to({lane}) against that union, so an undeclared
    // lane name fails compile — runtime never sees it. The @ts-expect-error
    // markers below are the live assertion: they fail to compile if the
    // narrowing breaks.
    /* eslint-disable @typescript-eslint/no-unused-expressions */
    () =>
      slice<typeof Counter>()
        .withState(Counter)
        .on("Incremented")
        .do(function staleHandler() {
          return Promise.resolve();
        })
        // @ts-expect-error "ghost" not declared on this slice
        .to({ target: "anywhere", lane: "ghost" })
        .build();
  });

  it("type-checks slice .to({lane}) against the slice's own withLane declarations", () => {
    const WebhookSlice = slice<typeof Counter>()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000 })
      .on("Incremented")
      .do(function ship() {
        return Promise.resolve();
      })
      .to({ target: "outbox", lane: "slow" })
      .build();

    expect(WebhookSlice.lanes).toEqual([{ name: "slow", leaseMillis: 30_000 }]);
    const app = act().withState(Counter).withSlice(WebhookSlice).build();
    expect(app.lanes).toEqual([{ name: "slow", leaseMillis: 30_000 }]);
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

  it("rejects re-declaring 'default' on a slice", () => {
    expect(() =>
      slice<typeof Counter>()
        .withState(Counter)
        .withLane({ name: "default" as never })
    ).toThrow(/reserved/);
  });

  it("rejects duplicate slice-declared lane names", () => {
    expect(() =>
      slice<typeof Counter>()
        .withState(Counter)
        .withLane({ name: "slow" })
        .withLane({ name: "slow" as never })
    ).toThrow(/already declared/);
  });

  it("rejects slice/Act lane configs that disagree on timing", () => {
    const sliceA = slice<typeof Counter>()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000 })
      .build();

    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "slow", leaseMillis: 60_000 })
        .withSlice(sliceA)
        .build()
    ).toThrow(/different config/);
  });

  it("accepts matching slice/Act lane configs (idempotent merge)", () => {
    const sliceA = slice<typeof Counter>()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000 })
      .build();

    const app = act()
      .withState(Counter)
      .withLane({ name: "slow", leaseMillis: 30_000 })
      .withSlice(sliceA)
      .build();

    expect(app.lanes).toHaveLength(1);
    expect(app.lanes[0]).toMatchObject({ name: "slow", leaseMillis: 30_000 });
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

  it("type-checks dynamic resolvers' lane return against the slice's TLanes", () => {
    // Dynamic resolvers thread the same TLanes generic — the function's
    // return shape is `Resolved<TLanes> | undefined`, so an undeclared
    // lane fails compile. The @ts-expect-error below is the live assertion.
    /* eslint-disable @typescript-eslint/no-unused-expressions */
    () =>
      slice<typeof Counter>()
        .withState(Counter)
        .on("Incremented")
        .do(function dynamicHandler() {
          return Promise.resolve();
        })
        // @ts-expect-error dynamic resolver returns lane "ghost" not in declared set
        .to(() => ({ target: "x", lane: "ghost" }));

    // Positive case: declared lane in dynamic resolver compiles cleanly.
    const ok = slice<typeof Counter>()
      .withState(Counter)
      .withLane({ name: "slow" })
      .on("Incremented")
      .do(function dynamicSlow() {
        return Promise.resolve();
      })
      .to((event) => ({ target: `slow-${event.stream}`, lane: "slow" }))
      .build();

    expect(() => act().withSlice(ok).build()).not.toThrow();
  });
});
