import { z } from "zod";
import { act, dispose, projection, sleep, state, store } from "../src/index.js";
import type { AuditFinding } from "../src/types/index.js";

/**
 * #723 / ACT-708.5 — `app.audit()` smoke tests for slice 1.
 *
 * Covers the two categories shipped in slice 1:
 *   - `schema` — known/unknown event names + Zod validation
 *   - `deprecated-load` — `_v<digits>` rule + workspace aggregation
 *
 * Subsequent slices add tests as their categories land.
 */
describe("audit", () => {
  // Two-version event family: `Renamed` (deprecated) → `Renamed_v2`.
  // Other event has no version family — should classify as "active",
  // never appear in deprecated-load findings.
  const widget = state({
    Widget: z.object({ name: z.string(), price: z.number() }),
  })
    .init(() => ({ name: "", price: 0 }))
    .emits({
      Renamed: z.object({ name: z.string() }),
      Renamed_v2: z.object({ name: z.string(), reason: z.string() }),
      Repriced: z.object({ price: z.number() }),
    })
    .patch({
      Renamed: ({ data }, s) => ({ ...s, name: data.name }),
      Renamed_v2: ({ data }, s) => ({ ...s, name: data.name }),
      Repriced: ({ data }, s) => ({ ...s, price: data.price }),
    })
    .on({ rename: z.object({ name: z.string() }) })
    .emit(() => ["Renamed_v2", { name: "x", reason: "y" }])
    .on({ rename_legacy: z.object({ name: z.string() }) })
    // Static `.emit("Renamed")` would throw at build because Renamed
    // is deprecated. Use a dynamic emit so we can seed legacy events
    // into the store for the audit to find.
    .emit(({ name }) => ["Renamed_v2", { name, reason: "via-test" }])
    .on({ reprice: z.object({ price: z.number() }) })
    .emit(({ price }) => ["Repriced", { price }])
    .build();

  // Second state with a snap reducer — for close-candidate
  // `restart_supported: true` and restart-candidate `count`
  // exercises. Independent event names so it doesn't interfere
  // with the widget's deprecation classifier.
  const order = state({ Order: z.object({ items: z.number() }) })
    .init(() => ({ items: 0 }))
    .emits({
      OrderPlaced: z.object({ items: z.number() }),
      OrderShipped: z.object({}),
    })
    .patch({
      OrderPlaced: ({ data }) => ({ items: data.items }),
      OrderShipped: () => ({}),
    })
    .on({ placeOrder: z.object({ items: z.number() }) })
    .emit(({ items }) => ["OrderPlaced", { items }])
    .on({ shipOrder: z.object({}) })
    .emit(() => ["OrderShipped", {}])
    .snap((s) => s.patches >= 5)
    .build();

  beforeEach(async () => {
    await store().drop();
    await store().seed();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("yields no findings on an empty store", async () => {
    const app = act().withState(widget).build();
    const findings: AuditFinding[] = [];
    for await (const f of app.audit()) findings.push(f);
    expect(findings).toEqual([]);
  });

  describe("schema category", () => {
    it("flags events whose name is unknown to the registry", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await app.do(
        "rename",
        { stream: "w1", actor: { id: "u", name: "u" } },
        { name: "alpha" }
      );
      // Sneak in a raw event whose name the registry doesn't know.
      // Direct store write — the framework's `.do()` would refuse it.
      await store().commit(
        "w1",
        [{ name: "Vanished", data: { gone: true } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["schema"])) findings.push(f);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "schema",
        stream: "w1",
        name: "Vanished",
        reason: "unknown_event_name",
      });
    });

    it("flags events that fail their current Zod schema", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      // Commit a Renamed_v2 event with the WRONG shape — missing
      // the `reason` field the current schema requires. Bypass
      // `.do()` so we don't get blocked by client-side validation.
      await store().commit(
        "w2",
        [{ name: "Renamed_v2", data: { name: "no-reason-here" } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["schema"])) findings.push(f);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "schema",
        stream: "w2",
        name: "Renamed_v2",
        reason: "schema_validation_failed",
      });
      expect((findings[0] as { zod_error?: unknown }).zod_error).toBeDefined();
    });

    it("skips framework-internal events (__snapshot__, __tombstone__)", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "w3",
        [
          { name: "__snapshot__", data: { state: { name: "s", price: 1 } } },
          { name: "__tombstone__", data: {} },
        ],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["schema"])) findings.push(f);

      // Should NOT flag the framework markers as unknown.
      expect(findings).toEqual([]);
    });
  });

  describe("deprecated-load category", () => {
    it("flags deprecated event load above the share threshold", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };

      // Seed 12 deprecated `Renamed` events across 3 streams + 2
      // current `Renamed_v2`. Deprecated share = 12/14 ≈ 86%, well
      // above the default 10% threshold.
      for (const stream of ["a", "b", "c"]) {
        for (let i = 0; i < 4; i++) {
          await store().commit(
            stream,
            [{ name: "Renamed", data: { name: `n${i}` } }],
            meta
          );
        }
      }
      await store().commit(
        "a",
        [{ name: "Renamed_v2", data: { name: "x", reason: "y" } }],
        meta
      );
      await store().commit(
        "b",
        [{ name: "Renamed_v2", data: { name: "x", reason: "y" } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["deprecated-load"])) findings.push(f);

      expect(findings).toHaveLength(1);
      const f = findings[0];
      expect(f).toMatchObject({
        category: "deprecated-load",
        name: "Renamed",
        current_version: "Renamed_v2",
        total: 12,
      });
      // top-streams sorted desc, with the right per-stream counts
      const findingWithStreams = f as Extract<
        AuditFinding,
        { category: "deprecated-load" }
      >;
      expect(findingWithStreams.top_streams).toEqual([
        { stream: "a", count: 4 },
        { stream: "b", count: 4 },
        { stream: "c", count: 4 },
      ]);
    });

    it("suppresses findings below the share threshold", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      // Heavy `Repriced` load (the active event) plus a single
      // deprecated `Renamed`. Deprecated share = 1/101 ≈ 1%,
      // below the default 10% threshold.
      for (let i = 0; i < 100; i++) {
        await store().commit(
          "s1",
          [{ name: "Repriced", data: { price: i } }],
          meta
        );
      }
      await store().commit(
        "s1",
        [{ name: "Renamed", data: { name: "rare" } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["deprecated-load"])) findings.push(f);
      expect(findings).toEqual([]);
    });

    it("skips deprecated events with zero on-disk load", async () => {
      // Registry declares Renamed + Renamed_v2 (Renamed deprecated)
      // but only Repriced (non-deprecated) has events on disk. The
      // deprecated-load pass should classify Renamed as deprecated
      // via the registry rule, see count=0, and silently skip.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "s1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["deprecated-load"])) findings.push(f);
      expect(findings).toEqual([]);
    });

    it("respects operator-supplied deprecated_min", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      for (let i = 0; i < 100; i++) {
        await store().commit(
          "s1",
          [{ name: "Repriced", data: { price: i } }],
          meta
        );
      }
      await store().commit(
        "s1",
        [{ name: "Renamed", data: { name: "rare" } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["deprecated-load"], {
        thresholds: { deprecated_min: 0.005 }, // 0.5%
      })) {
        findings.push(f);
      }
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "deprecated-load",
        name: "Renamed",
      });
    });
  });

  describe("dispatcher", () => {
    it("runs only the requested categories", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      // Seed both a schema violation AND deprecated load.
      await store().commit("w1", [{ name: "Vanished", data: {} }], meta);
      for (let i = 0; i < 5; i++) {
        await store().commit(
          "w1",
          [{ name: "Renamed", data: { name: "x" } }],
          meta
        );
      }

      const onlySchema: AuditFinding[] = [];
      for await (const f of app.audit(["schema"])) onlySchema.push(f);
      const onlyDep: AuditFinding[] = [];
      for await (const f of app.audit(["deprecated-load"])) onlyDep.push(f);
      expect(onlySchema.every((f) => f.category === "schema")).toBe(true);
      expect(onlyDep.every((f) => f.category === "deprecated-load")).toBe(true);
      // Selective runs DO NOT include findings from other categories.
      expect(onlySchema.some((f) => f.category === "deprecated-load")).toBe(
        false
      );
      expect(onlyDep.some((f) => f.category === "schema")).toBe(false);
    });

    it("supports early break", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      // Two unrelated unknown-name events — iterator should yield
      // findings one at a time, and `break` should stop cleanly.
      await store().commit("s1", [{ name: "Vanished", data: {} }], meta);
      await store().commit("s2", [{ name: "Vanished", data: {} }], meta);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["schema"])) {
        findings.push(f);
        break;
      }
      expect(findings).toHaveLength(1);
    });
  });

  describe("close-candidate category", () => {
    it("flags streams whose head event is in the operator's terminal list", async () => {
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "o1",
        [{ name: "OrderPlaced", data: { items: 3 } }],
        meta
      );
      await store().commit("o1", [{ name: "OrderShipped", data: {} }], meta);
      // Active order whose head isn't terminal — should NOT be flagged.
      await store().commit(
        "o2",
        [{ name: "OrderPlaced", data: { items: 1 } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["close-candidate"], {
        thresholds: { terminal_events: ["OrderShipped"], idle_days: 10_000 },
      })) {
        findings.push(f);
      }

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "close-candidate",
        stream: "o1",
        reason: "terminal",
        // Order state declares .snap() so restart is supported.
        restart_supported: true,
      });
    });

    it("flags idle streams when the head event is older than idle_days", async () => {
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "o1",
        [{ name: "OrderPlaced", data: { items: 2 } }],
        meta
      );
      // Tiny sleep so the head's `created` is strictly less than
      // Date.now() at audit time even with millisecond-precision
      // clocks.
      await sleep(20);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["close-candidate"], {
        thresholds: { idle_days: 0 },
      })) {
        findings.push(f);
      }
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "close-candidate",
        stream: "o1",
        reason: "idle",
      });
    });

    it("reports restart_supported: false for states without .snap()", async () => {
      // widget has no .snap() declared. An idle widget stream should
      // surface as a close-candidate with restart_supported: false.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 9 } }],
        meta
      );
      await sleep(20);
      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["close-candidate"], {
        thresholds: { idle_days: 0 },
      })) {
        findings.push(f);
      }
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        stream: "w1",
        reason: "idle",
        restart_supported: false,
      });
    });

    it("skips framework-marker heads (tombstoned / snapshot)", async () => {
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "o1",
        [
          { name: "OrderPlaced", data: { items: 1 } },
          { name: "__tombstone__", data: {} },
        ],
        meta
      );
      await sleep(20);
      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["close-candidate"], {
        thresholds: { idle_days: 0 },
      })) {
        findings.push(f);
      }
      // Stream's head is __tombstone__ → already closed → not a candidate.
      expect(findings).toEqual([]);
    });
  });

  describe("reaction-health category", () => {
    it("flags blocked streams", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      // Subscribe + block manually so the streams table has a
      // blocked entry for the audit to find. The framework's
      // drain machinery normally drives blocking; for tests we
      // hit the store directly.
      await store().subscribe([{ stream: "w1", source: "w1" }]);
      const claimed = await store().claim(1, 1, "audit-test", 60_000);
      if (claimed.length > 0) {
        await store().block([
          {
            ...claimed[0],
            at: 1,
            error: "audit test block",
          },
        ]);
      }

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["reaction-health"])) findings.push(f);
      const blockedFinding = findings.find(
        (f) => f.category === "reaction-health" && f.status === "blocked"
      );
      expect(blockedFinding).toBeDefined();
      expect(blockedFinding).toMatchObject({
        category: "reaction-health",
        stream: "w1",
        status: "blocked",
        reason: "audit test block",
      });
    });

    it("falls back to a placeholder reason when blocked without recorded error", async () => {
      // Some adapters can land a stream as blocked with an empty
      // `error` string (e.g. crash mid-block, manual operator
      // intervention). The audit should still flag it — with a
      // generic reason — rather than emitting an empty string.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      await store().subscribe([{ stream: "w1", source: "w1" }]);
      const s = (
        store() as unknown as {
          _streams: Map<string, { _blocked: boolean; _error: string }>;
        }
      )._streams.get("w1");
      if (s) {
        s._blocked = true;
        s._error = "";
      }

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["reaction-health"])) findings.push(f);
      const blockedFinding = findings.find(
        (f) => f.category === "reaction-health" && f.status === "blocked"
      );
      expect(blockedFinding).toBeDefined();
      expect(blockedFinding).toMatchObject({
        category: "reaction-health",
        stream: "w1",
        status: "blocked",
        reason: "blocked without recorded error",
      });
    });

    it("flags near-block streams when retry >= near_block", async () => {
      // Driving retry counts to >= threshold via public APIs
      // requires the drain machinery (failing reactions). For a
      // unit-level audit smoke test, reach into the in-memory
      // store's `_streams` map directly to set a retry count.
      // The audit reads `StreamPosition.retry` straight from
      // `query_streams`, so any value > threshold flags.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      await store().subscribe([{ stream: "w1", source: "w1" }]);
      // InMemoryStream exposes `retry` as a getter on `_retry`.
      // Reach in to bump _retry directly for the test setup.
      const s = (
        store() as unknown as {
          _streams: Map<string, { _retry: number }>;
        }
      )._streams.get("w1");
      if (s) s._retry = 5;

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["reaction-health"], {
        thresholds: { near_block: 3 },
      })) {
        findings.push(f);
      }
      const nearBlock = findings.find(
        (f) => f.category === "reaction-health" && f.status === "near-block"
      );
      expect(nearBlock).toMatchObject({
        category: "reaction-health",
        stream: "w1",
        status: "near-block",
        retry: 5,
      });
    });

    it("flags stuck-backoff for expired leases that weren't released", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      await store().subscribe([{ stream: "w1", source: "w1" }]);
      // Lease for a very short window — by the time the audit runs,
      // leased_until is in the past but no ack/block has cleared
      // leased_by.
      await store().claim(1, 1, "audit-stuck-test", 5);
      await sleep(20);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["reaction-health"], {
        // stuck_minutes: 0 makes any expired lease count.
        thresholds: { stuck_minutes: 0 },
      })) {
        findings.push(f);
      }
      const stuck = findings.find(
        (f) => f.category === "reaction-health" && f.status === "stuck-backoff"
      );
      expect(stuck).toBeDefined();
    });
  });

  describe("snapshot-drift category", () => {
    it("flags streams above driftMin without any snapshots", async () => {
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      for (let i = 0; i < 30; i++) {
        await store().commit(
          "big",
          [{ name: "OrderPlaced", data: { items: i } }],
          meta
        );
      }

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["snapshot-drift"], {
        thresholds: { drift_min: 20 },
      })) {
        findings.push(f);
      }
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "snapshot-drift",
        stream: "big",
        events_since_snap: 30,
      });
      expect((findings[0] as { snap_at?: number }).snap_at).toBeUndefined();
    });

    it("counts only events after the last __snapshot__ when one exists", async () => {
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      // Sandwich: 5 events, 1 snapshot, 15 events.
      for (let i = 0; i < 5; i++) {
        await store().commit(
          "s",
          [{ name: "OrderPlaced", data: { items: i } }],
          meta
        );
      }
      await store().commit("s", [{ name: "__snapshot__", data: {} }], meta);
      for (let i = 0; i < 15; i++) {
        await store().commit(
          "s",
          [{ name: "OrderPlaced", data: { items: i + 100 } }],
          meta
        );
      }

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["snapshot-drift"], {
        thresholds: { drift_min: 10 },
      })) {
        findings.push(f);
      }
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "snapshot-drift",
        stream: "s",
        events_since_snap: 15,
      });
      expect((findings[0] as { snap_at?: number }).snap_at).toBeDefined();
    });

    it("skips streams whose state has no .snap() reducer", async () => {
      // widget doesn't declare .snap() — snapshot drift isn't a
      // meaningful signal there because snapshots would never fire.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      for (let i = 0; i < 30; i++) {
        await store().commit(
          "w1",
          [{ name: "Repriced", data: { price: i } }],
          meta
        );
      }
      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["snapshot-drift"], {
        thresholds: { drift_min: 10 },
      })) {
        findings.push(f);
      }
      expect(findings).toEqual([]);
    });
  });

  describe("restart-candidate category", () => {
    it("flags streams above the event-count threshold when state has .snap()", async () => {
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      for (let i = 0; i < 25; i++) {
        await store().commit(
          "big",
          [{ name: "OrderPlaced", data: { items: i } }],
          meta
        );
      }
      // Small stream → should NOT be flagged.
      await store().commit(
        "small",
        [{ name: "OrderPlaced", data: { items: 0 } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["restart-candidate"], {
        thresholds: { restart_min: 20 },
      })) {
        findings.push(f);
      }
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "restart-candidate",
        stream: "big",
        count: 25,
        snaps: 0,
      });
    });

    it("skips streams whose state has no .snap() reducer", async () => {
      // widget doesn't declare .snap() — restart wouldn't work,
      // so the audit silently skips it for restart-candidate.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      for (let i = 0; i < 25; i++) {
        await store().commit(
          "big",
          [{ name: "Repriced", data: { price: i } }],
          meta
        );
      }
      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["restart-candidate"], {
        thresholds: { restart_min: 20 },
      })) {
        findings.push(f);
      }
      expect(findings).toEqual([]);
    });
  });

  describe("routing-health category", () => {
    it("flags streams whose lane isn't in the running registry", async () => {
      const app = act().withState(widget).build();
      // Subscribe a stream with a lane the running registry doesn't
      // declare. Lanes are restart-driven; the audit just reports
      // what's in the streams table vs what's currently configured.
      await store().subscribe([
        { stream: "w1", source: "w1", lane: "deprecated-lane" },
      ]);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["routing-health"])) findings.push(f);
      const unknownLane = findings.find(
        (f) => f.category === "routing-health" && f.reason === "unknown-lane"
      );
      expect(unknownLane).toMatchObject({
        category: "routing-health",
        stream: "w1",
        reason: "unknown-lane",
        lane: "deprecated-lane",
      });
    });

    it("does not flag a legitimately-excluded lane on an onlyLanes instance (#1224)", async () => {
      // A worker deployed with onlyLanes:['fast'] builds no controller
      // for the 'slow' lane — but 'slow' is still a DECLARED lane of the
      // app (another worker drains it). A stream correctly assigned
      // lane 'slow' must NOT be flagged as unknown-lane: the audit
      // compares against the declared universe (default + every
      // .withLane name), not this instance's active controller set.
      const app = act()
        .withState(widget)
        .withLane({ name: "slow" })
        .withLane({ name: "fast" })
        .build({ onlyLanes: ["fast"] });
      await store().subscribe([{ stream: "w1", source: "w1", lane: "slow" }]);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["routing-health"])) findings.push(f);
      const unknownLane = findings.filter(
        (f) => f.category === "routing-health" && f.reason === "unknown-lane"
      );
      expect(unknownLane).toEqual([]);
    });

    it("flags events whose name has no registered reaction", async () => {
      // widget declares events but no reactions — every event name
      // is "unrouted" from a reaction perspective.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["routing-health"])) findings.push(f);
      const unrouted = findings.filter(
        (f) => f.category === "routing-health" && f.reason === "unrouted"
      );
      expect(unrouted.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("correlation-gaps category", () => {
    it("flags events whose causation.event.id points at a missing parent", async () => {
      const app = act().withState(widget).build();
      // Event 1: a stand-alone event (no parent — fine).
      await store().commit("w1", [{ name: "Repriced", data: { price: 1 } }], {
        correlation: "c1",
        causation: {},
      });
      // Event 2: a "reaction" event whose causation references id
      // 999 — doesn't exist. Audit should flag it.
      await store().commit("w1", [{ name: "Repriced", data: { price: 2 } }], {
        correlation: "c1",
        causation: { event: { id: 999, stream: "fake", name: "fake" } },
      } as unknown as { correlation: string; causation: object });

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["correlation-gaps"])) findings.push(f);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "correlation-gaps",
        reason: "orphan-parent",
      });
    });

    it("does not flag initial action commits without an event parent", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "c1", causation: {} };
      for (let i = 0; i < 5; i++) {
        await store().commit(
          "w1",
          [{ name: "Repriced", data: { price: i } }],
          meta
        );
      }
      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["correlation-gaps"])) findings.push(f);
      expect(findings).toEqual([]);
    });
  });

  describe("clock-anomalies category", () => {
    it("yields nothing under normal monotonic commits", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "c1", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      await sleep(20);
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 2 } }],
        meta
      );
      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["clock-anomalies"])) findings.push(f);
      expect(findings).toEqual([]);
    });

    it("flags future-dated events", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "c1", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      // Force the committed event's `created` 1 hour into the
      // future via direct in-memory mutation — simulates a writer
      // whose clock was ahead of audit time.
      const events = (
        store() as unknown as {
          _events: Array<{ created: Date }>;
        }
      )._events;
      for (const e of events) {
        e.created = new Date(Date.now() + 60 * 60 * 1000);
      }

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["clock-anomalies"])) findings.push(f);
      const future = findings.find(
        (f) => f.category === "clock-anomalies" && f.reason === "future-created"
      );
      expect(future).toBeDefined();
    });

    it("flags out-of-order per-stream timestamps", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "c1", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 2 } }],
        meta
      );
      // Backdate event 2 so its `created` is earlier than event
      // 1 — simulates a writer whose clock jumped backward
      // between commits.
      const events = (
        store() as unknown as {
          _events: Array<{ stream: string; created: Date }>;
        }
      )._events;
      const onW1 = events.filter((e) => e.stream === "w1");
      onW1[0].created = new Date(Date.now() - 5 * 60 * 1000);
      onW1[1].created = new Date(Date.now() - 15 * 60 * 1000);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["clock-anomalies"])) findings.push(f);
      const ooo = findings.find(
        (f) => f.category === "clock-anomalies" && f.reason === "out-of-order"
      );
      expect(ooo).toMatchObject({
        category: "clock-anomalies",
        stream: "w1",
        reason: "out-of-order",
      });
    });
  });

  // Coverage of branches that are reachable but only via specific
  // configurations not exercised by the main scenario tests above.
  // Each test names the branch it's there for so future readers know
  // why it exists.
  describe("branch coverage edge cases", () => {
    // Second deprecation family on top of widget — so the sort
    // callback (`(a,b) => b.count - a.count` on the deprecated set)
    // actually runs with 2+ items.
    const twoDeprecated = state({
      Two: z.object({ a: z.number(), b: z.number() }),
    })
      .init(() => ({ a: 0, b: 0 }))
      .emits({
        Alpha: z.object({ a: z.number() }),
        Alpha_v2: z.object({ a: z.number() }),
        Beta: z.object({ b: z.number() }),
        Beta_v2: z.object({ b: z.number() }),
      })
      .patch({
        Alpha: ({ data }, s) => ({ ...s, a: data.a }),
        Alpha_v2: ({ data }, s) => ({ ...s, a: data.a }),
        Beta: ({ data }, s) => ({ ...s, b: data.b }),
        Beta_v2: ({ data }, s) => ({ ...s, b: data.b }),
      })
      .on({ noop: z.object({}) })
      .emit(() => ["Alpha_v2", { a: 0 }])
      .build();

    it("sorts multiple deprecated event families by descending count", async () => {
      const app = act().withState(twoDeprecated).build();
      const meta = { correlation: "test-corr", causation: {} };
      // Beta has more events than Alpha — both deprecated.
      for (let i = 0; i < 3; i++) {
        await store().commit("s", [{ name: "Alpha", data: { a: i } }], meta);
      }
      for (let i = 0; i < 7; i++) {
        await store().commit("s", [{ name: "Beta", data: { b: i } }], meta);
      }

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["deprecated-load"], {
        thresholds: { deprecated_min: 0.1 },
      })) {
        findings.push(f);
      }
      // Both deprecated event families surface, Beta first (higher count).
      const names = findings.map((f) => (f as { name: string }).name);
      expect(names).toEqual(["Beta", "Alpha"]);
    });

    it("restart-candidate skips streams whose head is a framework marker", async () => {
      // count > threshold AND head is __tombstone__ → skip.
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      for (let i = 0; i < 25; i++) {
        await store().commit(
          "tomb",
          [{ name: "OrderPlaced", data: { items: i } }],
          meta
        );
      }
      await store().commit("tomb", [{ name: "__tombstone__", data: {} }], meta);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["restart-candidate"], {
        thresholds: { restart_min: 20 },
      })) {
        findings.push(f);
      }
      expect(findings).toEqual([]);
    });

    it("reaction-health yields nothing for healthy subscribed streams", async () => {
      // Subscribed stream, no lease, no retries, not blocked → audit
      // visits the row via query_streams and yields no finding.
      // Exercises the "all checks fail" path through on_stream.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "healthy",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      await store().subscribe([{ stream: "healthy", source: "healthy" }]);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["reaction-health"])) findings.push(f);
      expect(findings).toEqual([]);
    });

    it("snapshot-drift skips streams whose head is a framework marker", async () => {
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      for (let i = 0; i < 30; i++) {
        await store().commit(
          "tomb",
          [{ name: "OrderPlaced", data: { items: i } }],
          meta
        );
      }
      await store().commit("tomb", [{ name: "__tombstone__", data: {} }], meta);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["snapshot-drift"], {
        thresholds: { drift_min: 20 },
      })) {
        findings.push(f);
      }
      expect(findings).toEqual([]);
    });

    it("snapshot-drift skips streams below driftMin", async () => {
      // Stream with snap state but only a handful of events → not
      // worth a drift finding.
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      for (let i = 0; i < 3; i++) {
        await store().commit(
          "tiny",
          [{ name: "OrderPlaced", data: { items: i } }],
          meta
        );
      }
      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["snapshot-drift"], {
        thresholds: { drift_min: 20 },
      })) {
        findings.push(f);
      }
      expect(findings).toEqual([]);
    });

    it("snapshot-drift skips streams whose post-snapshot count is below driftMin", async () => {
      const app = act().withState(order).build();
      const meta = { correlation: "test-corr", causation: {} };
      // Total events ≥ driftMin to enter the candidate set, but
      // post-snapshot count is below threshold.
      for (let i = 0; i < 15; i++) {
        await store().commit(
          "fresh",
          [{ name: "OrderPlaced", data: { items: i } }],
          meta
        );
      }
      await store().commit("fresh", [{ name: "__snapshot__", data: {} }], meta);
      // Only a couple of events after the snapshot — not enough to flag.
      for (let i = 0; i < 2; i++) {
        await store().commit(
          "fresh",
          [{ name: "OrderPlaced", data: { items: 100 + i } }],
          meta
        );
      }
      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["snapshot-drift"], {
        thresholds: { drift_min: 10 },
      })) {
        findings.push(f);
      }
      expect(findings).toEqual([]);
    });

    it("routing-health ignores streams subscribed without a lane string", async () => {
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "nolane",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      await store().subscribe([{ stream: "nolane", source: "nolane" }]);
      // Force-empty the stream's lane field — adapters can land
      // rows with empty lane after manual ops.
      const s = (
        store() as unknown as {
          _streams: Map<string, { _lane: string }>;
        }
      )._streams.get("nolane");
      if (s) s._lane = "";

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["routing-health"])) findings.push(f);
      const unknownLane = findings.filter(
        (f) => f.category === "routing-health" && f.reason === "unknown-lane"
      );
      expect(unknownLane).toEqual([]);
    });

    it("routing-health ignores streams whose lane is declared", async () => {
      // Default lane is always declared — subscribe without specifying
      // a lane lands on the default and should NOT be flagged.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "defaultlane",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );
      await store().subscribe([
        { stream: "defaultlane", source: "defaultlane" },
      ]);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["routing-health"])) findings.push(f);
      const unknownLane = findings.filter(
        (f) => f.category === "routing-health" && f.reason === "unknown-lane"
      );
      expect(unknownLane).toEqual([]);
    });

    it("routing-health ignores framework-marker event names in the unrouted scan", async () => {
      // __snapshot__ shows up in the workspace names map but must not
      // be flagged as unrouted — it's a framework concern.
      const app = act().withState(widget).build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit("w1", [{ name: "__snapshot__", data: {} }], meta);

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["routing-health"])) findings.push(f);
      const unrouted = findings.filter(
        (f) => f.category === "routing-health" && f.reason === "unrouted"
      );
      expect(unrouted).toEqual([]);
    });

    it("routing-health does not flag event names with a registered reaction", async () => {
      // Build a state with a slice that REACTS to Repriced — so
      // Repriced is in `routedEventNames` and shouldn't be unrouted.
      const targeted = state({
        Routed: z.object({ touched: z.boolean() }),
      })
        .init(() => ({ touched: false }))
        .emits({ RoutedHit: z.object({}) })
        .patch({ RoutedHit: () => ({ touched: true }) })
        .on({ trigger: z.object({}) })
        .emit(() => ["RoutedHit", {}])
        // The on().emit() pairing above declares a reaction-side
        // entry — the `targeted.events.RoutedHit` mapping marks
        // RoutedHit as routed for the orchestrator.
        .build();
      const sender = widget;
      // Stand up an app combining widget (emits Repriced) and a
      // projection that reacts to Repriced — so Repriced is routed.
      const tracked = projection("tracked")
        .on({ Repriced: z.object({ price: z.number() }) })
        .do(async function trackRepriced() {
          await Promise.resolve();
        })
        .build();
      const app = act()
        .withState(targeted)
        .withState(sender)
        .withProjection(tracked)
        .build();
      const meta = { correlation: "test-corr", causation: {} };
      await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        meta
      );

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["routing-health"])) findings.push(f);
      // Repriced was routed; should NOT appear as unrouted.
      const repricedUnrouted = findings.find(
        (f) =>
          f.category === "routing-health" &&
          f.reason === "unrouted" &&
          (f as { name?: string }).name === "Repriced"
      );
      expect(repricedUnrouted).toBeUndefined();
    });

    it("correlation-gaps does not flag events whose parent exists", async () => {
      const app = act().withState(widget).build();
      // Commit parent event first.
      const [parent] = await store().commit(
        "w1",
        [{ name: "Repriced", data: { price: 1 } }],
        { correlation: "c1", causation: {} }
      );
      // Child event whose causation.event.id points at the real parent.
      await store().commit("w1", [{ name: "Repriced", data: { price: 2 } }], {
        correlation: "c1",
        causation: {
          event: {
            id: parent.id,
            stream: parent.stream,
            name: String(parent.name),
          },
        },
      } as unknown as { correlation: string; causation: object });

      const findings: AuditFinding[] = [];
      for await (const f of app.audit(["correlation-gaps"])) findings.push(f);
      expect(findings).toEqual([]);
    });
  });
});
