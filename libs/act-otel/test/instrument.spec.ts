import { act, state, ZodEmpty } from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { register as global_registry, Registry } from "prom-client";
import { describe, expect } from "vitest";
import { z } from "zod";
import {
  DEFAULT_BLOCKED_STREAMS_LIMIT,
  DEFAULT_METRIC_PREFIX,
  instrument,
} from "../src/index.js";

const counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ ticked: ZodEmpty })
  .patch({ ticked: () => ({}) })
  .on({ tick: ZodEmpty })
  .emit(() => ["ticked", {}])
  .build();

const actor = { id: "a", name: "a" };

const test = fixture(
  act()
    .withState(counter)
    .on("ticked")
    .do(async function noop() {})
    .to("sink")
);

const value = async (registry: Registry, name: string, labels = {}) => {
  const metric = await registry.getSingleMetric(name)?.get();
  const entry = metric?.values.find(
    (v) => JSON.stringify(v.labels) === JSON.stringify(labels)
  );
  return entry?.value;
};

describe("instrument", () => {
  test("counts commits, acks, and settles from a live app", async ({ app }) => {
    const registry = new Registry();
    const dispose = instrument(app, { registry });

    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();
    await app.drain();
    app.emit("settled", { fetched: [], leased: [], acked: [], blocked: [] });

    expect(
      await value(registry, "act_events_committed_total", { name: "ticked" })
    ).toBe(1);
    expect(
      await value(registry, "act_reactions_acked_total", { lane: "default" })
    ).toBe(1);
    expect(await value(registry, "act_settled_total")).toBe(1);
    // The blocked gauge evaluates per scrape — nothing is blocked here.
    await registry.metrics();
    expect(await value(registry, "act_streams_blocked")).toBe(0);

    await dispose();
  });

  test("counts every synthesized lifecycle event", async ({ app }) => {
    const registry = new Registry();
    const dispose = instrument(app, { registry });

    app.emit("blocked", [
      {
        stream: "b1",
        at: 0,
        by: "w",
        retry: 3,
        lagging: true,
        lane: "slow",
        error: "boom",
      },
    ]);
    app.emit("closed", {
      truncated: new Map([["c1", { deleted: 2 }]]) as never,
      skipped: [] as never,
    } as never);
    app.emit("forgotten", { stream: "f1", at: new Date(), eventCount: 3 });
    app.emit("notified", { stream: "n1", events: [{ id: 1, name: "ticked" }] });
    app.emit("error", { error: new Error("x"), circuit: "open" });

    expect(
      await value(registry, "act_reactions_blocked_total", { lane: "slow" })
    ).toBe(1);
    expect(await value(registry, "act_streams_closed_total")).toBe(1);
    expect(await value(registry, "act_events_forgotten_total")).toBe(3);
    expect(await value(registry, "act_notifications_total")).toBe(1);
    expect(await value(registry, "act_errors_total", { circuit: "open" })).toBe(
      1
    );

    await dispose();
  });

  test("falls back to the default lane label", async ({ app }) => {
    const registry = new Registry();
    const dispose = instrument(app, { registry });

    app.emit("acked", [
      { stream: "a1", at: 1, by: "w", retry: -1, lagging: true },
    ]);
    app.emit("blocked", [
      { stream: "b2", at: 0, by: "w", retry: 3, lagging: true, error: "boom" },
    ]);

    expect(
      await value(registry, "act_reactions_acked_total", { lane: "default" })
    ).toBe(1);
    expect(
      await value(registry, "act_reactions_blocked_total", { lane: "default" })
    ).toBe(1);

    await dispose();
  });

  test("dispose detaches listeners and unregisters metrics", async ({
    app,
  }) => {
    const registry = new Registry();
    const dispose = instrument(app, { registry });
    await dispose();

    app.emit("settled", { fetched: [], leased: [], acked: [], blocked: [] });
    expect(registry.getSingleMetric("act_settled_total")).toBeUndefined();
    expect((await registry.metrics()).trim()).toBe("");
  });

  test("gauge reflects blocked streams and honors the limit", async ({
    app,
  }) => {
    const registry = new Registry();
    const seen: number[] = [];
    // A structural surface is enough — same contract the real app meets.
    const surface = {
      on: app.on.bind(app),
      off: app.off.bind(app),
      blocked_streams: async (o?: { limit?: number }) => {
        seen.push(o?.limit as number);
        return [{}, {}, {}];
      },
    };
    const dispose = instrument(surface as never, {
      registry,
      blockedStreamsLimit: 7,
    });
    await registry.metrics();
    expect(await value(registry, "act_streams_blocked")).toBe(3);
    // Reading the gauge value re-runs collect — every call saw the limit.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === 7)).toBe(true);
    await dispose();
  });

  test("registers on the global prom-client registry by default", async ({
    app,
  }) => {
    const dispose = instrument(app);
    expect(
      global_registry.getSingleMetric(`${DEFAULT_METRIC_PREFIX}settled_total`)
    ).toBeDefined();
    await dispose();
    expect(
      global_registry.getSingleMetric(`${DEFAULT_METRIC_PREFIX}settled_total`)
    ).toBeUndefined();
  });

  test("supports a custom prefix and rejects illegal ones", async ({ app }) => {
    const registry = new Registry();
    const dispose = instrument(app, { registry, prefix: "myapp_" });
    expect(registry.getSingleMetric("myapp_settled_total")).toBeDefined();
    await dispose();

    expect(() => instrument(app, { registry, prefix: "act." })).toThrow(
      "Prometheus-legal"
    );
    expect(() => instrument(app, { registry: {} as never })).toThrow(
      "prom-client Registry"
    );
    expect(() =>
      instrument(app, { registry, blockedStreamsLimit: 0 })
    ).toThrow();
  });

  test("default blocked-streams limit reaches the app", async ({ app }) => {
    const registry = new Registry();
    const seen: Array<number | undefined> = [];
    const surface = {
      on: app.on.bind(app),
      off: app.off.bind(app),
      blocked_streams: async (o?: { limit?: number }) => {
        seen.push(o?.limit);
        return [];
      },
    };
    const dispose = instrument(surface as never, { registry });
    await registry.metrics();
    expect(seen).toEqual([DEFAULT_BLOCKED_STREAMS_LIMIT]);
    await dispose();
  });

  test("a blocked_streams rejection does not poison the whole scrape", async ({
    app,
  }) => {
    const registry = new Registry();
    const surface = {
      on: app.on.bind(app),
      off: app.off.bind(app),
      blocked_streams: async () => {
        throw new Error("store degraded");
      },
    };
    const dispose = instrument(surface as never, { registry });

    // Drive a real counter so we can assert the rest of the scrape survives.
    app.emit("settled", { fetched: [], leased: [], acked: [], blocked: [] });

    // The whole registry.metrics() must still RESOLVE despite the gauge's
    // collect() rejecting — otherwise a degraded store blinds every metric.
    const scrape = await registry.metrics();
    expect(scrape).toContain("act_settled_total 1");
    expect(await value(registry, "act_settled_total")).toBe(1);

    await dispose();
  });

  test("a second instrument() on the same registry is idempotent", async ({
    app,
  }) => {
    const registry = new Registry();
    // Two independent app surfaces sharing one registry — e.g. two Acts in
    // one process both exporting to the same /metrics endpoint. Each surface
    // captures its own "settled" listener so we can fire them separately.
    const settled: Array<() => void> = [];
    const makeSurface = () => ({
      on: (event: string, listener: () => void) => {
        if (event === "settled") settled.push(listener);
      },
      off: () => {},
      blocked_streams: async () => [],
    });
    void app;

    const dispose1 = instrument(makeSurface() as never, { registry });
    // Second bridge on the same registry must NOT throw
    // 'already been registered'; it reuses the existing metrics.
    const dispose2 = instrument(makeSurface() as never, { registry });

    // Each bridge attached its own settled listener to its own surface.
    for (const l of settled) l();
    // Both apps' settled events increment the one shared counter.
    expect(await value(registry, "act_settled_total")).toBe(2);

    await dispose1();
    await dispose2();
  });
});
