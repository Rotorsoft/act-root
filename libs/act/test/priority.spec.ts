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
