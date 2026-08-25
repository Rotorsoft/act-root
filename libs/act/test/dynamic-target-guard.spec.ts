import { z } from "zod";
import { act, projection, state } from "../src/index.js";
import { sandbox } from "../src/test/index.js";

/**
 * The build-time guards can only inspect a static `.to({target})` — a
 * `.to(fn)` target is a function until an event arrives. Correlate is where
 * the answer finally exists, so the same rules apply there (#1563, #1564).
 *
 * Log and skip, never throw: a throw inside correlate pins the checkpoint for
 * the whole app (#1420).
 */

const actor = { id: "a", name: "a" };

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Bumped: z.object({ by: z.number() }) })
  .patch({ Bumped: ({ data }, s) => ({ count: s.count + data.by }) })
  .on({ bump: z.object({ by: z.number() }) })
  .emit("Bumped")
  .build();

const Other = state({ Other: z.object({ label: z.string() }) })
  .init(() => ({ label: "" }))
  .emits({ Pinged: z.object({ label: z.string() }) })
  .patch({ Pinged: ({ data }) => ({ label: data.label }) })
  .on({ ping: z.object({ label: z.string() }) })
  .emit("Pinged")
  .build();

const fold = (rows: unknown[]) =>
  projection("counters")
    .of(Counter)
    .flush(async (r) => {
      rows.push(...r.map((x) => ({ stream: x.stream, state: x.state })));
    })
    .build();

describe("a dynamic resolution onto a projection's target (#1563)", () => {
  it("CONTROL — the static form is still rejected at build", () => {
    expect(() =>
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold([]))
        .on("Pinged")
        .do(async function onPinged() {})
        .to({ target: "counters" })
        .build()
    ).toThrow(/conflicts with the projection/);
  });

  it("is skipped, and never feeds the projection a foreign aggregate", async () => {
    const rows: unknown[] = [];
    const { app, dispose } = await sandbox(
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold(rows))
        .on("Pinged")
        .do(async function onPinged() {})
        .to(() => ({ target: "counters" }))
    );

    await app.do("bump", { stream: "c1", actor }, { by: 1 });
    await app.do("ping", { stream: "o1", actor }, { label: "ping" });
    for (let i = 0; i < 2; i++) {
      await app.correlate();
      await app.drain();
    }

    // The projection holds its own aggregate and nothing else — the `o1`
    // Other aggregate never reaches a Counter fold's table.
    expect(rows).toEqual([{ stream: "c1", state: { count: 1 } }]);
    await dispose();
  });

  it("does not stall correlation for everything else (#1420)", async () => {
    const rows: unknown[] = [];
    let healthy = 0;
    const { app, dispose } = await sandbox(
      act()
        .withState(Counter)
        .withState(Other)
        .withProjection(fold(rows))
        .on("Pinged")
        .do(async function bad() {})
        .to(() => ({ target: "counters" }))
        .on("Bumped")
        .do(async function good() {
          healthy++;
        })
        .to(() => ({ target: "healthy-out" }))
    );

    await app.do("ping", { stream: "o1", actor }, { label: "poison" });
    await app.do("bump", { stream: "c1", actor }, { by: 1 });
    for (let i = 0; i < 2; i++) {
      await app.correlate();
      await app.drain();
    }

    // A neighbour's reaction still runs — the checkpoint is not pinned.
    expect(healthy).toBe(1);
    await dispose();
  });
});
