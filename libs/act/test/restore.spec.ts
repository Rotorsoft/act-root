import { describe, expect, it } from "vitest";
import { scan } from "../src/restore.js";
import type { RestoreEvent } from "../src/types/index.js";

/**
 * Source-side scan helper (ACT-1125). Pure — no adapter, no I/O, no
 * store. Validates each event inline and throws on the first blocker.
 * Two modes: pre-flight (no writer) for source validation, restore
 * (writer provided) drives adapter inserts.
 */
const baseEvent = (overrides: Partial<RestoreEvent> = {}): RestoreEvent => ({
  id: 1,
  name: "Tick",
  data: {},
  stream: "s",
  version: 0,
  created: new Date("2024-01-01T00:00:00.000Z"),
  meta: { correlation: "c", causation: {} },
  ...overrides,
});

async function* fromArray(events: RestoreEvent[]): AsyncIterable<RestoreEvent> {
  for (const e of events) yield e;
}

describe("scan (pre-flight, no writer)", () => {
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
      scan(
        fromArray([
          // biome-ignore lint/suspicious/noExplicitAny: invalid input shape
          baseEvent({ created: "not-a-date" as any }),
        ])
      )
    ).rejects.toThrow(/Invalid event at index 1/);
  });

  it("throws on malformed Date instance", async () => {
    await expect(
      scan(fromArray([baseEvent({ created: new Date("garbage") })]))
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

  it("accepts ISO-string `created`", async () => {
    const result = await scan(
      fromArray([baseEvent({ created: "2024-06-15T12:00:00.000Z" })])
    );
    expect(result.kept).toBe(1);
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

describe("scan (with writer)", () => {
  it("calls writeEvent once per non-dropped event", async () => {
    const writes: RestoreEvent[] = [];
    let nextId = 100;
    const result = await scan(
      fromArray([baseEvent({ id: 5 }), baseEvent({ id: 7 })]),
      {},
      async (event) => {
        writes.push(event);
        return nextId++;
      }
    );
    expect(writes.map((w) => w.id)).toEqual([5, 7]);
    expect(result.kept).toBe(2);
  });

  it("skips writes for snapshots when drop_snapshots is true", async () => {
    const writes: RestoreEvent[] = [];
    const result = await scan(
      fromArray([
        baseEvent(),
        baseEvent({ id: 2, name: "__snapshot__" }),
        baseEvent({ id: 3 }),
      ]),
      { drop_snapshots: true },
      async (event) => {
        writes.push(event);
        return event.id;
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
      async (event, meta) => {
        const newId = nextId++;
        seen.push({ id: event.id, causationId: meta.causation.event?.id });
        return newId;
      }
    );
    expect(seen[0]).toEqual({ id: 5, causationId: undefined });
    // Second event's causation pointed at original id 5 → new id 1000.
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
      async (_event, meta) => {
        causationIds.push(meta.causation.event?.id);
        return 1;
      }
    );
    expect(causationIds).toEqual([999]);
  });

  it("validates before writing — throws and writer never sees bad event", async () => {
    const writes: RestoreEvent[] = [];
    await expect(
      scan(
        fromArray([baseEvent(), baseEvent({ id: 2, version: -1 })]),
        {},
        async (event) => {
          writes.push(event);
          return event.id;
        }
      )
    ).rejects.toThrow(/Invalid event at index 2/);
    // First event went through; second blocked before the writer fired.
    expect(writes).toHaveLength(1);
  });
});
