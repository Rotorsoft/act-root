import { z } from "zod";
import { act, cache, dispose, state, store } from "../src/index.js";
import { sleep } from "../src/utils.js";

/**
 * Intra-event ack integrity (#1179): one event fans out to one payload
 * per matching reaction, and the watermark may only advance past the
 * event once EVERY reaction on it has run. A mid-group failure must
 * hold the watermark (redelivering the whole group, at-least-once) and
 * count as no progress, so the retry counter marches toward
 * `blockOnError` instead of resetting on every partial pass.
 */
describe("intra-event ack across co-targeted reactions", () => {
  const counter = state({ ICounter: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ ticked: z.object({ by: z.number() }) })
    .patch({ ticked: ({ data }, s) => ({ n: s.n + data.by }) })
    .on({ tick: z.object({ by: z.number() }) })
    .emit((action) => ["ticked", { by: action.by }])
    .build();

  const actor = { id: "t", name: "t" };

  beforeEach(async () => {
    // Full drop, not just seed: the co-targeted reactions are static
    // (no source filter), so leftover events from a previous test would
    // be delivered to the next test's target.
    await store().drop();
    await store().seed();
    await cache().clear();
  });

  afterAll(async () => {
    await dispose()();
  });

  async function watermark(target: string) {
    let at = Number.NaN;
    let blocked = false;
    await store().query_streams(
      (p) => {
        at = p.at;
        blocked = p.blocked;
      },
      { stream: target, stream_exact: true }
    );
    return { at, blocked };
  }

  it("holds the watermark when a later reaction on the same event fails", async () => {
    const first_calls: number[] = [];
    let second_attempts = 0;
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function firstReaction(event) {
        first_calls.push(event.id);
      })
      .to("co-target-1")
      .on("ticked")
      .do(
        async function secondReaction() {
          second_attempts++;
          throw new Error("second reaction fails");
        },
        { maxRetries: 1, blockOnError: true }
      )
      .to("co-target-1")
      .build();

    await app.do("tick", { stream: "i1", actor }, { by: 1 });
    await app.correlate();

    // First pass: reaction 1 succeeds, reaction 2 throws — the event's
    // group is incomplete, so nothing is acked and the watermark holds.
    await app.drain({ leaseMillis: 1 });
    expect(first_calls).toHaveLength(1);
    expect(second_attempts).toBe(1);
    expect((await watermark("co-target-1")).at).toBe(-1);

    // Redelivery re-runs the WHOLE group — at-least-once means the
    // already-succeeded reaction runs again.
    await sleep(5);
    await app.drain({ leaseMillis: 1 });
    expect(first_calls).toHaveLength(2);
    expect(second_attempts).toBe(2);

    // Retry budget exhausted (maxRetries: 1) — the stream blocks with
    // the watermark still before the event; nothing was silently lost.
    await sleep(5);
    await app.drain({ leaseMillis: 1 });
    const { at, blocked } = await watermark("co-target-1");
    expect(blocked).toBe(true);
    expect(at).toBe(-1);
  });

  it("acks the group once every reaction on the event succeeds", async () => {
    let fail_once = true;
    const first_calls: number[] = [];
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function firstReaction(event) {
        first_calls.push(event.id);
      })
      .to("co-target-2")
      .on("ticked")
      .do(
        async function secondReaction() {
          if (fail_once) {
            fail_once = false;
            throw new Error("transient");
          }
        },
        { maxRetries: 5, blockOnError: true }
      )
      .to("co-target-2")
      .build();

    await app.do("tick", { stream: "i2", actor }, { by: 1 });
    await app.correlate();
    await app.drain({ leaseMillis: 1 });
    expect((await watermark("co-target-2")).at).toBe(-1);

    await sleep(5);
    const d = await app.drain({ leaseMillis: 1 });
    expect(d.acked.some((l) => l.stream === "co-target-2")).toBe(true);
    // Both events of the group completed; watermark passed the event.
    const events = await app.query_array({ stream: "i2", stream_exact: true });
    expect((await watermark("co-target-2")).at).toBe(events.at(-1)!.id);
    expect(first_calls).toHaveLength(2);
  });

  it("keeps cross-event partial progress — completed events ack, the failing group holds", async () => {
    const seen: number[] = [];
    const app = act()
      .withState(counter)
      .on("ticked")
      .do(async function firstReaction(event) {
        seen.push(event.id);
      })
      .to("co-target-3")
      .on("ticked")
      .do(
        async function secondReaction(event) {
          // Fails only on the SECOND event's group.
          if (event.version === 1) throw new Error("second event fails");
        },
        { maxRetries: 99, blockOnError: false }
      )
      .to("co-target-3")
      .build();

    await app.do("tick", { stream: "i3", actor }, { by: 1 });
    await app.do("tick", { stream: "i3", actor }, { by: 1 });
    await app.correlate();
    await app.drain({ leaseMillis: 1 });

    const events = await app.query_array({ stream: "i3", stream_exact: true });
    // Event 1's group completed — acked. Event 2's group failed midway —
    // the watermark stops exactly at event 1.
    expect((await watermark("co-target-3")).at).toBe(events.at(0)!.id);
    expect(seen).toEqual([events.at(0)!.id, events.at(1)!.id]);
  });
});
