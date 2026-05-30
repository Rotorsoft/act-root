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
      empty_streams: 0,
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
      empty_streams: 0,
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
