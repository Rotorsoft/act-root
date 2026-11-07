import {
  act,
  type Committed,
  type EventSource,
  InMemoryCache,
  InMemoryStore,
  type Query,
  type ScanOptions,
  type Schemas,
  type Store,
  type SubscribeInput,
  sleep,
  state,
  ZodEmpty,
} from "@rotorsoft/act";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { scan } from "../src/internal/event-sourcing.js";
import { sandbox } from "../src/test/index.js";
import { Calculator } from "./calculator.js";

/**
 * Internal scan helper + orchestrator `Act.restore`.
 * Validates each event inline (negative version, malformed `created`)
 * and throws on the first blocker; adapters take the driver and own
 * the transaction wrap.
 */
type E = Committed<Schemas, string>;

const baseEvent = (overrides: Partial<E> = {}): E =>
  ({
    id: 1,
    name: "Tick",
    data: {},
    stream: "s",
    version: 0,
    created: new Date("2024-01-01T00:00:00.000Z"),
    meta: { correlation: "c", causation: {} },
    ...overrides,
  }) as unknown as E;

/**
 * Adapt an event array into the {@link EventSource} contract — the
 * shape `scan` and `Act.restore` consume.
 * `await Promise.resolve(callback(e))` mirrors the adapter pattern so async-callback backpressure is exercised even
 * from this synthetic source.
 *
 * Honors `after`/`limit` filters because `scan` paginates:
 * it asks for events with `id > after` up to `limit`.
 * Sources that ignore the filter (CsvFile-style) get tested
 * separately in `csv.spec.ts`.
 */
function fromArray(events: E[]): EventSource {
  return {
    async query(callback, filter?) {
      const after = filter?.after ?? 0;
      const before = filter?.before ?? Number.POSITIVE_INFINITY;
      const limit = filter?.limit ?? Number.POSITIVE_INFINITY;
      let slice = events.filter((e) => e.id > after && e.id < before);
      if (filter?.backward) slice = [...slice].reverse();
      slice = slice.slice(0, limit);
      for (const e of slice)
        await Promise.resolve((callback as (event: E) => void)(e));
      return slice.length;
    },
    async dispose() {
      // no-op — synthetic in-memory source
    },
  };
}

