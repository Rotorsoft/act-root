/**
 * ACT-403: auto-deprecation of legacy event versions.
 *
 * The framework reads the `_v<digits>` versioning convention from the
 * merged event registry. Within a state's events, the highest version is
 * current; everything else is auto-deprecated. Build throws on static
 * `.emit("Old")` targeting a deprecated event; the commit path warns at
 * runtime for dynamic emits. The reduce / `.patch()` path stays silent.
 */
import { z } from "zod";
import { act, dispose, log, state, store, ZodEmpty } from "../src/index.js";
import {
  current_version_of,
  deprecated_event_names,
} from "../src/internal/event-versions.js";

describe("deprecation (ACT-403)", () => {
  beforeEach(async () => {
    await store().drop();
  });

  afterAll(async () => {
    await dispose()();
  });

  const actor = { id: "a", name: "a" };
  let streamId = 0;
  const nextStream = () => `dep-${++streamId}`;

  describe("deprecated_event_names", () => {
    it("flags nothing when every event is a single version", () => {
      expect([...deprecated_event_names(["Foo", "Bar", "Baz"])]).toEqual([]);
    });

    it("flags the base when a _v2 sibling exists", () => {
      expect([...deprecated_event_names(["Foo", "Foo_v2"])]).toEqual(["Foo"]);
    });

    it("flags base and v2 when v3 exists", () => {
      const d = deprecated_event_names(["Foo", "Foo_v2", "Foo_v3"]);
      expect([...d].sort()).toEqual(["Foo", "Foo_v2"]);
    });

    it("allows gaps — {Foo, Foo_v3} deprecates Foo only", () => {
      const d = deprecated_event_names(["Foo", "Foo_v3"]);
      expect([...d]).toEqual(["Foo"]);
    });

    it("treats _v1 as a literal name (no grouping with the base)", () => {
      // `Foo_v1` and `Foo` are distinct events under the convention;
      // version suffixes start at 2.
      const d = deprecated_event_names(["Foo", "Foo_v1"]);
      expect([...d]).toEqual([]);
    });

    it("works when only versioned siblings exist (no base)", () => {
      const d = deprecated_event_names(["Foo_v2", "Foo_v3"]);
      expect([...d]).toEqual(["Foo_v2"]);
    });
  });

  describe("current_version_of", () => {
    it("returns the highest-numbered sibling for a deprecated event", () => {
      expect(current_version_of("Foo", ["Foo", "Foo_v2", "Foo_v3"])).toBe(
        "Foo_v3"
      );
    });

    it("returns undefined when the input event is itself the highest", () => {
      expect(current_version_of("Foo_v3", ["Foo", "Foo_v2", "Foo_v3"])).toBe(
        undefined
      );
    });

    it("returns undefined for a single-version event", () => {
      expect(current_version_of("Foo", ["Foo"])).toBe(undefined);
    });

    it("skips unrelated event names when searching for the current version", () => {
      // The "Bar" event shares the registry but not the base name —
      // it must be ignored during the version-pair lookup.
      expect(
        current_version_of("Foo", ["Foo", "Bar", "Foo_v2", "Baz_v2"])
      ).toBe("Foo_v2");
    });

    it("keeps the highest when iteration encounters a lower version after a higher one", () => {
      // Map.values()/Object.keys() iteration is insertion order, but
      // we should still pick the max regardless of order. Provide a
      // non-monotonic sequence to exercise the "skip lower" branch.
      expect(current_version_of("Foo", ["Foo_v3", "Foo", "Foo_v2"])).toBe(
        "Foo_v3"
      );
    });
  });

  describe("build-time enforcement (static .emit)", () => {
    it("throws when an action statically emits a deprecated event", () => {
      const Counter = state({ Counter: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({
          Inc: ZodEmpty,
          Inc_v2: ZodEmpty,
        })
        .patch({
          Inc: () => ({}),
          Inc_v2: () => ({}),
        })
        .on({ doInc: ZodEmpty })
        .emit("Inc") // ← static target of deprecated event
        .build();

      expect(() => act().withState(Counter).build()).toThrow(
        /Action "doInc" in state "Counter" emits deprecated event "Inc".*A newer version exists: "Inc_v2"/s
      );
    });

    it("error message tells the developer the reducer stays", () => {
      const Counter = state({ Counter: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Inc: ZodEmpty, Inc_v2: ZodEmpty })
        .patch({ Inc: () => ({}), Inc_v2: () => ({}) })
        .on({ doInc: ZodEmpty })
        .emit("Inc")
        .build();

      expect(() => act().withState(Counter).build()).toThrow(
        /reducer \(\.patch\) for "Inc" stays as-is/
      );
    });

    it("allows static .emit() when targeting the current version", () => {
      const Counter = state({ Counter: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Inc: ZodEmpty, Inc_v2: ZodEmpty })
        .patch({ Inc: () => ({}), Inc_v2: () => ({}) })
        .on({ doInc: ZodEmpty })
        .emit("Inc_v2") // current version
        .build();

      expect(() => act().withState(Counter).build()).not.toThrow();
    });

    it("allows single-version events with no siblings (no deprecation)", () => {
      const Counter = state({ Counter: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Inc: ZodEmpty })
        .patch({ Inc: () => ({}) })
        .on({ doInc: ZodEmpty })
        .emit("Inc")
        .build();

      expect(() => act().withState(Counter).build()).not.toThrow();
    });

    it("throws on the lower-but-not-base version when three versions exist", () => {
      const Counter = state({ Counter: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({
          Inc: ZodEmpty,
          Inc_v2: ZodEmpty,
          Inc_v3: ZodEmpty,
        })
        .patch({
          Inc: () => ({}),
          Inc_v2: () => ({}),
          Inc_v3: () => ({}),
        })
        .on({ doInc: ZodEmpty })
        .emit("Inc_v2") // still deprecated — v3 is current
        .build();

      expect(() => act().withState(Counter).build()).toThrow(
        /emits deprecated event "Inc_v2".*newer version exists: "Inc_v3"/s
      );
    });
  });

  describe("runtime warning (dynamic .emit)", () => {
    it("warns once per process when a dynamic emit produces a deprecated event", async () => {
      const warnSpy = vi.spyOn(log(), "warn");

      const Counter = state({ Counter: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Tick: ZodEmpty, Tick_v2: ZodEmpty })
        .patch({ Tick: () => ({}), Tick_v2: () => ({}) })
        .on({ doTick: ZodEmpty })
        .emit(() => ["Tick", {}]) // dynamic form, escapes static check
        .build();

      const app = act().withState(Counter).build();
      const stream = nextStream();

      await app.do("doTick", { stream, actor }, {});
      await app.do("doTick", { stream, actor }, {});
      await app.do("doTick", { stream, actor }, {});

      const deprecationWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0] ?? "").includes('deprecated event "Tick"')
      );
      expect(deprecationWarns).toHaveLength(1);
      expect(String(deprecationWarns[0][0])).toMatch(/warned once per process/);

      warnSpy.mockRestore();
    });

    it("does not warn when the dynamic emit targets the current version", async () => {
      const warnSpy = vi.spyOn(log(), "warn");

      const Counter = state({ Counter: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Tick: ZodEmpty, Tick_v2: ZodEmpty })
        .patch({ Tick: () => ({}), Tick_v2: () => ({}) })
        .on({ doTick: ZodEmpty })
        .emit(() => ["Tick_v2", {}])
        .build();

      const app = act().withState(Counter).build();
      const stream = nextStream();

      await app.do("doTick", { stream, actor }, {});
      await app.do("doTick", { stream, actor }, {});

      const deprecationWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0] ?? "").includes("deprecated event")
      );
      expect(deprecationWarns).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it("logs a startup advisory listing deprecated events with their current versions", () => {
      const infoSpy = vi.spyOn(log(), "info");

      const Counter = state({ Counter: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Tick: ZodEmpty, Tick_v2: ZodEmpty })
        .patch({ Tick: () => ({}), Tick_v2: () => ({}) })
        .on({ doTick: ZodEmpty })
        .emit(() => ["Tick_v2", {}])
        .build();

      act().withState(Counter).build();

      const advisory = infoSpy.mock.calls.find((c) =>
        String(c[0] ?? "").includes("deprecated event(s)")
      );
      expect(advisory).toBeDefined();
      const msg = String(advisory![0]);
      expect(msg).toMatch(/registered 1 deprecated event\(s\)/);
      expect(msg).toMatch(/"Tick".*current: "Tick_v2".*state: "Counter"/);
      expect(msg).toMatch(/app\.close\(\)/);
      expect(msg).toMatch(/event-schema-evolution\.md/);

      infoSpy.mockRestore();
    });

    it("does not log the startup advisory when no states have deprecated events", () => {
      const infoSpy = vi.spyOn(log(), "info");

      const Plain = state({ Plain: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Tick: ZodEmpty })
        .patch({ Tick: () => ({}) })
        .on({ doTick: ZodEmpty })
        .emit(() => ["Tick", {}])
        .build();

      act().withState(Plain).build();

      const advisory = infoSpy.mock.calls.find((c) =>
        String(c[0] ?? "").includes("deprecated event(s)")
      );
      expect(advisory).toBeUndefined();

      infoSpy.mockRestore();
    });

    it("does not warn on reducer / .patch() replay of historical deprecated events", async () => {
      const stream = nextStream();

      // First: commit a Tick event using a state with no newer version
      // (no deprecation in scope).
      const Producer = state({ Producer: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Tick: ZodEmpty })
        .patch({ Tick: () => ({}) })
        .on({ produce: ZodEmpty })
        .emit("Tick")
        .build();
      const producerApp = act().withState(Producer).build();
      await producerApp.do("produce", { stream, actor }, {});

      // Now build a different app whose state has Tick + Tick_v2 (so Tick
      // is deprecated). Loading the historical Tick event must go
      // through the reducer path without warning — historical events
      // are immutable and always need their reducer.
      const warnSpy = vi.spyOn(log(), "warn");
      const Consumer = state({ Producer: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Tick: ZodEmpty, Tick_v2: ZodEmpty })
        .patch({ Tick: () => ({}), Tick_v2: () => ({}) })
        .on({ produce: ZodEmpty })
        .emit("Tick_v2") // current version only
        .build();
      const consumerApp = act().withState(Consumer).build();

      await consumerApp.load(Consumer, stream);

      const deprecationWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0] ?? "").includes("deprecated event")
      );
      expect(deprecationWarns).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });
});
