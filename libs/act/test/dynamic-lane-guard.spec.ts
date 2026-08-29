import { z } from "zod";
import { act, log, type Query, state, ZodEmpty } from "../src/index.js";
import { sandbox } from "../src/test/index.js";

/**
 * The lane guards are the third and fourth members of the #1563 family: a
 * build-time check that only ever sees a static `.to({lane})`, because a
 * `.to(fn)` lane is a function until an event arrives (#1564, #1567).
 *
 * Correlate resolves the lane, so correlate is where the same rules apply.
 * Log and continue, never throw — a throw inside correlate pins the
 * checkpoint for the whole app (#1420).
 *
 * On lane *names*, `TLanes` already rejects an undeclared lane at compile
 * time for the static and dynamic forms alike, so #1564 is a backstop for
 * callers who bypass the types: JavaScript consumers, a cast, or a helper
 * whose return type widens `lane` to `string`. The casts below are how a
 * test reaches that path deliberately — they are not the ordinary shape.
 */

const actor = { id: "a", name: "a" };

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Pinged: ZodEmpty, Bumped: ZodEmpty })
  .patch({
    Pinged: (_e, s) => ({ count: s.count }),
    Bumped: (_e, s) => ({ count: s.count + 1 }),
  })
  .on({ ping: ZodEmpty })
  .emit(() => ["Pinged", {}])
  .on({ bump: ZodEmpty })
  .emit(() => ["Bumped", {}])
  .build();

/** Capture `log().error` for the duration of `fn`. */
const captured = async (fn: () => Promise<void>): Promise<string[]> => {
  const errors: string[] = [];
  const real = log().error.bind(log());
  (log() as unknown as { error: unknown }).error = (e: unknown) => {
    errors.push(e instanceof Error ? e.message : String(e));
  };
  try {
    await fn();
  } finally {
    (log() as unknown as { error: unknown }).error = real;
  }
  return errors;
};

describe("a dynamic resolution onto an undeclared lane (#1564)", () => {
  it("CONTROL — the static form is still rejected at build", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "fast" })
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "t", lane: "typo" as "fast" })
        .build()
    ).toThrow(/undeclared lane "typo"/);
  });

  it("still runs the reaction instead of stranding the stream", async () => {
    let ran = 0;
    const { app, dispose } = await sandbox(
      act()
        .withState(Counter)
        .withLane({ name: "fast" })
        .on("Pinged")
        .do(async function onPinged() {
          ran++;
        })
        .to(() => ({ target: "t", lane: "typo" as "fast" }))
    );

    await app.do("ping", { stream: "c1", actor }, {});
    for (let i = 0; i < 2; i++) {
      await app.correlate();
      await app.drain();
    }

    // No controller claims "typo", so the row sat at watermark -1 forever
    // and was invisible to every health surface.
    expect(ran).toBe(1);
    await dispose();
  });

  it("says so — a rerouted lane is not silent", async () => {
    const errors = await captured(async () => {
      const { app, dispose } = await sandbox(
        act()
          .withState(Counter)
          .withLane({ name: "fast" })
          .on("Pinged")
          .do(async function onPinged() {})
          .to(() => ({ target: "solo-1564", lane: "typo" as "fast" }))
      );
      await app.do("ping", { stream: "c1", actor }, {});
      for (let i = 0; i < 2; i++) {
        await app.correlate();
        await app.drain();
      }
      await dispose();
    });

    const reported = errors.find((m) => /undeclared lane/.test(m));
    expect(reported).toMatch(/"typo"/);
    expect(reported).toMatch(/solo-1564/);
    expect(reported).toMatch(/rejected at build/);
  });

  it("reports once, not once per matching event", async () => {
    const errors = await captured(async () => {
      const { app, dispose } = await sandbox(
        act()
          .withState(Counter)
          .withLane({ name: "fast" })
          .on("Pinged")
          .do(async function onPinged() {})
          .to(() => ({ target: "repeat-1564", lane: "typo" as "fast" }))
      );
      // A resolver fires for every matching event; an operator with a busy
      // stream must not get one line per event.
      for (let i = 0; i < 3; i++)
        await app.do("ping", { stream: `c${i}`, actor }, {});
      for (let i = 0; i < 2; i++) {
        await app.correlate();
        await app.drain();
      }
      await dispose();
    });

    const reported = errors.filter((m) => /repeat-1564/.test(m));
    expect(reported).toHaveLength(1);
  });
});