describe("scan (pre-flight, no committer)", () => {
  it("returns kept count for a clean source", async () => {
    const result = await scan(fromArray([baseEvent(), baseEvent({ id: 2 })]));
    expect(result.kept).toBe(2);
    expect(result.dropped).toEqual({
      closed_streams: 0,
      snapshots: 0,
    });
  });

  it("throws on negative version", async () => {
    await expect(scan(fromArray([baseEvent({ version: -1 })]))).rejects.toThrow(
      /Invalid event at index 1/
    );
  });

  it("throws on malformed `created`", async () => {
    await expect(
      scan(fromArray([baseEvent({ created: new Date("garbage") })]))
    ).rejects.toThrow(/Invalid event at index 1/);
  });

  it("throws when `created` isn't a Date", async () => {
    await expect(
      // `any`: invalid input shape
      scan(fromArray([baseEvent({ created: "2024-01-01" as any })]))
    ).rejects.toThrow(/Invalid event at index 1/);
  });

  it("reports the running index in the error", async () => {
    await expect(
      scan(
        fromArray([
          baseEvent(),
          baseEvent({ id: 2 }),
          baseEvent({ version: -1 }),
        ])
      )
    ).rejects.toThrow(/Invalid event at index 3/);
  });

  it("fires on_progress once per event", async () => {
    const calls: number[] = [];
    await scan(fromArray([baseEvent(), baseEvent({ id: 2 })]), {
      on_progress: (p) => calls.push(p.processed),
    });
    expect(calls).toEqual([1, 2]);
  });

  it("paginates source.query across the 500-row internal batch", async () => {
    // Force scan's pagination loop to fire by feeding it 600 events —
    // batch 1 returns exactly 500 (continue, bump `at`), batch 2
    // returns 100 (got < BATCH → exit). Verifies every event is
    // counted exactly once and on_progress reports the full total.
    const total = 600;
    const events: E[] = Array.from({ length: total }, (_, i) =>
      baseEvent({ id: i + 1, version: i })
    );
    const calls: Array<{
      after?: number;
      limit?: number;
      backward?: boolean;
    }> = [];
    const source: EventSource = {
      async query(callback, filter?) {
        calls.push({
          after: filter?.after,
          limit: filter?.limit,
          backward: filter?.backward,
        });
        const after = filter?.after ?? 0;
        const before = filter?.before ?? Number.POSITIVE_INFINITY;
        const limit = filter?.limit ?? Number.POSITIVE_INFINITY;
        let slice = events.filter((e) => e.id > after && e.id < before);
        if (filter?.backward) slice = [...slice].reverse();
        slice = slice.slice(0, limit);
        for (const e of slice)
          await Promise.resolve((callback as (event: E) => void)(e));
        return slice.length;
      },
      async dispose() {
        // no-op
      },
    };
    let lastProcessed = 0;
    let lastMaxId: number | undefined;
    const result = await scan(source, {
      on_progress: (p) => {
        lastProcessed = p.processed;
        lastMaxId = p.max_id;
      },
    });
    expect(result.kept).toBe(total);
    expect(lastProcessed).toBe(total);
    // max_id probe at scan start (backward+limit:1, returns 1 row),
    // then two forward batches.
    expect(lastMaxId).toBe(total);
    expect(calls).toEqual([
      { after: undefined, limit: 1, backward: true },
      { after: undefined, limit: 500, backward: undefined },
      { after: 500, limit: 500, backward: undefined },
    ]);
  });

  it("event_migrations rewrites name + data with schema validation", async () => {
    // Three events of two types; only the first type has a migration.
    // Migrated events get the new name + transformed data. Untouched
    // events flow through verbatim.
    const events: E[] = [
      baseEvent({ id: 1, name: "OrderPaid", data: { amount: 50 } }),
      baseEvent({ id: 2, name: "OrderShipped", data: { tracking: "X" } }),
      baseEvent({ id: 3, name: "OrderPaid", data: { amount: 75 } }),
    ];
    const seen: Array<{ name: string; data: unknown }> = [];
    const result = await scan(
      fromArray(events),
      {
        event_migrations: {
          OrderPaid: {
            to: "OrderPaid_v2",
            from_schema: { parse: (d) => d as { amount: number } },
            to_schema: { parse: (d) => d as { amount_cents: number } },
            migrate: (d: { amount: number }) => ({
              amount_cents: d.amount * 100,
            }),
          },
        },
      },
      async (e) => {
        seen.push({ name: e.name as string, data: e.data });
        return e.id;
      }
    );
    expect(result.kept).toBe(3);
    expect(result.migrated).toBe(2);
    expect(seen).toEqual([
      { name: "OrderPaid_v2", data: { amount_cents: 5000 } },
      { name: "OrderShipped", data: { tracking: "X" } },
      { name: "OrderPaid_v2", data: { amount_cents: 7500 } },
    ]);
  });

  it("event_migrations aborts the scan when from_schema rejects", async () => {
    // The first OrderPaid row has the documented shape; the second
    // does not. from_schema.parse throws → scan throws → in a real
    // restore the sink transaction rolls back. Operator finds out
    // BEFORE any rows land instead of mid-migration.
    const events: E[] = [
      baseEvent({ id: 1, name: "OrderPaid", data: { amount: 10 } }),
      baseEvent({ id: 2, name: "OrderPaid", data: { totally_wrong: true } }),
    ];
    await expect(
      scan(
        fromArray(events),
        {
          event_migrations: {
            OrderPaid: {
              to: "OrderPaid_v2",
              from_schema: {
                parse: (d) => {
                  const v = d as { amount?: number };
                  if (typeof v.amount !== "number")
                    throw new Error("missing amount");
                  return v as { amount: number };
                },
              },
              to_schema: { parse: (d) => d as { amount_cents: number } },
              migrate: (d: { amount: number }) => ({
                amount_cents: d.amount * 100,
              }),
            },
          },
        },
        async (e) => e.id
      )
    ).rejects.toThrow(/missing amount/);
  });

  it("stream_rename rewrites the stream per event", async () => {
    const events: E[] = [
      baseEvent({ id: 1, stream: "tenant-old-acme" }),
      baseEvent({ id: 2, stream: "tenant-old-globex" }),
      baseEvent({ id: 3, stream: "tenant-new-already" }),
    ];
    const seen: string[] = [];
    const result = await scan(
      fromArray(events),
      {
        stream_rename: (s) => s.replace(/^tenant-old-/, "tenant-new-"),
      },
      async (e) => {
        seen.push(e.stream);
        return e.id;
      }
    );
    expect(result.kept).toBe(3);
    expect(seen).toEqual([
      "tenant-new-acme",
      "tenant-new-globex",
      "tenant-new-already",
    ]);
  });

  it("event_migrations + stream_rename compose, migration runs first", async () => {
    // The migration's `migrate(...)` sees the ORIGINAL stream name
    // because stream_rename runs after. Important for migrations that
    // key off the source stream (e.g., per-tenant transforms).
    const seen_in_migrate: string[] = [];
    const seen_at_sink: Array<{ name: string; stream: string }> = [];
    const result = await scan(
      fromArray([
        baseEvent({ id: 1, name: "X", stream: "old-a", data: { v: 1 } }),
      ]),
      {
        event_migrations: {
          X: {
            to: "X_v2",
            from_schema: { parse: (d) => d as { v: number } },
            to_schema: { parse: (d) => d as { v: number } },
            migrate: (d: { v: number }) => {
              // No way to see stream name from migrate (by design — it
              // only gets `data`). Just sanity-check we ran.
              seen_in_migrate.push("ran");
              return { v: d.v + 100 };
            },
          },
        },
        stream_rename: (s) => s.replace(/^old-/, "new-"),
      },
      async (e) => {
        seen_at_sink.push({ name: e.name as string, stream: e.stream });
        return e.id;
      }
    );
    expect(result.kept).toBe(1);
    expect(result.migrated).toBe(1);
    expect(seen_in_migrate).toEqual(["ran"]);
    expect(seen_at_sink).toEqual([{ name: "X_v2", stream: "new-a" }]);
  });

  it("drop_closed_streams drops pre-close events but keeps the tombstone", async () => {
    // stream-a is closed (tombstone at id 4); stream-b is live.
    // With drop_closed_streams:
    //   - stream-a's two pre-close events are dropped (compaction)
    //   - stream-a's tombstone is KEPT so the rebuilt store still
    //     rejects future writes to that stream with StreamClosedError
    //   - stream-b's events flow through unchanged.
    const events: E[] = [
      baseEvent({ id: 1, stream: "stream-a", name: "Tick", version: 0 }),
      baseEvent({ id: 2, stream: "stream-b", name: "Tick", version: 0 }),
      baseEvent({ id: 3, stream: "stream-a", name: "Tick", version: 1 }),
      baseEvent({
        id: 4,
        stream: "stream-a",
        name: "__tombstone__",
        version: 2,
      }),
      baseEvent({ id: 5, stream: "stream-b", name: "Tick", version: 1 }),
    ];
    const kept_events: string[] = [];
    const result = await scan(
      fromArray(events),
      { drop_closed_streams: true },
      async (e) => {
        kept_events.push(`${e.stream}@${e.id}/${e.name as string}`);
        return e.id;
      }
    );
    // 2 stream-b events + 1 stream-a tombstone kept
    expect(result.kept).toBe(3);
    // 2 stream-a pre-close ticks dropped
    expect(result.dropped.closed_streams).toBe(2);
    expect(kept_events).toEqual([
      "stream-b@2/Tick",
      "stream-a@4/__tombstone__",
      "stream-b@5/Tick",
    ]);
  });

  it("drop_closed_streams + drop_snapshots compose", async () => {
    // Same stream-a close, plus a snapshot on stream-b. With both flags:
    //   - stream-a pre-close events dropped under closed_streams
    //   - stream-a tombstone kept (the close gate)
    //   - stream-b snapshot dropped under snapshots
    //   - stream-b regular event kept.
    const events: E[] = [
      baseEvent({ id: 1, stream: "stream-a", name: "Tick", version: 0 }),
      baseEvent({
        id: 2,
        stream: "stream-b",
        name: "__snapshot__",
        version: 0,
      }),
      baseEvent({
        id: 3,
        stream: "stream-a",
        name: "__tombstone__",
        version: 1,
      }),
      baseEvent({ id: 4, stream: "stream-b", name: "Tick", version: 1 }),
    ];
    const result = await scan(
      fromArray(events),
      { drop_closed_streams: true, drop_snapshots: true },
      async (e) => e.id
    );
    // 1 stream-b Tick + 1 stream-a tombstone kept
    expect(result.kept).toBe(2);
    // 1 stream-a pre-close Tick dropped
    expect(result.dropped.closed_streams).toBe(1);
    // 1 stream-b snapshot dropped
    expect(result.dropped.snapshots).toBe(1);
  });

  it("counts dropped snapshots when drop_snapshots is true", async () => {
    const result = await scan(
      fromArray([
        baseEvent(),
        baseEvent({ id: 2, name: "__snapshot__" }),
        baseEvent({ id: 3 }),
      ]),
      { drop_snapshots: true }
    );
    expect(result.kept).toBe(2);
    expect(result.dropped.snapshots).toBe(1);
  });
});

