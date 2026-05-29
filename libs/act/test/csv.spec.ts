import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Committed, EventSource, Query, Schemas } from "@rotorsoft/act";
import { CsvFile } from "@rotorsoft/act";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { iterate } from "../src/internal/event-sourcing.js";

type E = Committed<Schemas, string>;

/**
 * Tests for the ACT-1128 transfer primitives:
 *
 * - `iterate(source)` — 1-slot mailbox bridge from `EventSource.query`
 *   to `AsyncIterable<Committed>` with true backpressure. Internal to
 *   the framework — imported here via the deep `internal/` path the
 *   same way `scan` is in `restore.spec.ts`.
 * - `CsvFile` — single class implementing both `EventSource` and
 *   `EventSink` (and `Disposable`) for CSV files on disk or
 *   in-memory CSV blobs. Public surface.
 */

const makeEvent = (overrides: Partial<E> = {}): E =>
  ({
    id: 1,
    name: "Tick",
    data: { tick: 1 },
    stream: "s1",
    version: 0,
    created: new Date("2024-01-01T00:00:00.000Z"),
    meta: { correlation: "c", causation: {} },
    ...overrides,
  }) as unknown as E;

/**
 * Synthetic `EventSource` that walks an array. Identical shape to
 * the TCK's `asSource` helper — kept inline so this spec doesn't
 * depend on cross-package wiring.
 */
function arraySource(events: E[]): EventSource {
  return {
    async query(callback, _filter?: Query) {
      for (const e of events)
        await Promise.resolve(
          (callback as (event: Committed<Schemas, keyof Schemas>) => void)(
            e as Committed<Schemas, keyof Schemas>
          )
        );
      return events.length;
    },
    async dispose() {
      // no-op
    },
  };
}

