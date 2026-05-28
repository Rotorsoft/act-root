/**
 * @module csv
 *
 * `CsvFile` — a single class implementing both {@link EventSource}
 * and {@link EventSink} so a CSV file on disk can be either side of
 * a transfer pipeline (ACT-1128 / #788).
 *
 * - As a source: streams one row at a time off a line interface;
 *   the awaited per-event callback gives 1-event-in-flight
 *   backpressure on reads.
 * - As a sink: serialized `WriteStream.write` await per row,
 *   propagating I/O errors through the chunk callback.
 *
 * `commit` / `claim` / `subscribe` and the rest of `Store` are NOT
 * implemented — `CsvFile` is a transfer-only primitive, not a
 * store you'd run an Act app against.
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
    if (header === null)
      throw new Error("CSV must have a header and at least one row");
    return count;
  }

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

async function* linesFromBlob(blob: string): AsyncIterable<string> {
  let start = 0;
  while (start < blob.length) {
    const nl = blob.indexOf("\n", start);
    const end = nl === -1 ? blob.length : nl;
    yield blob.slice(start, end);
    start = nl === -1 ? blob.length : nl + 1;
    await Promise.resolve();
  }
}

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

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function writeLine(writer: WriteStream, line: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    writer.write(`${line}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