describe("scan (with committer)", () => {
  it("calls commit once per non-dropped event", async () => {
    const writes: E[] = [];
    let nextId = 100;
    const result = await scan(
      fromArray([baseEvent({ id: 5 }), baseEvent({ id: 7 })]),
      {},
      async (e) => {
        writes.push(e as E);
        return nextId++;
      }
    );
    expect(writes.map((w) => w.id)).toEqual([5, 7]);
    expect(result.kept).toBe(2);
  });

  it("skips commit for snapshots when drop_snapshots is true", async () => {
    const writes: E[] = [];
    const result = await scan(
      fromArray([
        baseEvent(),
        baseEvent({ id: 2, name: "__snapshot__" }),
        baseEvent({ id: 3 }),
      ]),
      { drop_snapshots: true },
      async (e) => {
        writes.push(e as E);
        return (e as E).id;
      }
    );
    expect(writes).toHaveLength(2);
    expect(result.dropped.snapshots).toBe(1);
  });

  it("rewrites causation refs through the old→new id map", async () => {
    let nextId = 1000;
    const seen: Array<{ id: number; causationId?: number }> = [];
    await scan(
      fromArray([
        baseEvent({ id: 5 }),
        baseEvent({
          id: 7,
          meta: {
            correlation: "c",
            causation: { event: { id: 5, name: "Tick", stream: "s" } },
          },
        }),
      ]),
      {},
      async (e) => {
        const newId = nextId++;
        seen.push({
          id: (e as E).id,
          causationId: e.meta.causation.event?.id,
        });
        return newId;
      }
    );
    expect(seen[0]).toEqual({ id: 5, causationId: undefined });
    expect(seen[1]).toEqual({ id: 7, causationId: 1000 });
  });

  it("keeps migrations applied when an id shift triggers the causation remap", async () => {
    // A dropped snapshot renumbers the id space, so committed events land
    // at fresh ids and the causation remap branch fires for anything that
    // referenced an earlier kept event. Pre-fix, that branch rebuilt the
    // sink event from the ORIGINAL row instead of the migrated one — so a
    // migrated + remapped event silently reverted to its pre-migration
    // name and data. Compose drop_snapshots (forces the shift) with an
    // event_migration and a causation ref into the id map and assert the
    // sink still receives the migrated shape.
    let nextId = 1000;
    const seen: Array<{ name: string; data: unknown; causationId?: number }> =
      [];
    const result = await scan(
      fromArray([
        baseEvent({ id: 1, name: "__snapshot__" }),
        baseEvent({ id: 2, name: "OrderPaid", data: { amount: 40 } }),
        baseEvent({
          id: 3,
          name: "OrderPaid",
          data: { amount: 90 },
          meta: {
            correlation: "c",
            causation: { event: { id: 2, name: "OrderPaid", stream: "s" } },
          },
        }),
      ]),
      {
        drop_snapshots: true,
        event_migrations: {
          OrderPaid: {
            to: "OrderPaid_v2",
            from_schema: { parse: (d) => d as { amount: number } },
            to_schema: { parse: (d) => d as { amount_cents: number } },
            migrate: (d: { amount: number }) => ({
              amount_cents: d.amount * 100,
            }),
          },
        },
      },
      async (e) => {
        seen.push({
          name: e.name as string,
          data: e.data,
          causationId: e.meta.causation.event?.id,
        });
        return nextId++;
      }
    );

    expect(result.migrated).toBe(2);
    // Event id=2 committed first at new id 1000 (no causation ref).
    expect(seen[0]).toEqual({
      name: "OrderPaid_v2",
      data: { amount_cents: 4000 },
      causationId: undefined,
    });
    // Event id=3's causation.event.id (2) is remapped to 1000 — and the
    // migrated name/data must survive the remap.
    expect(seen[1]).toEqual({
      name: "OrderPaid_v2",
      data: { amount_cents: 9000 },
      causationId: 1000,
    });
  });

  it("passes causation refs through unchanged when target not in source", async () => {
    const causationIds: Array<number | undefined> = [];
    await scan(
      fromArray([
        baseEvent({
          meta: {
            correlation: "c",
            causation: { event: { id: 999, name: "Phantom", stream: "g" } },
          },
        }),
      ]),
      {},
      async (e) => {
        causationIds.push(e.meta.causation.event?.id);
        return 1;
      }
    );
    expect(causationIds).toEqual([999]);
  });

  it("validates before committing — throws and commit never sees bad event", async () => {
    const writes: E[] = [];
    await expect(
      scan(
        fromArray([baseEvent(), baseEvent({ id: 2, version: -1 })]),
        {},
        async (e) => {
          writes.push(e as E);
          return (e as E).id;
        }
      )
    ).rejects.toThrow(/Invalid event at index 2/);
    expect(writes).toHaveLength(1);
  });
});

