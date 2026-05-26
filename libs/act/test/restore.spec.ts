import {
  act,
  type Committed,
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

async function* fromArray(events: E[]): AsyncIterable<E> {
  for (const e of events) yield e;
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
  const calc = (events: E[]) =>
    (async function* () {
      for (const e of events) yield e;
    })();

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
            restore: (s: AsyncIterable<E>, o?: ScanOptions) => Promise<unknown>;
          }
        ).restore(calc([]))
      ).rejects.toThrow(/has no restore capability/);
    } finally {
      (ctx.store as { restore?: unknown }).restore = savedRestore;
      await ctx.dispose();
    }
  });
});
