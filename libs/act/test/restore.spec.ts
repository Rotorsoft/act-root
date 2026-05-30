import {
  act,
  type Committed,
  type EventSource,
  type ScanOptions,
  type Schemas,
} from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { scan } from "../src/internal/event-sourcing.js";
import { sandbox } from "../src/test/index.js";
import { Calculator } from "./calculator.js";

/**
 * Internal scan helper + orchestrator `Act.restore` (ACT-1125).
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
 * shape `scan` and `Act.restore` consume after the ACT-1128 source
 * abstraction. `await Promise.resolve(callback(e))` mirrors the
 * adapter pattern so async-callback backpressure is exercised even
 * from this synthetic source.
 *
 * Honors `after`/`limit` filters because `scan` paginates
 * (ACT-1133) — it asks for events with `id > after` up to `limit`.
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
      // biome-ignore lint/suspicious/noExplicitAny: invalid input shape
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

  it("paginates source.query across the 500-row internal batch (ACT-1133)", async () => {
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

  it("event_migrations rewrites name + data with schema validation (ACT-1126)", async () => {
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

  it("event_migrations aborts the scan when from_schema rejects (ACT-1126)", async () => {
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

  it("stream_rename rewrites the stream per event (ACT-1126)", async () => {
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

  it("event_migrations + stream_rename compose, migration runs first (ACT-1126)", async () => {
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

  it("drop_closed_streams drops pre-close events but keeps the tombstone (ACT-1126)", async () => {
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

  it("drop_closed_streams + drop_snapshots compose (ACT-1126)", async () => {
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
      // biome-ignore lint/suspicious/noExplicitAny: test spy
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