describe("Act.restore (orchestrator)", () => {
  // Calculator-events source — same EventSource shape as the
  // synthetic `fromArray` above; aliased for readability inside
  // the orchestrator-tier tests.
  const calc = (events: E[]): EventSource => fromArray(events);

  it("delegates to store.restore via the driver and returns the result", async () => {
    const ctx = await sandbox(act().withState(Calculator));
    const stream = `restore-orchestrator-${Date.now()}`;
    const t = new Date("2024-04-01T00:00:00.000Z");
    const result = await ctx.app.restore(
      calc([
        baseEvent({
          id: 1,
          stream,
          version: 0,
          name: "DigitPressed",
          data: { digit: "1" },
          created: t,
        }),
      ])
    );
    expect(result.kept).toBe(1);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.dropped).toEqual({
      closed_streams: 0,
      snapshots: 0,
    });
    await ctx.dispose();
  });

  it("throws when the adapter has no restore capability", async () => {
    const ctx = await sandbox(act().withState(Calculator));
    // Remove the optional method on the scoped store to simulate a
    // restore-incapable adapter without writing a new one.
    const savedRestore = ctx.store.restore;
    (ctx.store as { restore?: unknown }).restore = undefined;
    try {
      await expect(
        (
          ctx.app as unknown as {
            restore: (s: EventSource, o?: ScanOptions) => Promise<unknown>;
          }
        ).restore(calc([]))
      ).rejects.toThrow(/has no restore capability/);
    } finally {
      (ctx.store as { restore?: unknown }).restore = savedRestore;
      await ctx.dispose();
    }
  });

  it("dry_run validates the source without touching the store", async () => {
    const ctx = await sandbox(act().withState(Calculator));
    const stream = `restore-dry-${Date.now()}`;
    const t = new Date("2024-04-01T00:00:00.000Z");
    // Spy on the store's restore so we can prove it was never invoked.
    let restoreCalls = 0;
    const realRestore = ctx.store.restore!.bind(ctx.store);
    (ctx.store as { restore: unknown }).restore = async (driver: unknown) => {
      restoreCalls++;
      // `any`: test spy
      return realRestore(driver as any);
    };
    try {
      const result = await ctx.app.restore(
        calc([
          baseEvent({ id: 1, stream, version: 0, name: "Tick", created: t }),
          baseEvent({ id: 2, stream, version: 1, name: "Tick", created: t }),
        ]),
        { dry_run: true }
      );
      expect(result.kept).toBe(2);
      expect(restoreCalls).toBe(0);
    } finally {
      (ctx.store as { restore?: unknown }).restore = realRestore;
      await ctx.dispose();
    }
  });

  it("dry_run works on an adapter with no restore capability", async () => {
    const ctx = await sandbox(act().withState(Calculator));
    const savedRestore = ctx.store.restore;
    (ctx.store as { restore?: unknown }).restore = undefined;
    try {
      const result = await ctx.app.restore(calc([baseEvent()]), {
        dry_run: true,
      });
      expect(result.kept).toBe(1);
    } finally {
      (ctx.store as { restore?: unknown }).restore = savedRestore;
      await ctx.dispose();
    }
  });

  it("dry_run surfaces validation errors without touching the store", async () => {
    const ctx = await sandbox(act().withState(Calculator));
    try {
      await expect(
        ctx.app.restore(calc([baseEvent({ version: -1 })]), { dry_run: true })
      ).rejects.toThrow(/Invalid event at index 1/);
    } finally {
      await ctx.dispose();
    }
  });
});