describe("two dynamic resolutions disagreeing on a target's lane (#1567)", () => {
  it("CONTROL — the static form is still rejected at build", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withLane({ name: "fast" })
        .withLane({ name: "slow" })
        .on("Bumped")
        .do(async function onBumped() {})
        .to({ target: "T", lane: "fast" })
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "T", lane: "slow" })
        .build()
    ).toThrow(/conflicting lane assignments/);
  });

  it("says so — first-discovery-wins is not silent", async () => {
    const errors = await captured(async () => {
      const { app, dispose } = await sandbox(
        act()
          .withState(Counter)
          .withLane({ name: "fast" })
          .withLane({ name: "slow" })
          .on("Bumped")
          .do(async function onBumped() {})
          .to(() => ({ target: "T-1567", lane: "fast" }))
          .on("Pinged")
          .do(async function onPinged() {})
          .to(() => ({ target: "T-1567", lane: "slow" }))
      );
      await app.do("bump", { stream: "c1", actor }, {});
      await app.do("ping", { stream: "c1", actor }, {});
      for (let i = 0; i < 2; i++) {
        await app.correlate();
        await app.drain();
      }
      await dispose();
    });

    // The losing handler runs inside the winning lane's leaseMillis and
    // streamLimit — exactly the head-of-line blocking lanes exist to prevent.
    const reported = errors.find((m) => /conflicting lane/.test(m));
    expect(reported).toMatch(/T-1567/);
    expect(reported).toMatch(/"fast"/);
    expect(reported).toMatch(/"slow"/);
  });
});

/**
 * The dedup key has to name the *declaration*, never the occurrence (#1584).
 *
 * The documented per-aggregate reaction shape is `.to(e => ({target:
 * e.stream}))`, which mints one target per aggregate. A key carrying that
 * target dedups nothing across aggregates, so a single misdeclaration turns
 * into one report per aggregate — the log volume `report_once` exists to
 * prevent, arriving at exactly the scale where an operator can least afford
 * it. What varies per aggregate goes in the message as an example; what the
 * operator has to edit goes in the key.
 */
