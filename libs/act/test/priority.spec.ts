/**
 * ACT-102 — priority lanes, framework-level coverage.
 *
 * Tests the in-memory adapter (claim ordering, subscribe `max()`,
 * `prioritize` filter), the build-classify max-priority collection,
 * the correlate-cycle priority threading, and the Act.prioritize
 * orchestrator wrapper.
 *
 * Adapter parity with PostgresStore / SqliteStore lives in their own
 * integration suites against docker / file-backed databases.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act, state, ZodEmpty } from "../src/index.js";
import { classify_registry } from "../src/internal/build-classify.js";
import { dispose, store } from "../src/ports.js";

describe("ACT-102 priority lanes — framework", () => {
  beforeEach(() => {
    // Each test gets a fresh adapter so subscriptions / priorities
    // don't bleed across cases.
    store(new InMemoryStore());
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  describe("InMemoryStore.subscribe + claim ordering", () => {
    it("claim returns higher-priority streams first under tied watermarks", async () => {
      // Two source events so both targets have work to do.
      const meta = { correlation: "", causation: {} };
      await store().commit("src", [{ name: "X", data: {} }], meta);
      await store().commit("src", [{ name: "Y", data: {} }], meta);

      await store().subscribe([
        { stream: "low", source: "src", priority: 0 },
        { stream: "high", source: "src", priority: 10 },
      ]);

      const leases = await store().claim(1, 0, "w", 1000);
      expect(leases).toHaveLength(1);
      expect(leases[0].stream).toBe("high");
    });

    it("subscribe keeps the max priority across reactions", async () => {
      await store().subscribe([{ stream: "s", priority: 5 }]);
      await store().subscribe([{ stream: "s", priority: 1 }]); // lower → ignored
      await store().subscribe([{ stream: "s", priority: 9 }]); // higher → wins

      const positions: any[] = [];
      await store().query_streams((p) => positions.push(p), { stream: "s" });
      expect(positions[0].priority).toBe(9);
    });

    it("default priority is 0 — behavior unchanged when no priority is set", async () => {
      const meta = { correlation: "", causation: {} };
      await store().commit("src", [{ name: "A", data: {} }], meta);

      await store().subscribe([
        { stream: "later", source: "src" },
        { stream: "earlier", source: "src" },
      ]);

      const leases = await store().claim(2, 0, "w", 1000);
      // No priorities → tie-break is whatever the adapter's natural
      // ordering yields. Both should come back; the contract is just
      // "no priority bias."
      expect(leases.map((l) => l.stream).sort()).toEqual(["earlier", "later"]);
    });

    it("does not starve a default-priority lagging stream under sustained high-priority load (ACT-1223)", async () => {
      // Many priority-100 lagging streams that always have work, plus one
      // priority-0 lagging stream. The pre-fix lagging selection orders by
      // `priority DESC, at ASC`, so the four lagging slots are always taken
      // by the high-priority streams and the low-priority stream starves
      // forever. The fairness reserve (ACT-1223) carves one of the four
      // slots for pure watermark order, so the most-behind stream — the
      // never-processed low one — is claimed within a bounded window.
      const meta = { correlation: "", causation: {} };
      await store().commit("src", [{ name: "X", data: {} }], meta);

      await store().subscribe([
        { stream: "high-0", source: "src", priority: 100 },
        { stream: "high-1", source: "src", priority: 100 },
        { stream: "high-2", source: "src", priority: 100 },
        { stream: "high-3", source: "src", priority: 100 },
        { stream: "high-4", source: "src", priority: 100 },
        { stream: "high-5", source: "src", priority: 100 },
        { stream: "low", source: "src", priority: 0 },
      ]);

      const by = randomUUID();
      let low_claimed_at = -1;
      const MAX_CYCLES = 20;
      for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
        const leases = await store().claim(4, 0, by, 1000);
        if (leases.some((l) => l.stream === "low")) {
          low_claimed_at = cycle;
          break;
        }
        // Ack each claimed stream forward to the current head so the
        // high-priority streams catch up momentarily...
        const head = leases
          .map((l) => l.at)
          .reduce((a, b) => Math.max(a, b), 0);
        await store().ack(leases.map((l) => ({ ...l, at: head })));
        // ...then commit a fresh source event so every subscribed stream
        // is lagging again on the next cycle — sustained high-priority load.
        await store().commit("src", [{ name: "X", data: {} }], meta);
      }

      expect(low_claimed_at).toBeGreaterThanOrEqual(0);
      expect(low_claimed_at).toBeLessThan(MAX_CYCLES);
    });
  });

  describe("InMemoryStore.prioritize", () => {
    it("matches by exact stream name", async () => {
      await store().subscribe([
        { stream: "a" },
        { stream: "b" },
        { stream: "c" },
      ]);
      const updated = await store().prioritize(
        { stream: "b", stream_exact: true },
        7
      );
      expect(updated).toBe(1);

      const seen: any[] = [];
      await store().query_streams((p) => seen.push(p));
      const by_stream = Object.fromEntries(
        seen.map((p) => [p.stream, p.priority])
      );
      expect(by_stream).toEqual({ a: 0, b: 7, c: 0 });
    });

    it("matches by stream regex by default (InMemory uses anchored regex)", async () => {
      await store().subscribe([
        { stream: "proj-a" },
        { stream: "proj-b" },
        { stream: "audit-x" },
      ]);
      // InMemory anchors the input as `^<pattern>$`. Use `.*` to
      // match suffixes — same convention as `query_streams`.
      const updated = await store().prioritize({ stream: "proj-.*" }, 3);
      expect(updated).toBe(2);
    });

    it("matches by source filter", async () => {
      await store().subscribe([
        { stream: "t1", source: "users" },
        { stream: "t2", source: "audit" },
      ]);
      const updated = await store().prioritize(
        { source: "users", source_exact: true },
        4
      );
      expect(updated).toBe(1);
    });

    it("source filter ignores rows with no source set", async () => {
      await store().subscribe([
        { stream: "no-source" }, // no source — filter shouldn't match
        { stream: "with-source", source: "x" },
      ]);
      const updated = await store().prioritize({ source: "x" }, 2);
      expect(updated).toBe(1);
    });

    it("matches by blocked state", async () => {
      // Manually block one stream via the existing test path — claim
      // → block → prioritize.
      const meta = { correlation: "", causation: {} };
      await store().commit("src", [{ name: "X", data: {} }], meta);
      await store().subscribe([
        { stream: "ok", source: "src" },
        { stream: "bad", source: "src" },
      ]);
      const leases = await store().claim(2, 0, "w", 1000);
      const badLease = leases.find((l) => l.stream === "bad")!;
      await store().block([{ ...badLease, error: "boom" }]);

      const updated = await store().prioritize({ blocked: true }, 9);
      expect(updated).toBe(1);
    });

    it("empty filter matches every registered stream", async () => {
      await store().subscribe([{ stream: "a" }, { stream: "b" }]);
      const updated = await store().prioritize({}, 5);
      expect(updated).toBe(2);
    });

    it("no-op when value matches existing priority", async () => {
      await store().subscribe([{ stream: "a", priority: 5 }]);
      const updated = await store().prioritize({}, 5);
      expect(updated).toBe(0);
    });

    it("can decrease priority (operator override of subscribe-side max)", async () => {
      // subscribe upholds `max()`; prioritize sets the value as-is.
      await store().subscribe([{ stream: "a", priority: 9 }]);
      const updated = await store().prioritize({}, 1);
      expect(updated).toBe(1);
      const seen: any[] = [];
      await store().query_streams((p) => seen.push(p), { stream: "a" });
      expect(seen[0].priority).toBe(1);
    });
  });

  describe("classify_registry — static priority collection", () => {
    it("collects priority from static resolvers and keeps the max", async () => {
      const Counter = state({ Counter: z.object({ count: z.number() }) })
        .init(() => ({ count: 0 }))
        .emits({ Inc: ZodEmpty })
        .on({ inc: ZodEmpty })
        .emit(() => ["Inc", {}])
        .build();

      const app = act()
        .withState(Counter)
        // Two reactions on the same target — different priorities.
        .on("Inc")
        .do(async function r1() {})
        .to({ target: "shared", priority: 3 })
        .on("Inc")
        .do(async function r2() {})
        .to({ target: "shared", priority: 7 })
        .build() as unknown as {
        registry: any;
        _states: any;
      };

      const c = classify_registry(app.registry, app._states);
      expect(c.static_targets).toEqual([
        { stream: "shared", source: undefined, priority: 7 },
      ]);
    });

    it("has_dynamic_resolvers true when any resolver is a function", () => {
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
        .to((e) => ({ target: `tgt-${e.stream}`, priority: 5 }))
        .build() as unknown as { registry: any; _states: any };

      const c = classify_registry(app.registry, app._states);
      expect(c.has_dynamic_resolvers).toBe(true);
      expect(c.static_targets).toEqual([]);
    });
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
        .build();

      // Trigger init so the static target is subscribed.
      await app.correlate();
      const updated = await app.prioritize({}, 5);
      expect(updated).toBe(1);

      const seen: any[] = [];
      await store().query_streams((p) => seen.push(p));
      expect(seen.find((p) => p.stream === "static-target").priority).toBe(5);
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
        .build();

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
        .build();

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
