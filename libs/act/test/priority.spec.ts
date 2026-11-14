/**
 * Priority, framework-level coverage: the Act.prioritize wrapper and the
 * correlate-cycle priority threading. Store behavior (claim ordering,
 * subscribe's maximum, the prioritize filter) is the store TCK's, which
 * every adapter runs; classify's max-priority collection is classify.spec's.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, log, state, ZodEmpty } from "../src/index.js";
import { dispose, store } from "../src/ports.js";

describe("priority lanes — framework", () => {
  beforeEach(() => {
    // Each test gets a fresh adapter so subscriptions / priorities
    // don't bleed across cases.
    store(new InMemoryStore());
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  describe("Act.prioritize wrapper", () => {
    it("delegates to store().prioritize and returns the count", async () => {
      const Counter = state({ Counter: z.object({ count: z.number() }) })
        .init(() => ({ count: 0 }))
        .emits({ Inc: ZodEmpty })
        .on({ inc: ZodEmpty })
        .emit(() => ["Inc", {}])
        .build();
      const app = act()
        .withState(Counter)
        .on("Inc")
        .do(async function r() {})
        .to("static-target")
        .build({ autoSettle: false });

      // Trigger init so the static target is subscribed.
      await app.correlate();
      const updated = await app.prioritize({}, 5);
      expect(updated).toBe(1);

      const seen: any[] = [];
      await store().query_streams((p) => seen.push(p));
      expect(seen.find((p) => p.stream === "static-target").priority).toBe(5);
    });

    it("refuses a priority that isn't a 32-bit integer before the store sees it", async () => {
      const app = act().build({ autoSettle: false });
      const spy = vi.spyOn(store(), "prioritize");
      await expect(app.prioritize({}, 1.5)).rejects.toThrow();
      await expect(app.prioritize({}, 3_000_000_000)).rejects.toThrow();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("correlate-cycle — a dynamic priority that isn't a 32-bit integer", () => {
    it("runs it at priority 0, says so once per reaction, and keeps correlating", async () => {
      const Pinger = state({ Pinger: z.object({ w: z.number() }) })
        .init(() => ({ w: 0 }))
        .emits({ Pinged: z.object({ w: z.number() }) })
        .on({ ping: z.object({ w: z.number() }) })
        .emit((data) => ["Pinged", data])
        .build();
      const scored: number[] = [];
      const plain: number[] = [];
      const app = act()
        .withState(Pinger)
        .on("Pinged")
        .do(async function scored_reaction(e) {
          scored.push(e.data.w);
        })
        .to((e) => ({ target: `scored-${e.data.w}`, priority: e.data.w }))
        .on("Pinged")
        .do(async function plain_reaction(e) {
          plain.push(e.data.w);
        })
        .to("plain")
        .build({ autoSettle: false });
      const errors: string[] = [];
      const spy = vi
        .spyOn(log(), "error")
        .mockImplementation((e: unknown) =>
          errors.push(e instanceof Error ? e.message : String(e))
        );
      const actor = { id: "a", name: "a" };
      try {
        for (const w of [1, 1.5, 2.5, 2])
          await app.do("ping", { stream: "p", actor }, { w });
        // Until every reaction has run, not a fixed number of passes.
        for (let i = 0; i < 10 && scored.length + plain.length < 8; i++) {
          await app.correlate();
          await app.drain();
        }
      } finally {
        spy.mockRestore();
      }
      expect(scored.sort()).toEqual([1, 1.5, 2, 2.5]);
      expect(plain).toEqual([1, 1.5, 2.5, 2]);
      const priorities: Record<string, number> = {};
      await store().query_streams((p) => {
        priorities[p.stream] = p.priority;
      });
      expect(priorities["scored-1.5"]).toBe(0);
      expect(priorities["scored-2.5"]).toBe(0);
      expect(priorities["scored-2"]).toBe(2);
      // Two different bad values, one line: keyed by the reaction.
      const reports = errors.filter((m) => m.includes("32-bit integer"));
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain('"scored_reaction"');
    });
  });

  describe("correlate-cycle — priority threading", () => {
    it("keeps max priority across multiple events resolving to same target", async () => {
      // Two events resolve to the same target stream with different
      // priorities — the higher one wins (matches the subscribe-side
      // max() invariant).
      const Counter = state({ Counter: z.object({ count: z.number() }) })
        .init(() => ({ count: 0 }))
        .emits({ Hit: z.object({ priority: z.number() }) })
        .on({ hit: z.object({ priority: z.number() }) })
        .emit("Hit")
        .build();

      const app = act()
        .withState(Counter)
        .on("Hit")
        .do(async function r() {})
        .to((e) => ({
          target: "shared",
          source: e.stream,
          priority: e.data.priority,
        }))
        .build({ autoSettle: false });

      // Commit lower-priority first, then higher.
      await app.do(
        "hit",
        { stream: "src", actor: { id: randomUUID(), name: "t" } },
        { priority: 1 }
      );
      await app.do(
        "hit",
        { stream: "src", actor: { id: randomUUID(), name: "t" } },
        { priority: 7 }
      );
      await app.correlate({ limit: 100 });

      const seen: any[] = [];
      await store().query_streams((p) => seen.push(p), { stream: "shared" });
      expect(seen[0].priority).toBe(7);
    });

    it("propagates resolver priority to subscribe payload (dynamic targets)", async () => {
      const Counter = state({ Counter: z.object({ count: z.number() }) })
        .init(() => ({ count: 0 }))
        .emits({ Hit: z.object({ which: z.string() }) })
        .on({ hit: z.object({ which: z.string() }) })
        .emit("Hit")
        .build();

      const app = act()
        .withState(Counter)
        .on("Hit")
        .do(async function r() {})
        .to((e) => ({
          target: `tgt-${e.data.which}`,
          source: e.stream,
          priority: e.data.which === "urgent" ? 10 : 0,
        }))
        .build({ autoSettle: false });

      await app.do(
        "hit",
        { stream: "src", actor: { id: randomUUID(), name: "t" } },
        { which: "urgent" }
      );
      await app.do(
        "hit",
        { stream: "src", actor: { id: randomUUID(), name: "t" } },
        { which: "bulk" }
      );
      const { subscribed } = await app.correlate({ limit: 100 });
      expect(subscribed).toBe(2);

      const seen: any[] = [];
      await store().query_streams((p) => seen.push(p));
      const by_stream = Object.fromEntries(
        seen.map((p) => [p.stream, p.priority])
      );
      expect(by_stream["tgt-urgent"]).toBe(10);
      expect(by_stream["tgt-bulk"]).toBe(0);
    });
  });
});
