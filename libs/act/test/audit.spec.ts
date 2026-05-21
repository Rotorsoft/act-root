import { z } from "zod";
import { act, dispose, state, store } from "../src/index.js";
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
      expect((findings[0] as { zodError?: unknown }).zodError).toBeDefined();
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
        eventName: "Renamed",
        currentVersion: "Renamed_v2",
        totalCount: 12,
      });
      // top-streams sorted desc, with the right per-stream counts
      const findingWithStreams = f as Extract<
        AuditFinding,
        { category: "deprecated-load" }
      >;
      expect(findingWithStreams.topStreams).toEqual([
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

    it("respects operator-supplied deprecatedLoadShareMin", async () => {
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
        thresholds: { deprecatedLoadShareMin: 0.005 }, // 0.5%
      })) {
        findings.push(f);
      }
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        category: "deprecated-load",
        eventName: "Renamed",
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
      const both: AuditFinding[] = [];
      for await (const f of app.audit()) both.push(f);

      expect(onlySchema.every((f) => f.category === "schema")).toBe(true);
      expect(onlyDep.every((f) => f.category === "deprecated-load")).toBe(true);
      // Default (no list) runs everything; in slice 1 that's both
      // categories.
      expect(both.length).toBe(onlySchema.length + onlyDep.length);
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
});
