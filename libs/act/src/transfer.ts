/**
 * @module transfer
 *
 * Public utilities for the transfer pipeline (ACT-1128 / #788):
 *
 * - {@link iterate} — lift any {@link EventSource} into an
 *   `AsyncIterable<Committed>` with a 1-slot mailbox for true
 *   backpressure. The producer (`EventSource.query`) awaits the
 *   callback per event; the consumer pulls one at a time. Memory in
 *   the bridge is bounded by exactly one event in flight.
 * - {@link CsvFile} — a single class that implements both
 *   {@link EventSource} and {@link EventSink}, so a CSV file on disk
 *   can be a transfer source (read line by line, callback per row)
 *   or a transfer target (write the CSV-encoded events as they
 *   stream through).
 *
 * The pipeline uses these via {@link IAct.restore}:
 *
 * ```typescript
 * const source: EventSource = new CsvFile({ path: "backup.csv" });
 * const sink: EventSink     = store();   // or another CsvFile
 * await app.restore(source, { drop_snapshots: true }, sink);
 * await source.dispose();
 * await sink.dispose();
 * ```
 *
 * Source and sink speak the same interfaces, so any `{ csv, store }`
 * × `{ csv, store }` combination composes the same way — no
 * discriminator branching in the call site.
 */

import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  Committed,
  EventSink,
  EventSource,
  Query,
  Schemas,
} from "./types/action.js";

/**
 * Bridge an {@link EventSource} into an `AsyncIterable<Committed>`
 * with 1-event-in-flight backpressure.
 *
 * The producer (`source.query`) calls our callback per event;
 * each call returns a promise that resolves only when the consumer
 * has taken the event from the mailbox. So the read loop awaits
 * after every event, and memory in this bridge is bounded.
 *
 * The downstream realization of backpressure depends on the
 * adapter's `query` implementation. Today every in-tree adapter
 * still buffers its full result set in memory before calling the
 * callback (e.g., `pg.query` resolves with `rows[]`); the
 * mailbox-on-top of that just adds bounded buffering downstream of
 * the result set. True cursor-based streaming on the adapter side
 * is tracked in #814 (ACT-1132).
 */
export async function* iterate(
  source: EventSource,
  filter?: Query
): AsyncIterable<Committed<Schemas, keyof Schemas>> {
  // Mutable cell shared between the producer callback (running
  // inside `source.query`) and this generator. Wrapping the state
  // in an object prevents TypeScript from narrowing the let-bound
  // `null` initializer through the triple-closure-deep assignment
  // path; concrete behavior is unchanged.
  type WakeFn = () => void;
  const state: {
    slot: Committed<Schemas, keyof Schemas> | null;
    onProduce: WakeFn | null;
    onConsume: WakeFn | null;
    done: boolean;
    error: unknown;
  } = {
    slot: null,
    onProduce: null,
    onConsume: null,
    done: false,
    error: undefined,
  };

  const wakeProduce = () => {
    const fn = state.onProduce;
    state.onProduce = null;
    if (fn) fn();
  };

  // Kick off the read in the background. Each callback parks until
  // the consumer signals the slot is empty; the producer never
  // gets ahead of the consumer by more than one event.
  void source
    .query<Schemas>((event) => {
      state.slot = event;
      wakeProduce();
      return new Promise<void>((resolve) => {
        state.onConsume = () => resolve();
      });
    }, filter)
    .then(
      () => {
        state.done = true;
        wakeProduce();
      },
      (err) => {
        state.error = err;
        state.done = true;
        wakeProduce();
      }
    );

  while (true) {
    if (state.slot === null && !state.done)
      await new Promise<void>((resolve) => {
        state.onProduce = resolve;
      });
    if (state.error) throw state.error;
    if (state.slot === null) return;
    const event = state.slot;
    state.slot = null;
    // `onConsume` is guaranteed set by the producer's callback —
    // the Promise constructor runs synchronously, so by the time
    // the producer's returned promise is being awaited (and the
    // consumer reaches here), `onConsume` is the resolve fn.
    const fn = state.onConsume!;
    state.onConsume = null;
    fn();
    yield event;
  }
}