describe("restore from a real Store source", () => {
  // `fromArray` above ignores `with_snaps`, so snapshots always reach the
  // walk from a synthetic source. A real Store filters them out unless the
  // scan asks — which is the gap this block covers.
  const Counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ Ticked: ZodEmpty })
    .patch({ Ticked: (_e, s) => ({ count: s.count + 1 }) })
    .on({ Tick: ZodEmpty })
    .emit(() => ["Ticked", {}])
    .snap((s) => s.state.count >= 2)
    .build();

  const actor = { id: "u1", name: "u1" };

  const names_in = async (s: Store, stream?: string) => {
    const names: string[] = [];
    await s.query((e) => names.push(e.name), { stream, with_snaps: true });
    return names;
  };

  it("carries a __snapshot__ through a store-to-store restore", async () => {
    const ctx = await sandbox(act().withState(Counter));
    try {
      for (let i = 0; i < 4; i++)
        await ctx.app.do("Tick", { stream: "r1", actor }, {});
      expect(await names_in(ctx.store)).toContain("__snapshot__");

      const sink = new InMemoryStore();
      await sink.seed();
      await ctx.app.restore(ctx.store, {}, sink);

      expect(await names_in(sink)).toContain("__snapshot__");
    } finally {
      await ctx.dispose();
    }
  });

  it("does not lose a stream whose history was pruned by a windowed close", async () => {
    const ctx = await sandbox(act().withState(Counter));
    try {
      for (let i = 0; i < 6; i++)
        await ctx.app.do("Tick", { stream: "r2", actor }, {});
      // A windowed close prunes the prefix below the boundary snapshot, so
      // that snapshot IS the stream's state from here on.
      await ctx.app.close([
        { stream: "r2", before: new Date(Date.now() + 60_000) },
      ]);
      expect(await names_in(ctx.store, "r2")).toEqual(["__snapshot__"]);
      expect((await ctx.app.load(Counter, "r2")).state.count).toBe(6);

      const sink = new InMemoryStore();
      await sink.seed();
      const result = await ctx.app.restore(ctx.store, {}, sink);

      expect(result.kept).toBe(1);
      expect(await names_in(sink, "r2")).toEqual(["__snapshot__"]);
    } finally {
      await ctx.dispose();
    }
  });

  it("drop_snapshots actually drops them from a Store source", async () => {
    const ctx = await sandbox(act().withState(Counter));
    try {
      for (let i = 0; i < 6; i++)
        await ctx.app.do("Tick", { stream: "r3", actor }, {});
      const result = await ctx.app.restore(ctx.store, {
        dry_run: true,
        drop_snapshots: true,
      });
      expect(result.dropped.snapshots).toBeGreaterThan(0);
      expect(result.kept).toBe(6);
    } finally {
      await ctx.dispose();
    }
  });
});