describe("reporting once per declaration, not once per aggregate (#1584)", () => {
  /** Enough aggregates that per-target keying is unmistakable in the count. */
  const AGGREGATES = 25;

  /** Structural view of the two pipeline calls these tests drive. */
  type Cycler = {
    correlate: (query?: Query) => Promise<unknown>;
    drain: () => Promise<unknown>;
  };

  // A wide page so one pass scans every aggregate's events — the default
  // limit of 10 would cut the scan short and understate the report count.
  const cycle = async (app: Cycler): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      await app.correlate({ limit: 500 });
      await app.drain();
    }
  };

  describe("an undeclared lane (#1564)", () => {
    it("CONTROL — one aggregate, one bad declaration: one report", async () => {
      const errors = await captured(async () => {
        const { app, dispose } = await sandbox(
          act()
            .withState(Counter)
            .withLane({ name: "fast" })
            .on("Pinged")
            .do(async function onPingedSolo() {})
            .to((e) => ({ target: `${e.stream}-view`, lane: "typo" as "fast" }))
        );
        await app.do("ping", { stream: "c0", actor }, {});
        await cycle(app);
        await dispose();
      });

      expect(errors.filter((m) => /undeclared lane/.test(m))).toHaveLength(1);
    });

    it("still one report when the same declaration reroutes 25 targets", async () => {
      const errors = await captured(async () => {
        const { app, dispose } = await sandbox(
          act()
            .withState(Counter)
            .withLane({ name: "fast" })
            .on("Pinged")
            .do(async function onPingedMany() {})
            .to((e) => ({ target: `${e.stream}-view`, lane: "typo" as "fast" }))
        );
        for (let i = 0; i < AGGREGATES; i++)
          await app.do("ping", { stream: `c${i}`, actor }, {});
        await cycle(app);
        await dispose();
      });

      const reported = errors.filter((m) => /undeclared lane/.test(m));
      expect(reported).toHaveLength(1);
      // The target survives as an example, so the operator still gets a
      // concrete stream to look at.
      expect(reported[0]).toMatch(/-view/);
    });

    it("CONTROL — two declarations naming the same bad lane report twice", async () => {
      const errors = await captured(async () => {
        const { app, dispose } = await sandbox(
          act()
            .withState(Counter)
            .withLane({ name: "fast" })
            .on("Pinged")
            .do(async function onPingedA() {})
            .to((e) => ({ target: `${e.stream}-a`, lane: "typo" as "fast" }))
            .on("Bumped")
            .do(async function onBumpedB() {})
            .to((e) => ({ target: `${e.stream}-b`, lane: "typo" as "fast" }))
        );
        for (let i = 0; i < 3; i++) {
          await app.do("ping", { stream: `c${i}`, actor }, {});
          await app.do("bump", { stream: `c${i}`, actor }, {});
        }
        await cycle(app);
        await dispose();
      });

      // Two separate edits are needed, so two separate reports — collapsing
      // every misdeclaration into one line would be a regression, not a fix.
      expect(errors.filter((m) => /undeclared lane/.test(m))).toHaveLength(2);
    });
  });

  describe("conflicting lanes (#1567)", () => {
    it("CONTROL — one aggregate, one bad declaration pair: one report", async () => {
      const errors = await captured(async () => {
        const { app, dispose } = await sandbox(
          act()
            .withState(Counter)
            .withLane({ name: "fast" })
            .withLane({ name: "slow" })
            .on("Bumped")
            .do(async function onBumpedSolo() {})
            .to((e) => ({ target: `${e.stream}-view`, lane: "fast" }))
            .on("Pinged")
            .do(async function onPingedSolo() {})
            .to((e) => ({ target: `${e.stream}-view`, lane: "slow" }))
        );
        await app.do("bump", { stream: "c0", actor }, {});
        await app.do("ping", { stream: "c0", actor }, {});
        await cycle(app);
        await dispose();
      });

      expect(errors.filter((m) => /conflicting lane/.test(m))).toHaveLength(1);
    });

    it("still one report when the same pair disagrees on 25 targets", async () => {
      const errors = await captured(async () => {
        const { app, dispose } = await sandbox(
          act()
            .withState(Counter)
            .withLane({ name: "fast" })
            .withLane({ name: "slow" })
            .on("Bumped")
            .do(async function onBumpedMany() {})
            .to((e) => ({ target: `${e.stream}-view`, lane: "fast" }))
            .on("Pinged")
            .do(async function onPingedMany() {})
            .to((e) => ({ target: `${e.stream}-view`, lane: "slow" }))
        );
        for (let i = 0; i < AGGREGATES; i++) {
          await app.do("bump", { stream: `c${i}`, actor }, {});
          await app.do("ping", { stream: `c${i}`, actor }, {});
        }
        await cycle(app);
        await dispose();
      });

      const reported = errors.filter((m) => /conflicting lane/.test(m));
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatch(/-view/);
    });

    it("CONTROL — two distinct bad pairs report twice", async () => {
      const errors = await captured(async () => {
        const { app, dispose } = await sandbox(
          act()
            .withState(Counter)
            .withLane({ name: "fast" })
            .withLane({ name: "slow" })
            .on("Bumped")
            .do(async function onBumpedA() {})
            .to((e) => ({ target: `${e.stream}-a`, lane: "fast" }))
            .on("Pinged")
            .do(async function onPingedA() {})
            .to((e) => ({ target: `${e.stream}-a`, lane: "slow" }))
            .on("Bumped")
            .do(async function onBumpedB() {})
            .to((e) => ({ target: `${e.stream}-b`, lane: "fast" }))
            .on("Pinged")
            .do(async function onPingedB() {})
            .to((e) => ({ target: `${e.stream}-b`, lane: "slow" }))
        );
        for (let i = 0; i < 3; i++) {
          await app.do("bump", { stream: `c${i}`, actor }, {});
          await app.do("ping", { stream: `c${i}`, actor }, {});
        }
        await cycle(app);
        await dispose();
      });

      expect(errors.filter((m) => /conflicting lane/.test(m))).toHaveLength(2);
    });
  });
});
