import { z } from "zod";
import {
  act,
  cache,
  dispose,
  projection,
  state,
  ValidationError,
} from "../src/index.js";
import type { CacheEntry } from "../src/types/index.js";

/**
 * ACT-1238 — opt-in `ActOptions.validateFoldedState`.
 *
 * A reducer that produces schema-violating state (the calculator
 * divide-by-zero NaN class, #1230) is trusted-total today: the framework
 * validates action inputs and emitted events, but never the folded
 * state. With the flag ON, the fold path parses the merged state against
 * its declared Zod schema after every reduction and throws a
 * ValidationError at the triggering event. With the flag OFF (default),
 * behavior and the hot path are unchanged.
 */
describe("validateFoldedState", () => {
  // A state whose declared schema forbids NaN, and a reducer that
  // deliberately produces NaN on `divide`. `z.number()` rejects NaN.
  const calc = () =>
    state({ Calc: z.object({ result: z.number() }) })
      .init(() => ({ result: 0 }))
      .emits({
        added: z.object({ by: z.number() }),
        dividedByZero: z.object({}),
      })
      .patch({
        added: (e, s) => ({ result: s.result + e.data.by }),
        // Divide-by-zero: produces NaN, which violates z.number().
        dividedByZero: () => ({ result: 0 / 0 }),
      })
      .on({ add: z.object({ by: z.number() }) })
      .emit((a) => ["added", { by: a.by }])
      .on({ divide: z.object({}) })
      .emit(() => ["dividedByZero", {}])
      .build();

  const actor = { id: "u1", name: "Alice" };

  afterEach(async () => {
    await dispose()();
  });

  it("throws at the triggering event when a reducer produces schema-violating state", async () => {
    const app = act().withState(calc()).build({ validateFoldedState: true });
    await app.do("add", { stream: "c1", actor }, { by: 5 });
    await expect(
      app.do("divide", { stream: "c1", actor }, {})
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("names the state and the triggering event in the error", async () => {
    const app = act().withState(calc()).build({ validateFoldedState: true });
    let caught: unknown;
    try {
      await app.do("divide", { stream: "c2", actor }, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const err = caught as ValidationError;
    expect(err.target).toContain("Calc");
    expect(err.target).toContain("dividedByZero");
  });

  it("does NOT throw and produces the bad state when the flag is off (default)", async () => {
    const app = act().withState(calc()).build();
    const [snap] = await app.do("divide", { stream: "c3", actor }, {});
    expect(Number.isNaN((snap.state as { result: number }).result)).toBe(true);
  });

  it("leaves a well-behaved app unchanged with the flag on (no spurious throws)", async () => {
    const app = act().withState(calc()).build({ validateFoldedState: true });
    for (let i = 0; i < 25; i++)
      await app.do("add", { stream: "ok", actor }, { by: 1 });
    const snap = await app.load("Calc", "ok");
    expect((snap.state as { result: number }).result).toBe(25);
  });

  it("catches the bad state on cold replay, not only on the committing action", async () => {
    // Commit the bad event WITHOUT the flag (so it lands in the shared
    // singleton store), then cold-replay WITH the flag to prove the
    // load() fold path validates. A time-travel (`asOf`) load bypasses
    // the cache and replays every event from the store, so the reducer
    // actually runs — a warm cache hit would fold nothing, so there would
    // be nothing to validate (the flag guards reductions, not reads).
    const writer = act().withState(calc()).build();
    await writer.do("divide", { stream: "replay", actor }, {});

    const reader = act().withState(calc()).build({ validateFoldedState: true });
    await expect(
      reader.load("Calc", "replay", undefined, { before: 1_000_000 })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates folded projection state (make_fold_handler) on replay", async () => {
    // The projection fold is a distinct reduction site. Commit the bad
    // event with the flag OFF (a plain writer), then run a fold projection
    // WITH the flag on: folding the historical bad event throws a
    // ValidationError inside the batch handler, which blocks the stream.
    type Row = CacheEntry<{ result: number }>;
    const table = new Map<string, Row>();
    const errors: string[] = [];

    const writer = act().withState(calc()).build();
    await writer.do("divide", { stream: "p1", actor }, {});
    // Cold the shared cache so the fold handler's first-sight load
    // actually replays the bad event through the reducer (a warm hit
    // would fold nothing — the flag guards reductions, not reads).
    await cache().invalidate("p1");

    const proj = projection("calc_read")
      .of(calc())
      .flush(async (rows) => {
        for (const row of rows) table.set(row.stream, row as Row);
      })
      .build();
    const app = act()
      .withState(calc())
      .withProjection(proj)
      .build({ validateFoldedState: true });
    app.on("blocked", (leases) => {
      for (const l of leases) if (l.error) errors.push(l.error);
    });

    await app.correlate();
    // Drive drain to quiescence with a tiny lease so the batch handler's
    // throws exhaust the retry budget and the stream lands blocked.
    for (let i = 0; i < 10; i++) {
      const d = await app.drain({ leaseMillis: 1, eventLimit: 1_000 });
      if (
        d.acked.length === 0 &&
        d.blocked.length === 0 &&
        d.fetched.length === 0
      )
        break;
    }

    // The fold handler threw the ValidationError during the reduction,
    // blocking the stream; the message names the state and the event.
    expect(errors.some((e) => e.includes("Calc.dividedByZero"))).toBe(true);
    // The bad row never made it into the read table.
    expect(table.has("p1")).toBe(false);
  });
});