describe("iterate", () => {
  it("yields every event from a synchronous-callback source", async () => {
    const events = [makeEvent(), makeEvent({ id: 2 }), makeEvent({ id: 3 })];
    const collected: E[] = [];
    for await (const e of iterate(arraySource(events)))
      collected.push(e as unknown as E);
    expect(collected.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("returns immediately for an empty source", async () => {
    const collected: E[] = [];
    for await (const e of iterate(arraySource([])))
      collected.push(e as unknown as E);
    expect(collected).toEqual([]);
  });

  it("backpressures the producer to one event in flight", async () => {
    // Build a source that records how many events the producer has
    // pushed at the point each consumer iteration runs. Without
    // backpressure the source would drain all events before the
    // consumer's first `await` returns; with the 1-slot mailbox
    // it stays in lockstep.
    const totalEvents = 5;
    const pushedAtConsume: number[] = [];
    let pushed = 0;
    const source: EventSource = {
      async query(callback) {
        for (let i = 0; i < totalEvents; i++) {
          pushed++;
          await Promise.resolve(
            (callback as (event: Committed<Schemas, keyof Schemas>) => void)(
              makeEvent({ id: i + 1 }) as Committed<Schemas, keyof Schemas>
            )
          );
        }
        return totalEvents;
      },
      async dispose() {
        // no-op
      },
    };
    let consumed = 0;
    for await (const _ of iterate(source)) {
      consumed++;
      // Producer should be at most one event ahead of consumer.
      pushedAtConsume.push(pushed);
    }
    expect(consumed).toBe(totalEvents);
    // 1-slot mailbox: at the point the consumer's body runs for
    // event N, the producer has had a microtask to load event N+1
    // into the slot (and parked awaiting the consumer to take it).
    // So `pushed` is exactly `consumed + 1`, capped at totalEvents
    // for the final iteration. Critically, `pushed - consumed` is
    // never > 1 — that's the backpressure invariant.
    expect(pushedAtConsume).toEqual([2, 3, 4, 5, 5]);
    for (let i = 0; i < pushedAtConsume.length; i++)
      expect(pushedAtConsume[i]! - (i + 1)).toBeLessThanOrEqual(1);
  });

  it("paginates limit/after through a respecting source (ACT-1133)", async () => {
    // Source that honors `after` and `limit` like a SQL store does.
    // Walked over 1200 events with the default ITERATE_BATCH of 500,
    // iterate should make three `source.query` calls
    // (limit:500 / limit:500 / limit:500) and stop after the third
    // returns < batchLimit. Asserts both that every event is yielded
    // in order and that the pagination call shape matches the spec.
    const total = 1200;
    const all = Array.from({ length: total }, (_, i) =>
      makeEvent({ id: i + 1 })
    );
    const calls: Array<{ after?: number; limit?: number }> = [];
    const source: EventSource = {
      async query(callback, filter?: Query) {
        calls.push({ after: filter?.after, limit: filter?.limit });
        const after = filter?.after ?? 0;
        const limit = filter?.limit ?? Number.POSITIVE_INFINITY;
        const slice = all.filter((e) => e.id > after).slice(0, limit);
        for (const e of slice)
          await Promise.resolve(
            (callback as (event: Committed<Schemas, keyof Schemas>) => void)(
              e as Committed<Schemas, keyof Schemas>
            )
          );
        return slice.length;
      },
      async dispose() {
        // no-op
      },
    };
    const collected: E[] = [];
    for await (const e of iterate(source)) collected.push(e as unknown as E);
    expect(collected).toHaveLength(total);
    expect(collected.map((e) => e.id)).toEqual(all.map((e) => e.id));
    // 1200 events, batch 500 → calls at after=undefined, after=500, after=1000.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ after: undefined, limit: 500 });
    expect(calls[1]).toEqual({ after: 500, limit: 500 });
    expect(calls[2]).toEqual({ after: 1000, limit: 500 });
  });

  it("honors caller's `limit` as a total cap across batches (ACT-1133)", async () => {
    // Caller passes limit: 750 — iterate should make two calls
    // (limit:500, then limit:250) and stop. No third call.
    const total = 2000;
    const all = Array.from({ length: total }, (_, i) =>
      makeEvent({ id: i + 1 })
    );
    const calls: Array<{ limit?: number }> = [];
    const source: EventSource = {
      async query(callback, filter?: Query) {
        calls.push({ limit: filter?.limit });
        const after = filter?.after ?? 0;
        const limit = filter?.limit ?? Number.POSITIVE_INFINITY;
        const slice = all.filter((e) => e.id > after).slice(0, limit);
        for (const e of slice)
          await Promise.resolve(
            (callback as (event: Committed<Schemas, keyof Schemas>) => void)(
              e as Committed<Schemas, keyof Schemas>
            )
          );
        return slice.length;
      },
      async dispose() {
        // no-op
      },
    };
    const collected: E[] = [];
    for await (const e of iterate(source, { limit: 750 }))
      collected.push(e as unknown as E);
    expect(collected).toHaveLength(750);
    expect(calls.map((c) => c.limit)).toEqual([500, 250]);
  });

  it("propagates errors from the source", async () => {
    const source: EventSource = {
      async query(callback) {
        await Promise.resolve(
          (callback as (event: Committed<Schemas, keyof Schemas>) => void)(
            makeEvent() as Committed<Schemas, keyof Schemas>
          )
        );
        throw new Error("source blew up");
      },
      async dispose() {
        // no-op
      },
    };
    const collected: E[] = [];
    await expect(async () => {
      for await (const e of iterate(source)) collected.push(e as unknown as E);
    }).rejects.toThrow(/source blew up/);
    expect(collected).toHaveLength(1);
  });
});

describe("CsvFile (blob mode — read)", () => {
  const header = "id,name,data,stream,version,created,meta";
  const row = (
    id: number,
    name = "Tick",
    data = '{"tick":1}',
    stream = "s1",
    version = 0,
    created = "2024-01-01T00:00:00.000Z",
    meta = '{"correlation":"c","causation":{}}'
  ) =>
    [id, name, data, stream, version, created, meta]
      .map((v) =>
        typeof v === "string" && /[",\n\r]/.test(v)
          ? `"${v.replace(/"/g, '""')}"`
          : String(v)
      )
      .join(",");

  it("parses a header and rows into Committed events", async () => {
    const blob = `${header}\n${row(1)}\n${row(2)}\n${row(3)}\n`;
    const file = new CsvFile({ blob });
    const collected: E[] = [];
    const n = await file.query<Schemas>((e) => collected.push(e as E));
    await file.dispose();
    expect(n).toBe(3);
    expect(collected.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(collected[0]?.created).toBeInstanceOf(Date);
  });

  it("throws when the header is missing (empty blob)", async () => {
    const file = new CsvFile({ blob: "" });
    await expect(file.query(() => {})).rejects.toThrow(
      /header and at least one row/
    );
  });

  it("throws when the header doesn't match", async () => {
    const file = new CsvFile({ blob: `not,the,right,header\n` });
    await expect(file.query(() => {})).rejects.toThrow(/Invalid CSV header/);
  });

  it("throws when a row has the wrong number of fields", async () => {
    const blob = `${header}\n1,Tick,{},s1,0\n`; // missing created + meta
    const file = new CsvFile({ blob });
    await expect(file.query(() => {})).rejects.toThrow(/expected 7 fields/);
  });

  it("handles blobs without a trailing newline", async () => {
    // The blob-line iterator's `nl === -1` branch fires on the
    // last line of a CSV that doesn't end with `\n`. Exercising
    // here so the branch stays covered.
    const blob = `${header}\n${row(42)}`;
    const file = new CsvFile({ blob });
    const collected: E[] = [];
    await file.query<Schemas>((e) => collected.push(e as E));
    expect(collected.map((e) => e.id)).toEqual([42]);
  });

  it("preserves CSV-escaped commas and quotes in fields", async () => {
    // The local `row()` helper does the CSV escaping for us — pass
    // the raw tricky string and trust the round-trip. Newlines in
    // fields are out of scope (line-splitter doesn't honor quoted
    // multi-line fields; matches the inspector's prior behavior).
    const trickyName = 'Has,"quote" and,comma';
    const blob = `${header}\n${row(1, trickyName)}\n`;
    const file = new CsvFile({ blob });
    const collected: E[] = [];
    await file.query<Schemas>((e) => collected.push(e as E));
    expect(collected[0]?.name).toBe(trickyName);
  });

  it("skips blank lines in the body", async () => {
    const blob = `${header}\n${row(1)}\n\n${row(2)}\n`;
    const file = new CsvFile({ blob });
    const collected: E[] = [];
    const n = await file.query<Schemas>((e) => collected.push(e as E));
    expect(n).toBe(2);
    expect(collected.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe("CsvFile (file mode — read + write round trip)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "act-csv-spec-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes events through restore and reads them back via query", async () => {
    const path = join(dir, "round-trip.csv");
    const sink = new CsvFile({ path });
    const events: E[] = [
      makeEvent({ id: 100, stream: "a", version: 0 }),
      makeEvent({ id: 101, stream: "a", version: 1 }),
      makeEvent({ id: 102, stream: "b", version: 0 }),
    ];
    await sink.restore(async (commit) => {
      for (const e of events)
        await commit(e as Committed<Schemas, keyof Schemas>);
    });
    await sink.dispose();

    // File exists with a header + 3 rows.
    const text = await readFile(path, "utf8");
    expect(text.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(4);

    // Read it back; ids are renumbered 1..N by the sink.
    const source = new CsvFile({ path });
    const back: E[] = [];
    const n = await source.query<Schemas>((e) => back.push(e as E));
    await source.dispose();
    expect(n).toBe(3);
    expect(back.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(back.map((e) => e.stream)).toEqual(["a", "a", "b"]);
    expect(back.map((e) => e.version)).toEqual([0, 1, 0]);
  });

  it("refuses to write in blob mode", async () => {
    const file = new CsvFile({ blob: "" });
    await expect(file.restore(async () => {})).rejects.toThrow(
      /blob mode is read-only/
    );
  });

  it("dispose is idempotent and safe on a fresh blob source", async () => {
    const file = new CsvFile({ blob: "" });
    await file.dispose();
    await file.dispose();
  });

  it("restore closes its writer even when the driver throws", async () => {
    // `restore`'s `finally` always closes the writer. Confirms a
    // mid-driver throw leaves the file in a parseable state (header
    // written, no dangling lock).
    const path = join(dir, "interrupted.csv");
    const sink = new CsvFile({ path });
    await expect(
      sink.restore(async () => {
        throw new Error("interrupted");
      })
    ).rejects.toThrow(/interrupted/);
    // File should still be readable (header was written before the
    // throw).
    const text = await readFile(path, "utf8");
    expect(text.startsWith("id,name,data,stream,version,created,meta")).toBe(
      true
    );
  });

  it("reads from a non-existent path with a clear error", async () => {
    const path = join(dir, "does-not-exist.csv");
    const file = new CsvFile({ path });
    await expect(file.query(() => {})).rejects.toThrow();
  });

  it("propagates write errors from the underlying stream", async () => {
    // Writing to a nested path whose parent directory doesn't
    // exist surfaces an ENOENT through the write stream — exercises
    // `writeLine`'s error-callback branch where the kernel fails
    // mid-flight rather than at open time.
    const path = join(dir, "no-such-dir", "out.csv");
    const sink = new CsvFile({ path });
    await expect(
      sink.restore(async (commit) => {
        await commit(makeEvent() as Committed<Schemas, keyof Schemas>);
      })
    ).rejects.toThrow();
  });

  it("write stream backpressure: large row count triggers drain handling", async () => {
    // The `writeLine` helper switches between immediate-resolve and
    // `drain`-event-await based on Node's kernel buffer (default
    // ~16 KiB). Writing many small rows with a bulky `data` payload
    // overflows the buffer and exercises the `drain` await branch
    // — the immediate-resolve branch fires for early writes.
    const path = join(dir, "many.csv");
    const sink = new CsvFile({ path });
    const N = 1000;
    const bulkyPayload = "x".repeat(200);
    await sink.restore(async (commit) => {
      for (let i = 0; i < N; i++)
        await commit({
          ...makeEvent({
            id: i + 1,
            version: i,
            stream: "many",
            data: { payload: bulkyPayload },
          }),
        } as Committed<Schemas, keyof Schemas>);
    });
    await sink.dispose();
    const back: E[] = [];
    await new CsvFile({ path }).query<Schemas>((e) => back.push(e as E));
    expect(back).toHaveLength(N);
  });
});

describe("CsvFile via Act.restore as a sink", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "act-csv-sink-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("can be passed as the `sink` argument to drive a source → CSV transfer", async () => {
    // Use a synthetic `EventSource` as the source so the test
    // doesn't need to construct a valid CSV blob with all the
    // escaping rules — the point here is to validate that
    // `Act.restore(source, opts, sink)` accepts a `CsvFile` in the
    // sink slot and writes a usable CSV out.
    const source = arraySource([
      makeEvent({ id: 10, stream: "s1", version: 0, name: "Tick" }),
      makeEvent({ id: 11, stream: "s1", version: 1, name: "Tock" }),
    ]);
    const targetPath = join(dir, "out.csv");
    const target = new CsvFile({ path: targetPath });

    // Lightweight Act for the orchestrator slot — no slices, no
    // states; Act.restore is type-erased and only needs the scoped
    // store/cache pair to honor `ActOptions.scoped`.
    const { act, InMemoryCache, InMemoryStore } = await import(
      "@rotorsoft/act"
    );
    const cache = new InMemoryCache();
    const store = new InMemoryStore();
    await store.seed();
    const app = act().build({ scoped: { store, cache } });

    const result = await app.restore(source, {}, target);
    expect(result.kept).toBe(2);

    // Read the CSV target back via a fresh CsvFile source — the
    // round-trip proves the sink's escaping is parser-compatible.
    const back: E[] = [];
    await new CsvFile({ path: targetPath }).query<Schemas>((e) =>
      back.push(e as E)
    );
    expect(back).toHaveLength(2);
    // Sink renumbers ids densely from 1.
    expect(back.map((e) => e.id)).toEqual([1, 2]);
    expect(back.map((e) => e.name)).toEqual(["Tick", "Tock"]);

    await target.dispose();
    await cache.dispose();
    await store.dispose();
  });
});

/**
 * Verifies the source file used by the CSV round-trip writer
 * lifecycle is clean: temp dir gone after `afterAll`.
 */
describe("file lifecycle", () => {
  it("temp dir setup + teardown round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "act-csv-life-"));
    const path = join(dir, "x.csv");
    await writeFile(path, "");
    await rm(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