/**
 * Construct a {@link CsvFile} from either a filesystem path (for
 * reading and/or writing through the OS) or an in-memory blob (a
 * pre-loaded CSV string, used by the inspector when a CSV arrives
 * over the wire via tRPC).
 *
 * Both modes share the same on-disk format, so the same blob shape
 * can be round-tripped through the transfer pipeline.
 */
export type CsvFileOptions = { path: string } | { blob: string };

/**
 * Same column order as the inspector's backup endpoint, kept here
 * so `CsvFile` is round-trip-compatible with existing backups.
 */
const CSV_COLUMNS = [
  "id",
  "name",
  "data",
  "stream",
  "version",
  "created",
  "meta",
] as const;

/**
 * CSV-backed adapter that implements both {@link EventSource} and
 * {@link EventSink} (and {@link Disposable}). One class, two
 * interfaces — a single file slot is the source you read from or
 * the target you write into, never both at once.
 *
 * Reading streams one row at a time off a line interface, which
 * gives natural backpressure when the consumer is an `await`-ing
 * callback. Writing appends rows to a write stream and closes on
 * completion.
 *
 * `commit` / `claim` / `subscribe` and the rest of `Store` are NOT
 * implemented — `CsvFile` is intentionally a transfer-only
 * primitive, not a Store you'd run an Act app against.
 */
export class CsvFile implements EventSource, EventSink {
  private readonly path: string | null;
  private readonly blob: string | null;

  constructor(options: CsvFileOptions) {
    if ("path" in options) {
      this.path = options.path;
      this.blob = null;
    } else {
      this.path = null;
      this.blob = options.blob;
    }
  }

  /**
   * Read events from the file (or in-memory blob) and push each one
   * through `callback`. The line iterator is naturally async — the
   * event loop ticks between lines — so `await Promise.resolve(callback(...))`
   * actually yields to the consumer, giving 1-event-in-flight
   * backpressure on the read side.
   */
  async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    _filter?: Query
  ): Promise<number> {
    const lines =
      this.blob !== null ? linesFromBlob(this.blob) : linesFromFile(this.path!);
    let count = 0;
    let header: readonly string[] | null = null;
    for await (const line of lines) {
      if (!line.trim()) continue;
      const fields = parseCsvLine(line);
      if (!header) {
        header = fields;
        const expected = CSV_COLUMNS.join(",");
        if (header.join(",") !== expected)
          throw new Error(`Invalid CSV header. Expected: ${expected}`);
        continue;
      }
      if (fields.length !== CSV_COLUMNS.length)
        throw new Error(
          `Row ${count + 1}: expected ${CSV_COLUMNS.length} fields, got ${fields.length}`
        );
      const event: Committed<E, keyof E> = {
        id: Number.parseInt(fields[0]!, 10),
        name: fields[1]! as keyof E,
        data: JSON.parse(fields[2]!),
        stream: fields[3]!,
        version: Number.parseInt(fields[4]!, 10),
        created: new Date(fields[5]!),
        meta: JSON.parse(fields[6]!),
      };
      await Promise.resolve(callback(event));
      count++;
    }
    // Empty file/blob is malformed — distinguishes "we never saw a
    // header" from "we saw a header but no rows" (the latter is a
    // valid zero-event restore). Matches the inspector's prior
    // `parseCsvRows` contract that this class replaces.
    if (header === null)
      throw new Error("CSV must have a header and at least one row");
    return count;
  }

  /**
   * Open the file for writing, hand the orchestrator a per-event
   * `callback` that appends one CSV row per event, then close on
   * completion or rollback. The driver pattern matches
   * {@link Store.restore} — `Act.restore` can wire this exactly the
   * same way it wires a database sink.
   *
   * "Renumbered id" here means: the orchestrator assigns row-order
   * ids (1, 2, 3...) and returns them from the callback so the
   * scan's causation remap stays consistent. The CSV itself stores
   * those new ids so round-tripping reconstructs the same id space.
   */
  async restore(
    driver: (
      callback: (event: Committed<Schemas, keyof Schemas>) => Promise<number>
    ) => Promise<void>
  ): Promise<void> {
    if (this.path === null)
      throw new Error(
        "CsvFile in blob mode is read-only — provide `path` to write"
      );
    const writer = createWriteStream(this.path, {
      flags: "w",
      encoding: "utf8",
    });
    let nextId = 1;
    try {
      await writeLine(writer, CSV_COLUMNS.join(","));
      await driver(async (event) => {
        const id = nextId++;
        const row = [
          String(id),
          csvEscape(event.name as string),
          csvEscape(JSON.stringify(event.data)),
          csvEscape(event.stream),
          String(event.version),
          event.created.toISOString(),
          csvEscape(JSON.stringify(event.meta)),
        ].join(",");
        await writeLine(writer, row);
        return id;
      });
    } finally {
      await new Promise<void>((resolve) => writer.end(resolve));
    }
  }

  async dispose(): Promise<void> {
    // No-op: `restore` always closes its writer in a `finally`, and
    // blob mode never opens one. The Disposable contract is here to
    // make `CsvFile` interchangeable with `Store` in transfer
    // pipelines, not because the file handle outlives the call.
  }
}

