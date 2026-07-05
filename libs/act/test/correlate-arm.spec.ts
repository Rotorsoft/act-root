import { act, dispose, sleep, state } from "@rotorsoft/act";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Correlate must arm the lane controllers when it subscribes new
 * streams — the same contract reset and unblock already honor. Without
 * it, a lane worker's tick can disarm on an empty claim in the window
 * before the subscription lands, and the freshly-correlated stream
 * starves until an unrelated commit happens to re-arm the lane.
 */
describe("correlate arms lanes for newly-subscribed streams", () => {
  const order = state({ Order: z.object({ sku: z.string() }) })
    .init(() => ({ sku: "" }))
    .emits({ OrderPlaced: z.object({ sku: z.string() }) })
    .patch({ OrderPlaced: (e) => ({ sku: e.data.sku }) })
    .on({ place: z.object({ sku: z.string() }) })
    .emit((a) => ["OrderPlaced", a])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose()();
  });

  it("revives a lane that disarmed before the subscription landed", async () => {
    const seen: string[] = [];
    const app = act()
      .withState(order)
      .withLane({ name: "payments", cycleMs: 20 })
      .on("OrderPlaced")
      .do(async function charge(event) {
        seen.push(event.stream);
      })
      .to((e) => ({
        target: `payments:${e.stream}`,
        source: e.stream,
        lane: "payments",
      }))
      .build();

    // Consume the correlate cycle's one-time cold-start arm first, so
    // the assertions below exercise the steady state, not init.
    await app.correlate();

    // Commit arms the lanes, but the payments worker (20ms cadence)
    // claims before any subscription exists and disarms itself. No
    // settle wiring here — the starvation window is the point.
    await app.do("place", { stream: "o1", actor }, { sku: "x" });
    await sleep(80);
    expect(seen).toHaveLength(0); // worker ticked empty and went idle

    // Correlate discovers and subscribes payments:o1 — and must re-arm
    // the lane so its worker picks the stream up on the next tick.
    const { subscribed } = await app.correlate();
    expect(subscribed).toBe(1);
    await sleep(120);
    expect(seen).toEqual(["o1"]);
  });
});
