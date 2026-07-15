import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { act, dispose, state, store, ZodEmpty } from "../src/index.js";

/**
 * Regression for #1255 — in the dynamic-resolver correlate scan, when two
 * reactions on the same event resolve to the same target stream with
 * different priorities, the highest-priority reaction must set the target's
 * lane (matching the subscribe-side max() invariant). The bug kept the max
 * priority but left the first-seen reaction's lane in place.
 *
 * Dynamic resolvers (function `.to`) are required: the static path rejects
 * two reactions on the same target with different lanes at build time, so
 * the collision only reaches correlate through runtime resolution.
 */
describe("correlate dynamic-resolver lane (#1255)", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: (_e, s) => ({ count: s.count + 1 }) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  it("the highest-priority reaction sets the target's lane", async () => {
    const app = act()
      .withState(counter)
      .withLane({ name: "fast" })
      .withLane({ name: "slow" })
      // Low priority, "fast" lane — registered first, so scanned first and
      // seeds the entry's lane.
      .on("ticked")
      .do(async function reactLow() {})
      .to(() => ({ target: "shared", priority: 1, lane: "fast" }))
      // Higher priority, "slow" lane — must win the lane, not just the priority.
      .on("ticked")
      .do(async function reactHigh() {})
      .to(() => ({ target: "shared", priority: 7, lane: "slow" }))
      .build();

    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();

    let lane: string | undefined;
    let priority = -1;
    await store().query_streams((p) => {
      if (p.stream === "shared") {
        lane = p.lane;
        priority = p.priority;
      }
    });

    expect(priority).toBe(7); // max priority — already correct
    expect(lane).toBe("slow"); // the winning reaction's lane, not "fast"
  });
});