/**
 * Async line iterator over an on-disk file. Yields one CSV line at
 * a time — `for await` ticks the event loop between lines, which is
 * what lets the per-event callback's awaited promise actually
 * backpressure the read side.
 */
async function* linesFromFile(path: string): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    stream.close();
  }
}

/**
 * Same async-iterable shape as {@link linesFromFile} but driven off
 * an in-memory string. Awaits between yields so the consumer's
 * awaited callback can interleave — same backpressure profile as
 * the file path.
 */
async function* linesFromBlob(blob: string): AsyncIterable<string> {
  let start = 0;
  while (start < blob.length) {
    const nl = blob.indexOf("\n", start);
    const end = nl === -1 ? blob.length : nl;
    yield blob.slice(start, end);
    start = nl === -1 ? blob.length : nl + 1;
    // Yield to the event loop between lines so the consumer's
    // awaited callback gets a chance to drain the mailbox.
    await Promise.resolve();
  }
}

/**
 * RFC 4180-style CSV line parser — handles double-quoted fields
 * with embedded commas, escaped quotes (`""`), and CRLF line
 * endings. Mirrors the inspector's existing parser so backups from
 * either path round-trip cleanly.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let value = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          value += line[i++];
        }
      }
      fields.push(value);
      if (line[i] === ",") i++;
    } else {
      const next = line.indexOf(",", i);
      if (next === -1) {
        fields.push(line.slice(i));
        i = line.length;
      } else {
        fields.push(line.slice(i, next));
        i = next + 1;
      }
    }
  }
  return fields;
}

/**
 * Escape a field for the CSV output: wrap in double-quotes when it
 * contains commas, quotes, or newlines; double up internal quotes.
 */
function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Promise-shaped wrapper around `WriteStream.write` that awaits the
 * per-chunk callback. Awaiting the callback (rather than checking
 * the sync return value of `write`) gives us two things in one
 * primitive: errors propagate via `reject(err)` reliably (a
 * resolve-immediately-on-truthy-return path would discard them),
 * and serializing writes naturally backpressures the producer —
 * each call awaits the previous chunk's completion before issuing
 * the next, so there's no buffer growth regardless of how fast the
 * upstream events arrive.
 */
function writeLine(writer: WriteStream, line: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    writer.write(`${line}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