describe("restore into a store that already correlated", () => {
  const Tick = state({ RTick: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Ticked: z.object({}) })
    .patch({ Ticked: (_e, s) => ({ n: s.n + 1 }) })
    .on({ tick: z.object({}) })
    .emit(() => ["Ticked", {}])
    .build();
  const who = { id: "r", name: "r" };

  async function backup() {
    const src = new InMemoryStore();
    for (let i = 0; i < 3; i++)
      await src.commit("restored", [{ name: "Ticked", data: {} }], {
        correlation: "c",
        causation: {},
      });
    return src;
  }

  it("delivers restored events and new commits to their reactions", async () => {
    let seen = 0;
    const { app, dispose: done } = await sandbox(
      act()
        .withState(Tick)
        .on("Ticked")
        .do(async function count() {
          seen++;
        })
        .to((e) => ({ target: `count-${e.stream}` })),
      { actOptions: { autoSettle: false } }
    );
    // Correlate well past where the restored log will end.
    for (let i = 0; i < 10; i++)
      await app.do("tick", { stream: "before", actor: who }, {});
    await app.correlate();
    await app.drain();
    seen = 0;

    await app.restore(await backup(), {});
    for (let i = 0; i < 3; i++)
      await app.do("tick", { stream: "after", actor: who }, {});
    for (let i = 0; i < 4; i++) {
      await app.correlate();
      await app.drain();
    }
    await done();
    // 3 restored + 3 new, all reached their reaction
    expect(seen).toBe(6);
  });

  it("delivers restored events when the restore lands during a correlate scan", async () => {
    let seen = 0;
    let hold: Promise<void> | undefined;
    let held: () => void = () => {};
    let release: () => void = () => {};
    // Holds the reply of the first scan that carries events, until released.
    class HoldingStore extends InMemoryStore {
      override async query<E extends Schemas>(
        callback: (event: Committed<E, keyof E>) => void,
        query?: Query
      ) {
        const count = await super.query(callback, query);
        if (count > 0 && !hold) {
          hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          held();
          await hold;
        }
        return count;
      }
    }
    const { app, dispose: done } = await sandbox(
      act()
        .withState(Tick)
        .on("Ticked")
        .do(async function count() {
          seen++;
        })
        .to((e) => ({ target: `count-${e.stream}` })),
      { store: () => new HoldingStore(), actOptions: { autoSettle: false } }
    );
    for (let i = 0; i < 10; i++)
      await app.do("tick", { stream: "before", actor: who }, {});
    const scanning = new Promise<void>((resolve) => {
      held = resolve;
    });
    const in_flight = app.correlate();
    await scanning;
    // The restore starts while the scan's reply is still out, and waits
    // for that pass before it replaces the log.
    const restoring = app.restore(await backup(), {});
    release();
    await restoring;
    await in_flight;
    for (let i = 0; i < 4; i++) {
      await app.correlate();
      await app.drain();
    }
    await done();
    // only the 3 restored events, the 10 before were replaced
    expect(seen).toBe(3);
  });

  /** A backup of `n` events, one stream each. */
  async function backup_of(n: number, src = new InMemoryStore()) {
    for (let i = 0; i < n; i++)
      await src.commit(`restored-${i}`, [{ name: "Ticked", data: {} }], {
        correlation: "c",
        causation: {},
      });
    return src;
  }

  /** A gate a test opens by hand, and a signal that something reached it. */
  function gate() {
    let reached: () => void = () => {};
    let open: () => void = () => {};
    const at = new Promise<void>((r) => {
      reached = r;
    });
    const opened = new Promise<void>((r) => {
      open = r;
    });
    return { at, reached, opened, open };
  }

  it("delivers restored events when the scan's last write lands after the restore starts", async () => {
    let seen = 0;
    const g = gate();
    let held = false;
    // Holds the scan's mark write (sent before the restore) until released.
    class HoldingWriteStore extends InMemoryStore {
      override async subscribe(
        streams: SubscribeInput[],
        correlated_at?: number,
        correlator?: { key: string; by: string; millis: number }
      ) {
        if (!held && correlated_at !== undefined && streams.length > 0) {
          held = true;
          g.reached();
          await g.opened;
        }
        return super.subscribe(streams, correlated_at, correlator);
      }
    }
    const { app, dispose: done } = await sandbox(
      act()
        .withState(Tick)
        .on("Ticked")
        .do(async function count() {
          seen++;
        })
        .to((e) => ({ target: `count-${e.stream}` })),
      {
        store: () => new HoldingWriteStore(),
        actOptions: { autoSettle: false },
      }
    );
    for (let i = 0; i < 10; i++)
      await app.do("tick", { stream: "before", actor: who }, {});
    const in_flight = app.correlate();
    await g.at;
    const restoring = app.restore(await backup(), {});
    g.open();
    await restoring;
    await in_flight;
    for (let i = 0; i < 4; i++) {
      await app.correlate();
      await app.drain();
    }
    await done();
    expect(seen).toBe(3);
  });

  it("a correlate pass that starts during the restore reads nothing, and loses nothing", async () => {
    let seen = 0;
    const { app, dispose: done } = await sandbox(
      act()
        .withState(Tick)
        .on("Ticked")
        .do(async function count() {
          seen++;
        })
        .to((e) => ({ target: `count-${e.stream}` })),
      { actOptions: { autoSettle: false } }
    );
    for (let i = 0; i < 10; i++)
      await app.do("tick", { stream: "before", actor: who }, {});
    await app.correlate();
    await app.drain();
    seen = 0;
    // Pauses the restore after 15 of its 20 events.
    const g = gate();
    class GatedSource extends InMemoryStore {
      gated = false;
      override async query<E extends Schemas>(
        callback: (event: Committed<E, keyof E>) => void,
        query?: Query
      ) {
        let n = 0;
        return super.query<E>(async (event) => {
          if (this.gated && ++n === 15) {
            g.reached();
            await g.opened;
          }
          callback(event);
        }, query);
      }
    }
    const source = (await backup_of(20, new GatedSource())) as GatedSource;
    source.gated = true;
    const restoring = app.restore(source, {});
    await g.at;
    expect(await app.correlate()).toEqual({ subscribed: 0, last_id: 9 });
    g.open();
    await restoring;
    for (let i = 0; i < 6; i++) {
      await app.correlate();
      await app.drain();
    }
    await done();
    expect(seen).toBe(20);
  });

  it("delivers restored events when the restore lands during correlate's startup", async () => {
    // A process boots on a store another one correlated up to id 9, and the
    // restore lands while its startup read is still out.
    let seen = 0;
    const g = gate();
    let hold = false;
    class HoldingInitStore extends InMemoryStore {
      override async subscribe(
        streams: SubscribeInput[],
        correlated_at?: number,
        correlator?: { key: string; by: string; millis: number }
      ) {
        const result = await super.subscribe(
          streams,
          correlated_at,
          correlator
        );
        if (hold && correlated_at === undefined && correlator === undefined) {
          hold = false;
          g.reached();
          await g.opened;
        }
        return result;
      }
    }
    const s = new HoldingInitStore();
    await s.seed();
    const build = () =>
      act()
        .withState(Tick)
        .on("Ticked")
        .do(async function count() {
          seen++;
        })
        .to((e) => ({ target: `count-${e.stream}` }))
        .build({
          scoped: { store: s, cache: new InMemoryCache() },
          autoSettle: false,
        });
    const first = build();
    for (let i = 0; i < 10; i++)
      await first.do("tick", { stream: "before", actor: who }, {});
    await first.correlate();
    await first.drain();
    await first.shutdown();
    seen = 0;

    const app = build();
    hold = true;
    const in_flight = app.correlate();
    await g.at;
    const restoring = app.restore(await backup_of(20), {});
    // Release the startup read only once the restore had its chance to
    // finish: one that doesn't wait for the pass completes first.
    await Promise.race([restoring, sleep(50)]);
    g.open();
    await restoring;
    await in_flight;
    for (let i = 0; i < 6; i++) {
      await app.correlate();
      await app.drain();
    }
    await app.shutdown();
    expect(seen).toBe(20);
  });

  it("settles the restored events' reactions with no settle call", async () => {
    let seen = 0;
    const { app, dispose: done } = await sandbox(
      act()
        .withState(Tick)
        .on("Ticked")
        .do(async function count() {
          seen++;
        })
        .to((e) => ({ target: `count-${e.stream}` }))
    );
    await app.restore(await backup(), {});
    await vi.waitFor(() => expect(seen).toBe(3));
    await done();
  });
});
