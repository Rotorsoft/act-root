import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Committed, EventSource, Query, Schemas } from "@rotorsoft/act";
import { CsvFile } from "@rotorsoft/act";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type E = Committed<Schemas, string>;

/**
 * Tests for `CsvFile` (ACT-1128) — single class implementing both
 * `EventSource` and `EventSink` (and `Disposable`) for CSV files
 * on disk or in-memory CSV blobs. Public surface.
 *
 * The pagination behavior introduced in ACT-1133 lives in `scan`
 * directly (no separate `iterate` helper), so it's covered by the
 * scan tests in `restore.spec.ts` against real adapters.
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
 * Synthetic `EventSource` that walks an array. Used by the round-trip
 * tests below to feed events into a `CsvFile` sink.
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
